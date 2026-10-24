// /api/shift/: a caller clocks a shift from the Hub, the owner reads it, the gate follows it.
// ------------------------------------------------------------------
// The real handler, the real auth path, the real activity handler, and an in-memory Redis
// answering the REST calls the @upstash/redis client makes, SET NX included.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KV_REST_API_URL = 'https://example.invalid';
process.env.KV_REST_API_TOKEN = 'test';
process.env.ADMIN_TOKEN = 'test-admin';
const shiftHandler = (await import('../api/shift.js')).default;
const activityHandler = (await import('../api/activity.js')).default;
const { SESSION_TTL } = await import('../api/_auth.js');

const store = new Map(), ttls = new Map();
const run = cmd => {
    const [verb, key, ...args] = cmd; const v = String(verb).toUpperCase();
    const str = x => (typeof x === 'string' ? x : JSON.stringify(x));
    const flags = args.slice(1).map(a => String(a).toUpperCase());
    if (v === 'GET') return store.has(key) ? store.get(key) : null;
    if (v === 'SET') { if (flags.includes('NX') && store.has(key)) return null; store.set(key, str(args[0])); const i = flags.findIndex(a => a === 'EX' || a === 'PX'); if (i >= 0) ttls.set(key, Number(args[i + 2])); return 'OK'; }
    if (v === 'DEL') { let n = 0; for (const k of [key, ...args]) n += store.delete(k) ? 1 : 0; return n; }
    if (v === 'EXPIRE') { ttls.set(key, Number(args[0])); return 1; }
    if (v === 'TTL') { return ttls.has(key) ? ttls.get(key) : -1; }
    if (v === 'SADD') { const s = store.get(key) instanceof Set ? store.get(key) : new Set(); for (const a of args) s.add(String(a)); store.set(key, s); return 1; }
    if (v === 'SMEMBERS') { const s = store.get(key); return s instanceof Set ? [...s] : []; }
    if (v === 'LPUSH') { const l = Array.isArray(store.get(key)) ? store.get(key) : []; store.set(key, [...args.map(str).reverse(), ...l]); return store.get(key).length; }
    if (v === 'LTRIM') { const l = Array.isArray(store.get(key)) ? store.get(key) : []; store.set(key, l.slice(Number(args[0]), Number(args[1]) + 1)); return 'OK'; }
    if (v === 'LRANGE') { const l = Array.isArray(store.get(key)) ? store.get(key) : []; const end = Number(args[1]); return l.slice(Number(args[0]), end < 0 ? undefined : end + 1); }
    if (v === 'HGET') { const h = store.get(key); return h && typeof h === 'object' && !(h instanceof Set) && !Array.isArray(h) && args[0] in h ? h[args[0]] : null; }
    if (v === 'HGETALL') { const h = store.get(key); return h && typeof h === 'object' && !(h instanceof Set) && !Array.isArray(h) ? Object.entries(h).flat() : []; }
    if (v === 'HSET') { const h = store.get(key) || {}; for (let i = 0; i < args.length; i += 2) h[args[i]] = args[i + 1]; store.set(key, h); return 1; }
    if (v === 'SCAN') { const i = args.findIndex(a => String(a).toUpperCase() === 'MATCH'); const pat = i >= 0 ? String(args[i + 1]).replace('*', '') : ''; return ['0', [...store.keys()].filter(k => k.startsWith(pat))]; }
    throw new Error('unhandled ' + v);
};
const b64 = v => (typeof v === 'string' ? Buffer.from(v).toString('base64') : Array.isArray(v) ? v.map(b64) : v);
globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.host !== 'example.invalid') return { ok: false, status: 404, text: async () => '' };
    const batch = JSON.parse(opts?.body || '[]');
    const payload = Array.isArray(batch[0]) ? batch.map(c => ({ result: b64(run(c)) })) : { result: b64(run(batch)) };
    const text = JSON.stringify(payload);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => payload };
};
const MILTON = 'miltion@trystaffify.com';
const seed = () => {
    store.clear(); ttls.clear();
    store.set('sess:milton-sid', MILTON); ttls.set('sess:milton-sid', SESSION_TTL - 3600);
    store.set('sess:paul-sid', 'hello@gostaffify.com'); ttls.set('sess:paul-sid', SESSION_TTL - 7200);
    store.set('rep:' + MILTON, { email: MILTON, name: 'Milton', role: 'rep' });          // his real record: rep, not caller
    store.set('rep:hello@gostaffify.com', { email: 'hello@gostaffify.com', name: 'Paul', role: 'admin' });
    store.set('reps', new Set([MILTON, 'hello@gostaffify.com']));
};
const invoke = handler => async ({ method = 'GET', cookie = null, bearer = null, query = {}, body = null }) => {
    let code = 200, out = null;
    const res = { setHeader() {}, status(n) { code = n; return this; }, json(v) { out = v; return v; } };
    await handler({ method, headers: { ...(cookie ? { cookie: 'sfy_sess=' + cookie } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, query, body: body ? JSON.stringify(body) : undefined }, res);
    return { code, body: out };
};
const call = invoke(shiftHandler), activity = invoke(activityHandler);
const realNow = Date.now;
const at = iso => { Date.now = () => Date.parse(iso); };
const post = (cookie, body) => call({ method: 'POST', cookie, body });

test('a caller clocks a shift: start, a second tab refused, break, resume, end; the gate and the report follow', async () => {
    seed();
    at('2026-10-23T20:00:00Z'); let r = await call({ cookie: 'milton-sid', query: { me: '1' } });
    assert.equal(r.code, 200); assert.equal(r.body.required, true, 'Milton has no owner lane, so he is gated'); assert.equal(r.body.state, 'off'); assert.equal(r.body.gate.allowed, false); assert.equal(r.body.gate.message, 'Start your shift to call.'); assert.equal(r.body.shift, null);
    at('2026-10-23T20:00:05Z'); r = await post('milton-sid', { action: 'start', page: '/dialer/' });
    assert.equal(r.code, 200); assert.equal(r.body.state, 'on'); assert.equal(r.body.gate.allowed, true); assert.equal(r.body.shift.startedAt, '2026-10-23T20:00:05.000Z'); assert.equal(r.body.shift.startedOn, '/dialer/'); assert.equal(r.body.today.list.length, 1); assert.equal(r.body.today.list[0].state, 'open');
    const id = r.body.shift.id;
    at('2026-10-23T20:00:30Z'); r = await post('milton-sid', { action: 'start' });
    assert.equal(r.code, 409); assert.equal(r.body.reason, 'already_on_shift'); assert.equal(r.body.shift.id, id, 'the other tab is told which shift is already running');
    at('2026-10-23T20:30:00Z'); r = await post('milton-sid', { action: 'break' });
    assert.equal(r.code, 200); assert.equal(r.body.state, 'break'); assert.equal(r.body.gate.allowed, false); assert.equal(r.body.gate.reason, 'break');
    assert.equal((await post('milton-sid', { action: 'break' })).code, 409);
    at('2026-10-23T20:40:00Z'); r = await post('milton-sid', { action: 'resume' });
    assert.equal(r.body.state, 'on'); assert.equal(r.body.shift.breakMinutes, 10); assert.equal(r.body.shift.clockedMinutes, 30);
    at('2026-10-23T21:00:00Z'); r = await post('milton-sid', { action: 'end' });
    assert.equal(r.code, 200); assert.equal(r.body.state, 'off'); assert.equal(r.body.shift, null); assert.equal(r.body.ended.status, 'closed'); assert.equal(r.body.ended.clockedMinutes, 50);
    assert.equal(r.body.today.clockedMinutes, 50); assert.equal(r.body.today.list[0].state, 'closed'); assert.equal(r.body.gate.allowed, false, 'ended: calls are off again');
    assert.equal((await post('milton-sid', { action: 'end' })).code, 409);
    // What the owner reads, next to the observed activity for the same day.
    const w = await activity({ cookie: 'paul-sid', query: { user: MILTON, from: '2026-10-23', to: '2026-10-23' } });
    assert.equal(w.code, 200);
    const d = w.body.days[0];
    assert.equal(d.shift.clockedMinutes, 50); assert.equal(d.shift.breakMinutes, 10); assert.equal(d.shift.list[0].id, id); assert.equal(d.shift.list[0].endedAt, '2026-10-23T21:00:00.000Z');
    assert.equal(w.body.totals.clockedMinutes, 50); assert.equal(w.body.totals.shifts, 1); assert.equal(w.body.totals.shiftsNeedingReview, 0);
    assert.equal(d.counts.shift_start, 1); assert.equal(d.counts.shift_break, 1); assert.equal(d.counts.shift_resume, 1); assert.equal(d.counts.shift_end, 1);
    assert.equal(d.meaningful, 0, 'shift presses are presence, not work actions');
    assert.ok(d.activeMinutes >= 1, 'the presses count as presence minutes');
    assert.ok(w.body.definitions.declared.some(t => /never deducted/.test(t)));
    const roster = await activity({ cookie: 'paul-sid', query: { users: '1', from: '2026-10-23', to: '2026-10-23' } });
    const row = roster.body.users.find(u => u.email === MILTON);
    assert.equal(row.totals.clockedMinutes, 50); assert.equal(row.days[0].clockedMinutes, 50);
    const mine = await activity({ cookie: 'milton-sid', query: { me: '1', from: '2026-10-23', to: '2026-10-23' } });
    assert.equal(mine.body.days[0].shift.clockedMinutes, 50, 'the rep reads his own');
    Date.now = realNow;
});

test('a forgotten shift: stale after twelve hours, archived without an end when Start is pressed, corrected by an owner with a note', async () => {
    seed();
    at('2026-10-24T00:00:00Z'); assert.equal((await post('milton-sid', { action: 'start' })).code, 200);   // 8 pm ET on the 23rd
    at('2026-10-24T13:00:00Z'); let r = await call({ cookie: 'milton-sid', query: { me: '1' } });
    assert.equal(r.body.state, 'stale'); assert.equal(r.body.gate.allowed, false); assert.match(r.body.gate.message, /more than 12 hours/);
    r = await post('milton-sid', { action: 'break' }); assert.equal(r.code, 409); assert.equal(r.body.reason, 'shift_too_long');
    r = await post('milton-sid', { action: 'start' });
    assert.equal(r.code, 200); assert.equal(r.body.state, 'on'); assert.equal(r.body.archived.endedAt, null, 'no end time was invented'); assert.deepEqual(r.body.archived.flags, ['open_over_12h', 'never_ended']); assert.equal(r.body.archived.day, '2026-10-23');
    const oldId = r.body.archived.id;
    let w = await activity({ cookie: 'paul-sid', query: { user: MILTON, from: '2026-10-23', to: '2026-10-24' } });
    const d23 = w.body.days.find(d => d.day === '2026-10-23'), d24 = w.body.days.find(d => d.day === '2026-10-24');
    assert.equal(d23.shift.needsReview, 1); assert.equal(d23.shift.clockedMinutes, 0, 'nothing counted until reviewed'); assert.equal(d23.shift.list[0].state, 'needs_review');
    assert.equal(d24.shift.open, 1); assert.equal(w.body.totals.shiftsNeedingReview, 1); assert.equal(d24.counts.shift_flagged, 1);
    // Only an owner corrects, only with a note, only shorter.
    const fix = (cookie, over) => post(cookie, { action: 'correct', user: MILTON, day: '2026-10-23', shiftId: oldId, endedAt: '2026-10-24T02:00:00Z', note: 'Milton said he stopped at 10 pm', ...over });
    assert.equal((await fix('milton-sid', {})).code, 403);
    r = await fix('paul-sid', { note: '' }); assert.equal(r.code, 400); assert.equal(r.body.reason, 'note_required');
    r = await fix('paul-sid', { endedAt: '2026-10-24T14:00:00Z' }); assert.equal(r.code, 400); assert.equal(r.body.reason, 'cannot_lengthen');
    r = await fix('paul-sid', { shiftId: 'sh-nope' }); assert.equal(r.code, 404);
    r = await fix('paul-sid', { shiftId: '../../etc' }); assert.equal(r.code, 400, 'a shift id is checked before it touches a key');
    r = await call({ method: 'POST', bearer: 'test-admin', body: { action: 'correct', user: MILTON, day: '2026-10-23', shiftId: oldId, endedAt: '2026-10-24T02:00:00Z', note: 'x' } });
    assert.equal(r.code, 403, 'the shared admin token cannot correct: a correction names a person');
    at('2026-10-24T15:00:00Z'); r = await fix('paul-sid', {});
    assert.equal(r.code, 200); assert.equal(r.body.shift.status, 'corrected'); assert.equal(r.body.shift.clockedMinutes, 120); assert.equal(r.body.shift.corrections[0].by, 'hello@gostaffify.com'); assert.equal(r.body.shift.corrections[0].from, null);
    w = await activity({ cookie: 'paul-sid', query: { user: MILTON, from: '2026-10-23', to: '2026-10-24' } });
    assert.equal(w.body.days[0].shift.clockedMinutes, 120); assert.equal(w.body.days[0].shift.needsReview, 0); assert.equal(w.body.days[0].shift.list[0].endedAt, null, 'the original still has no end'); assert.equal(w.body.days[0].shift.list[0].correctedEndedAt, '2026-10-24T02:00:00.000Z');
    assert.equal(w.body.days[1].counts.shift_corrected, 1, 'the correction is an event on the day it was made, on the rep\'s own log');
    assert.match(w.body.days[1].events.find(e => e.kind === 'shift_corrected').detail, /by hello@gostaffify.com: Milton said he stopped at 10 pm/);
    const minutes = store.get('act:min:' + MILTON + ':2026-10-24');
    assert.ok(!minutes || !minutes.has(String(11 * 60)), 'the owner\'s correction at 11:00 ET is not counted as Milton\'s presence');
    const w2 = await activity({ cookie: 'paul-sid', query: { user: MILTON, from: '2026-10-19', to: '2026-10-23' } });
    assert.equal(w2.body.openShiftOutsideRange, null, 'a healthy running shift outside the range is not news');
    Date.now = realNow;
});

test('boundaries: the admin token holds no shift; owners are not gated; a held lock answers busy; tokens never leak', async () => {
    seed(); at('2026-10-23T20:00:00Z');
    assert.equal((await call({ bearer: 'test-admin', query: { me: '1' } })).code, 400);
    assert.equal((await call({ method: 'POST', bearer: 'test-admin', body: { action: 'start' } })).code, 403);
    assert.equal((await call({ query: { me: '1' } })).code, 401);
    const p = await call({ cookie: 'paul-sid', query: { me: '1' } });
    assert.equal(p.body.required, false); assert.equal(p.body.gate.allowed, true); assert.equal(p.body.state, 'off');
    assert.equal((await post('paul-sid', { action: 'start' })).code, 200, 'an owner may still clock a shift; it is simply not required of them');
    store.set('shift:lock:' + MILTON, '1');
    const busy = await post('milton-sid', { action: 'start' }); assert.equal(busy.code, 409); assert.equal(busy.body.reason, 'busy');
    store.delete('shift:lock:' + MILTON);
    assert.equal((await post('milton-sid', { action: 'dance' })).code, 400);
    assert.equal((await post('paul-sid', { action: 'correct', user: MILTON, day: 'today', shiftId: 'x', endedAt: '2026-10-23T20:00:00Z', note: 'x' })).code, 400);
    assert.ok(!JSON.stringify((await call({ cookie: 'milton-sid', query: { me: '1' } })).body).includes('milton-sid'));
    Date.now = realNow;
});

test('an owner closes a forgotten shift that is still running past twelve hours; a healthy running shift is the rep\'s alone', async () => {
    seed();
    at('2026-10-23T22:00:00Z'); const started = await post('milton-sid', { action: 'start' });
    const id = started.body.shift.id;
    const fix = over => post('paul-sid', { action: 'correct', user: MILTON, day: '2026-10-23', shiftId: id, endedAt: '2026-10-24T01:30:00Z', note: 'Stopped at 9:30, forgot End', ...over });
    at('2026-10-24T02:00:00Z'); let r = await fix({ endedAt: '2026-10-23T23:00:00Z' });
    assert.equal(r.code, 409); assert.equal(r.body.reason, 'still_running', 'four hours in: only Milton can end it');
    at('2026-10-24T11:00:00Z'); r = await fix({});
    assert.equal(r.code, 200); assert.equal(r.body.archivedFromCurrent, true);
    assert.equal(r.body.shift.endedAt, null, 'no end was invented'); assert.equal(r.body.shift.archivedBy, 'hello@gostaffify.com'); assert.equal(r.body.shift.correctedEndedAt, '2026-10-24T01:30:00.000Z'); assert.equal(r.body.shift.clockedMinutes, 210);
    const me = await call({ cookie: 'milton-sid', query: { me: '1' } });
    assert.equal(me.body.state, 'off', 'the current slot is clear; Milton starts fresh'); assert.equal(me.body.gate.allowed, false);
    const w = await activity({ cookie: 'paul-sid', query: { user: MILTON, from: '2026-10-23', to: '2026-10-23' } });
    assert.equal(w.body.days[0].shift.clockedMinutes, 210); assert.equal(w.body.days[0].shift.shifts, 1, 'stored once');
    Date.now = realNow;
});

test('a ghost: the log says ended but the current slot was never cleared; it reads as off, allows nothing, and is cleared', async () => {
    seed();
    at('2026-10-23T20:00:00Z'); const s = await post('milton-sid', { action: 'start' });
    const doc = JSON.parse(store.get('shift:cur:' + MILTON));
    store.set('shift:log2:' + MILTON + ':2026-10-23', { [doc.id]: JSON.stringify({ ...doc, endedAt: '2026-10-23T21:00:00.000Z', status: 'closed' }) });
    at('2026-10-23T21:05:00Z'); const me = await call({ cookie: 'milton-sid', query: { me: '1' } });
    assert.equal(me.body.state, 'off'); assert.equal(me.body.gate.allowed, false); assert.equal(store.has('shift:cur:' + MILTON), false, 'the ghost is cleared');
    assert.equal(me.body.today.shifts, 1, 'and the shift counts once'); assert.equal(me.body.today.clockedMinutes, 60);
    assert.equal((await post('milton-sid', { action: 'end' })).code, 409, 'it cannot be ended twice');
    assert.ok(s.body.shift.id === doc.id);
    Date.now = realNow;
});

test('an unreadable store is unavailable, never zero', async () => {
    seed(); at('2026-10-23T20:00:00Z');
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts) => { const b = JSON.parse(opts?.body || '[]'); const verbs = Array.isArray(b[0]) ? b.map(c => String(c[0]).toUpperCase()) : [String(b[0]).toUpperCase()]; const keys = Array.isArray(b[0]) ? b.map(c => String(c[1])) : [String(b[1])]; if (keys.some(k => k.startsWith('shift:'))) throw new Error('store down'); return real(url, opts); };
    try {
        const me = await call({ cookie: 'milton-sid', query: { me: '1' } });
        assert.equal(me.code, 503, 'the bar is not told "off" when the truth is unknown');
        const w = await activity({ cookie: 'paul-sid', query: { user: MILTON, from: '2026-10-23', to: '2026-10-23' } });
        assert.equal(w.code, 200); assert.equal(w.body.days[0].shift.unavailable, true); assert.equal(w.body.totals.shiftDaysUnavailable, 1); assert.equal(w.body.totals.clockedMinutes, 0);
        assert.equal(w.body.days[0].shift.list.length, 0);
    } finally { globalThis.fetch = real; Date.now = realNow; }
});
