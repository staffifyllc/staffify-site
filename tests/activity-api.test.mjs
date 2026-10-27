// /api/activity/: heartbeats land once per minute, sessions open and close, and nobody reads
// another rep's activity without being an owner.
// ------------------------------------------------------------------
// The real handler, the real auth path, and an in-memory Redis answering the REST calls the
// @upstash/redis client makes, so the test exercises exactly what production does.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KV_REST_API_URL = 'https://example.invalid';
process.env.KV_REST_API_TOKEN = 'test';
process.env.ADMIN_TOKEN = 'test-admin';
const handler = (await import('../api/activity.js')).default;
const { SESSION_TTL } = await import('../api/_auth.js');

// ---- a small Redis ---------------------------------------------------------------------------
const store = new Map(), ttls = new Map();
const run = cmd => {
    const [verb, key, ...args] = cmd; const v = String(verb).toUpperCase();
    const str = x => (typeof x === 'string' ? x : JSON.stringify(x));
    if (v === 'GET') return store.has(key) ? store.get(key) : null;
    if (v === 'SET') { store.set(key, str(args[0])); const i = args.findIndex(a => String(a).toUpperCase() === 'EX'); if (i >= 0) ttls.set(key, Number(args[i + 1])); return 'OK'; }
    if (v === 'DEL') { store.delete(key); return 1; }
    if (v === 'EXPIRE') { ttls.set(key, Number(args[0])); return 1; }
    if (v === 'TTL') { return ttls.has(key) ? ttls.get(key) : -1; }
    if (v === 'SADD') { const s = store.get(key) instanceof Set ? store.get(key) : new Set(); for (const a of args) s.add(String(a)); store.set(key, s); return 1; }
    if (v === 'SMEMBERS') { const s = store.get(key); return s instanceof Set ? [...s] : []; }
    if (v === 'LPUSH') { const l = Array.isArray(store.get(key)) ? store.get(key) : []; store.set(key, [...args.map(str).reverse(), ...l]); return store.get(key).length; }
    if (v === 'LTRIM') { const l = Array.isArray(store.get(key)) ? store.get(key) : []; store.set(key, l.slice(Number(args[0]), Number(args[1]) + 1)); return 'OK'; }
    if (v === 'LRANGE') { const l = Array.isArray(store.get(key)) ? store.get(key) : []; const end = Number(args[1]); return l.slice(Number(args[0]), end < 0 ? undefined : end + 1); }
    if (v === 'HGETALL') { const h = store.get(key); return h && typeof h === 'object' && !(h instanceof Set) && !Array.isArray(h) ? Object.entries(h).flat() : []; }
    if (v === 'HGET') { const h = store.get(key); return h && typeof h === 'object' && !(h instanceof Set) && args[0] in h ? h[args[0]] : null; }
    if (v === 'HSET') { const h = store.get(key) || {}; for (let i = 0; i < args.length; i += 2) h[args[i]] = args[i + 1]; store.set(key, h); return 1; }
    if (v === 'SCAN') { const i = args.findIndex(a => String(a).toUpperCase() === 'MATCH'); const pat = i >= 0 ? String(args[i + 1]).replace('*', '') : ''; return ['0', [...store.keys()].filter(k => k.startsWith(pat))]; }
    throw new Error('unhandled ' + v);
};
// The client asks for base64-encoded results and decodes every string it gets back, so the
// stub encodes what it returns, nested arrays included.
const b64 = v => (typeof v === 'string' ? Buffer.from(v).toString('base64') : Array.isArray(v) ? v.map(b64) : v);
globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.host !== 'example.invalid') return { ok: false, status: 404, text: async () => '' };
    const batch = JSON.parse(opts?.body || '[]');
    const payload = Array.isArray(batch[0]) ? batch.map(c => ({ result: b64(run(c)) })) : { result: b64(run(batch)) };
    const text = JSON.stringify(payload);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => payload };
};
const seed = () => {
    store.clear(); ttls.clear();
    store.set('sess:milton-sid', 'miltion@trystaffify.com'); ttls.set('sess:milton-sid', SESSION_TTL - 3600);
    store.set('sess:paul-sid', 'hello@gostaffify.com'); ttls.set('sess:paul-sid', SESSION_TTL - 7200);
    store.set('rep:miltion@trystaffify.com', { email: 'miltion@trystaffify.com', name: 'Milton', role: 'caller' });
    store.set('rep:hello@gostaffify.com', { email: 'hello@gostaffify.com', name: 'Paul', role: 'admin' });
    store.set('reps', new Set(['miltion@trystaffify.com', 'hello@gostaffify.com']));
};
const call = async ({ method = 'GET', cookie = null, bearer = null, query = {}, body = null }) => {
    let code = 200, out = null;
    const res = { setHeader() {}, status(n) { code = n; return this; }, json(v) { out = v; return v; } };
    await handler({ method, headers: { ...(cookie ? { cookie: 'sfy_sess=' + cookie } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, query, body: body ? JSON.stringify(body) : undefined }, res);
    return { code, body: out };
};
const realNow = Date.now;
const at = iso => { Date.now = () => Date.parse(iso); };

test('heartbeats from two tabs in one minute count one minute; a long gap starts a new session', async () => {
    seed();
    at('2026-10-23T20:00:10Z'); let r = await call({ method: 'POST', cookie: 'milton-sid', body: { action: 'heartbeat', page: '/dialer/' } });
    assert.equal(r.code, 200); assert.equal(r.body.sessionStarted, true); assert.equal(r.body.day, '2026-10-23');
    at('2026-10-23T20:00:40Z'); r = await call({ method: 'POST', cookie: 'milton-sid', body: { action: 'heartbeat', page: '/my-day/' } });
    assert.equal(r.body.sessionStarted, false);
    at('2026-10-23T20:01:05Z'); await call({ method: 'POST', cookie: 'milton-sid', body: { action: 'heartbeat', page: '/dialer/' } });
    at('2026-10-23T20:45:00Z'); r = await call({ method: 'POST', cookie: 'milton-sid', body: { action: 'heartbeat', page: '/dialer/' } });
    assert.equal(r.body.sessionStarted, true, 'thirty quiet minutes closed the first session');
    at('2026-10-23T20:46:00Z'); const me = await call({ cookie: 'milton-sid', query: { me: '1', from: '2026-10-19', to: '2026-10-23' } });
    assert.equal(me.code, 200);
    const today = me.body.days.find(d => d.day === '2026-10-23');
    assert.equal(today.activeMinutes, 3, '20:00, 20:01 and 20:45: three distinct minutes');
    assert.equal(today.sessions, 2); assert.equal(today.sessionList[0].reason, 'timeout'); assert.equal(today.sessionList[1].reason, 'open');
    assert.equal(today.elapsedMinutes, 1, 'first session 20:00:10 to 20:01:05, second has no span yet');
    assert.equal(me.body.days.find(d => d.day === '2026-10-19').measured, false, 'an unmeasured day says so');
    assert.equal(me.body.totals.measuredDays, 1);
    assert.ok(me.body.definitions.measured.some(t => /not payroll/.test(t)));
    Date.now = realNow;
});

test('leave closes the session; only page_view and leave are accepted from the browser', async () => {
    seed();
    at('2026-10-23T21:00:00Z'); await call({ method: 'POST', cookie: 'milton-sid', body: { action: 'event', kind: 'page_view', page: '/dialer/' } });
    at('2026-10-23T21:03:00Z'); const left = await call({ method: 'POST', cookie: 'milton-sid', body: { action: 'event', kind: 'leave', page: '/dialer/' } });
    assert.equal(left.body.ended, true);
    const forged = await call({ method: 'POST', cookie: 'milton-sid', body: { action: 'event', kind: 'call_outcome', page: '/dialer/' } });
    assert.equal(forged.code, 400, 'a business event cannot be posted from the page');
    at('2026-10-23T21:04:00Z'); const me = await call({ cookie: 'milton-sid', query: { me: '1', from: '2026-10-23', to: '2026-10-23' } });
    const d = me.body.days[0];
    assert.equal(d.sessionList.length, 1); assert.equal(d.sessionList[0].reason, 'left'); assert.equal(d.elapsedMinutes, 3);
    assert.deepEqual(d.counts, { page_view: 1, leave: 1 }); assert.equal(d.meaningful, 0);
    Date.now = realNow;
});

test('the idle prompt is recorded from the page, and being prompted never counts as an active minute', async () => {
    seed();
    at('2026-10-23T21:00:00Z'); await call({ method: 'POST', cookie: 'milton-sid', body: { action: 'event', kind: 'page_view', page: '/dialer/' } });
    for (const [t, kind] of [['2026-10-23T21:12:00Z', 'idle_prompt'], ['2026-10-23T21:13:00Z', 'idle_prompt_on_call'], ['2026-10-23T21:25:00Z', 'idle_prompt'], ['2026-10-23T21:26:00Z', 'idle_prompt_break']]) {
        at(t); const r = await call({ method: 'POST', cookie: 'milton-sid', body: { action: 'event', kind, page: '/dialer/' } });
        assert.equal(r.code, 200, kind);
    }
    at('2026-10-23T21:30:00Z'); const me = await call({ cookie: 'milton-sid', query: { me: '1', from: '2026-10-23', to: '2026-10-23' } });
    const d = me.body.days[0];
    assert.equal(d.activeMinutes, 1, 'only the page view counted a minute');
    assert.deepEqual(d.counts, { page_view: 1, idle_prompt: 2, idle_prompt_on_call: 1, idle_prompt_break: 1 });
    assert.ok(d.events.some(e => e.label === 'Prompted after 10 quiet minutes on shift'));
    Date.now = realNow;
});

test('permission boundaries: a rep reads only their own; owners read anyone; an admin token has no activity of its own', async () => {
    seed();
    at('2026-10-23T21:00:00Z');
    const other = await call({ cookie: 'milton-sid', query: { user: 'hello@gostaffify.com' } });
    assert.equal(other.code, 403);
    const all = await call({ cookie: 'milton-sid', query: { users: '1' } });
    assert.equal(all.code, 403);
    const sess = await call({ cookie: 'milton-sid', query: { sessions: '1' } });
    assert.equal(sess.code, 403);
    const own = await call({ cookie: 'milton-sid', query: { user: 'MILTION@trystaffify.com' } });
    assert.equal(own.code, 200, 'their own, any spelling of case');
    const asPaul = await call({ cookie: 'paul-sid', query: { user: 'miltion@trystaffify.com', from: '2026-10-19', to: '2026-10-23' } });
    assert.equal(asPaul.code, 200); assert.equal(asPaul.body.email, 'miltion@trystaffify.com');
    const everyone = await call({ cookie: 'paul-sid', query: { users: '1' } });
    assert.equal(everyone.code, 200); assert.deepEqual(everyone.body.users.map(u => u.email), ['hello@gostaffify.com', 'miltion@trystaffify.com']);
    const tokenPost = await call({ method: 'POST', bearer: 'test-admin', body: { action: 'heartbeat' } });
    assert.equal(tokenPost.code, 403);
    const tokenMe = await call({ bearer: 'test-admin', query: { me: '1' } });
    assert.equal(tokenMe.code, 400);
    const nobody = await call({ query: { me: '1' } });
    assert.equal(nobody.code, 401);
    Date.now = realNow;
});

test('live sessions report when they were created, derived from the life left, and never the token', async () => {
    seed();
    at('2026-10-23T21:00:00Z');
    const r = await call({ cookie: 'paul-sid', query: { sessions: '1', user: 'miltion@trystaffify.com' } });
    assert.equal(r.code, 200); assert.equal(r.body.sessions.length, 1);
    assert.equal(r.body.sessions[0].createdAt, '2026-10-23T20:00:00.000Z', 'an hour of life used means created an hour ago');
    assert.ok(!JSON.stringify(r.body).includes('milton-sid'), 'the session token is never returned');
    assert.match(r.body.note, /unavailable, not zero/);
    Date.now = realNow;
});

test('right now: an owner sees each caller working, quiet or on break; nobody else can read it', async () => {
    seed();
    at('2026-10-27T20:00:00Z');                                      // 4:00 PM ET
    await call({ method: 'POST', cookie: 'milton-sid', body: { action: 'event', kind: 'page_view', page: '/dialer/' } });
    store.set('shift:cur:miltion@trystaffify.com', JSON.stringify({ id: 'sh-live', day: '2026-10-27', startedAt: '2026-10-27T19:55:00.000Z', breaks: [] }));
    at('2026-10-27T20:05:00Z');
    let r = await call({ cookie: 'paul-sid', query: { live: '1' } });
    assert.equal(r.code, 200);
    const m = r.body.people.find(p => p.email === 'miltion@trystaffify.com');
    assert.equal(m.status.key, 'working'); assert.equal(m.quo, 'not connected'); assert.equal(m.lastHubAt, '2026-10-27T20:01:00.000Z');
    assert.match(r.body.note, /never payroll/);
    at('2026-10-27T20:25:00Z');                                      // 24 quiet minutes since the page view
    r = await call({ cookie: 'paul-sid', query: { live: '1' } });
    const q = r.body.people.find(p => p.email === 'miltion@trystaffify.com');
    assert.deepEqual([q.status.key, q.status.label], ['quiet', 'Quiet for 24 min']);
    assert.deepEqual(q.today.stretches.map(s => [s.minutes, s.open]), [[24, true]]);
    assert.equal((await call({ cookie: 'milton-sid', query: { live: '1' } })).code, 403, 'a caller cannot watch anyone, including the team');
    assert.equal((await call({ query: { live: '1' } })).code, 401);
    Date.now = realNow;
});
