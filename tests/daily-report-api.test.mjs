// The report endpoint and the scheduled job, with their real auth, over an in-memory store.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KV_REST_API_URL = 'https://example.invalid';
process.env.KV_REST_API_TOKEN = 'test';
process.env.ADMIN_TOKEN = 'test-admin';
for (const k of ['QUO_API_KEY', 'OPENPHONE_API_KEY', 'CALENDLY_API_TOKEN', 'HUBSPOT_TOKEN', 'REPORT_SLACK_CHANNEL', 'REPORT_SLACK_WEBHOOK']) delete process.env[k];
const api = (await import('../api/daily-report.js')).default;
const cron = (await import('../api/cron-daily-report.js')).default;

const store = new Map();
const run = cmd => {
    const [verb, key, ...args] = cmd; const v = String(verb).toUpperCase();
    const str = x => (typeof x === 'string' ? x : JSON.stringify(x));
    const flags = args.slice(1).map(a => String(a).toUpperCase());
    const hash = () => { const h = store.get(key); return h && typeof h === 'object' && !(h instanceof Set) && !Array.isArray(h) ? h : null; };
    if (v === 'GET') return store.has(key) ? store.get(key) : null;
    if (v === 'SET') { if (flags.includes('NX') && store.has(key)) return null; store.set(key, str(args[0])); return 'OK'; }
    if (v === 'DEL') { let n = 0; for (const k of [key, ...args]) n += store.delete(k) ? 1 : 0; return n; }
    if (v === 'EXPIRE') return 1;
    if (v === 'SMEMBERS') { const s = store.get(key); return s instanceof Set ? [...s] : []; }
    if (v === 'HGETALL') { const h = hash(); return h ? Object.entries(h).flat() : []; }
    if (v === 'HGET') { const h = hash(); return h && args[0] in h ? h[args[0]] : null; }
    if (v === 'LRANGE') return [];
    if (v === 'MGET') return [key, ...args].map(k => (store.has(k) ? store.get(k) : null));
    return null;
};
const b64 = v => (typeof v === 'string' ? Buffer.from(v).toString('base64') : Array.isArray(v) ? v.map(b64) : v);
globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.host !== 'example.invalid') throw new Error('no network in tests: ' + u.host);
    const batch = JSON.parse(opts.body || '[]');
    const payload = Array.isArray(batch[0]) ? batch.map(c => ({ result: b64(run(c)) })) : { result: b64(run(batch)) };
    const text = JSON.stringify(payload);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => payload };
};
const MILTON = 'miltion@trystaffify.com';
const seed = () => {
    store.clear();
    store.set('sess:milton-sid', MILTON); store.set('sess:paul-sid', 'hello@gostaffify.com'); store.set('sess:madison-sid', 'madison@gostaffify.com'); store.set('sess:rep-sid', 'setter@gostaffify.com');
    store.set('rep:' + MILTON, { email: MILTON, name: 'Milton Hodgson', role: 'caller' });
    store.set('rep:hello@gostaffify.com', { email: 'hello@gostaffify.com', name: 'Paul', role: 'admin' });
    store.set('rep:madison@gostaffify.com', { email: 'madison@gostaffify.com', name: 'Madison', role: 'rep' });
    store.set('rep:setter@gostaffify.com', { email: 'setter@gostaffify.com', name: 'Setter', role: 'rep' });
    store.set('reps', new Set([MILTON, 'hello@gostaffify.com', 'madison@gostaffify.com', 'setter@gostaffify.com']));
    store.set('staffify:outreach-review:v1', JSON.stringify({ records: [{ id: 'r1', company: 'Riley Jones', recipient: 'tom@rj.com', owner: 'Paul', callHistory: [{ at: '2026-10-23T20:11:00.000Z', outcome: 'voicemail', caller: MILTON }] }], assignments: [], suppressions: [], queueUpdatedAt: '2026-10-23T23:00:00.000Z' }));
};
const invoke = handler => async ({ cookie = null, bearer = null, query = {} }) => {
    let code = 200, out = null;
    const res = { setHeader() {}, status(n) { code = n; return this; }, json(v) { out = v; return v; } };
    await handler({ method: 'GET', headers: { ...(cookie ? { cookie: 'sfy_sess=' + cookie } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, query }, res);
    return { code, body: out };
};
const A = invoke(api), C = invoke(cron);
const realNow = Date.now;

test('who reads a report: Milton his own, owners anyone, a colleague no one else’s, a stranger nothing', async () => {
    seed();
    assert.equal((await A({ query: { user: MILTON, date: '2026-10-23' } })).code, 401);
    const own = await A({ cookie: 'milton-sid', query: { date: '2026-10-23' } });
    assert.equal(own.code, 200); assert.equal(own.body.report.user.email, MILTON); assert.equal(own.body.stored, false);
    assert.equal(own.body.report.calls.loggedOutcomes, 1); assert.equal(own.body.report.calls.verifiedAttempts, null, 'Quo is not connected in this test, so unknown');
    assert.ok(own.body.report.coverage.some(x => /Quo is not connected/.test(x)));
    assert.equal((await A({ cookie: 'rep-sid', query: { user: MILTON, date: '2026-10-23' } })).code, 403, 'a rep who is not an owner cannot read Milton');
    assert.equal((await A({ cookie: 'madison-sid', query: { user: MILTON, date: '2026-10-23' } })).code, 200, 'Madison has finance access: an authorized manager, as on Activity');
    assert.equal((await A({ cookie: 'milton-sid', query: { user: 'madison@gostaffify.com' } })).code, 403);
    const paul = await A({ cookie: 'paul-sid', query: { user: MILTON, date: '2026-10-23' } });
    assert.equal(paul.code, 200); assert.match(paul.body.schedule.destination, /No private Slack destination/);
    const people = await A({ cookie: 'paul-sid', query: { people: '1' } });
    // Paul, 2026-10-28: "I do want my metrics to also track on my end too". Callers, and the owners who call; a plain rep with no caller plan still does not.
    assert.deepEqual(people.body.people.map(p => p.email), [MILTON, 'hello@gostaffify.com', 'madison@gostaffify.com']);
    assert.equal((await A({ cookie: 'milton-sid', query: { people: '1' } })).code, 403);
    assert.equal((await A({ cookie: 'paul-sid', query: { user: MILTON, date: '2099-01-01' } })).code, 400);
});

test('the scheduled job: nothing before 8 AM Eastern; after it, yesterday’s report is kept and, with no destination, not sent', async () => {
    seed();
    assert.equal((await C({})).code, 401, 'only the cron secret or an admin token');
    Date.now = () => Date.parse('2026-10-24T11:05:00Z');   // 7:05 AM EDT
    let r = await C({ bearer: 'test-admin' });
    assert.equal(r.body.skipped, 'before 8 AM Eastern');
    Date.now = () => Date.parse('2026-10-24T12:05:00Z');   // 8:05 AM EDT
    r = await C({ bearer: 'test-admin' });
    assert.equal(r.code, 200); assert.equal(r.body.day, '2026-10-23'); assert.deepEqual(r.body.people, [MILTON, 'hello@gostaffify.com', 'madison@gostaffify.com'], 'the owners who call are reported too');
    assert.equal(r.body.results[0].status, 'stored_not_delivered');
    const snap = JSON.parse(store.get('report:daily:' + MILTON + ':2026-10-23'));
    assert.equal(snap.calls.loggedOutcomes, 1); assert.equal(snap.day, '2026-10-23');
    Date.now = realNow;
    const kept = await A({ cookie: 'paul-sid', query: { user: MILTON, date: '2026-10-23' } });
    assert.equal(kept.body.stored, true, 'the Hub shows the kept snapshot'); assert.equal(kept.body.delivery.status, 'not_configured');
    assert.equal((await C({ bearer: 'test-admin', query: { day: '2999-01-01' } })).code, 400, 'a day that has not ended is refused');
    const st = await C({ bearer: 'test-admin', query: { status: '1' } });
    assert.equal(st.body.lastRun.day, '2026-10-23');
});
