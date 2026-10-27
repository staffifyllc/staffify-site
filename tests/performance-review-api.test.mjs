// The Caller review endpoint, with its real auth, over an in-memory store.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KV_REST_API_URL = 'https://example.invalid';
process.env.KV_REST_API_TOKEN = 'test';
process.env.ADMIN_TOKEN = 'test-admin';
for (const k of ['QUO_API_KEY', 'OPENPHONE_API_KEY', 'CALENDLY_API_TOKEN', 'HUBSPOT_TOKEN', 'REPORT_SLACK_CHANNEL', 'REPORT_SLACK_WEBHOOK']) delete process.env[k];
const api = (await import('../api/performance-review.js')).default;

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
const etToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const shift = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const TODAY = etToday(), Y = shift(TODAY, -1);
const seed = () => {
    store.clear();
    store.set('sess:milton-sid', MILTON); store.set('sess:paul-sid', 'hello@gostaffify.com'); store.set('sess:madison-sid', 'madison@gostaffify.com'); store.set('sess:rep-sid', 'setter@gostaffify.com');
    store.set('rep:' + MILTON, { email: MILTON, name: 'Milton Hodgson', role: 'caller' });
    store.set('rep:hello@gostaffify.com', { email: 'hello@gostaffify.com', name: 'Paul', role: 'admin' });
    store.set('rep:madison@gostaffify.com', { email: 'madison@gostaffify.com', name: 'Madison', role: 'rep' });
    store.set('rep:setter@gostaffify.com', { email: 'setter@gostaffify.com', name: 'Setter', role: 'rep' });
    store.set('reps', new Set([MILTON, 'hello@gostaffify.com', 'madison@gostaffify.com', 'setter@gostaffify.com']));
    const at = Y + 'T21:11:00.000Z';
    store.set('staffify:outreach-review:v1', JSON.stringify({ records: [
        { id: 'r1', company: 'Riley Jones', recipient: 'tom@rj.com', owner: 'Paul', campaignId: 'staffify-agency-outreach', phone: '+12125550101', callHistory: [{ at, outcome: 'no_answer', caller: MILTON, notes: 'She hung up. Her cell is 212-555-0177' }] },
        { id: 'r2', company: 'Other Rep Co', recipient: 'x@o.com', owner: 'Paul', phone: '+12125550102', callHistory: [{ at, outcome: 'connected', caller: 'setter@gostaffify.com', notes: 'great chat' }] },
    ], assignments: [], suppressions: [], queueUpdatedAt: Y + 'T23:00:00.000Z' }));
};
const invoke = handler => async ({ cookie = null, bearer = null, query = {} }) => {
    let code = 200, out = null;
    const res = { setHeader() {}, status(n) { code = n; return this; }, json(v) { out = v; return v; } };
    await handler({ method: 'GET', headers: { ...(cookie ? { cookie: 'sfy_sess=' + cookie } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, query }, res);
    return { code, body: out };
};
const A = invoke(api);

test('who reads a review: a caller their own, owners anyone, a colleague nobody else’s, a stranger nothing', async () => {
    seed();
    assert.equal((await A({ query: { user: MILTON } })).code, 401);
    const own = await A({ cookie: 'milton-sid' });
    assert.equal(own.code, 200); assert.equal(own.body.review.user.email, MILTON);
    assert.equal((await A({ cookie: 'milton-sid', query: { user: 'milton@trystaffify.com' } })).code, 200, 'his other login spelling is still him');
    assert.equal((await A({ cookie: 'milton-sid', query: { user: 'hello@gostaffify.com' } })).code, 403);
    assert.equal((await A({ cookie: 'rep-sid', query: { user: MILTON } })).code, 403);
    assert.equal((await A({ cookie: 'paul-sid', query: { user: MILTON } })).code, 200);
    assert.equal((await A({ cookie: 'madison-sid', query: { user: MILTON } })).code, 200, 'finance access reads the team');
    assert.equal((await A({ bearer: 'test-admin', query: { user: MILTON } })).code, 200);
    assert.equal((await A({ bearer: 'test-admin' })).code, 400, 'the machine token has to name someone');
    assert.equal((await A({ cookie: 'paul-sid', query: { user: 'nobody@gostaffify.com' } })).code, 404);
});

test('dates: the last 14 days by default, never the future, never backwards, at most 31 days', async () => {
    seed();
    const d = await A({ cookie: 'paul-sid', query: { user: MILTON } });
    assert.equal(d.body.review.to, TODAY); assert.equal(d.body.review.from, shift(TODAY, -13));
    assert.equal((await A({ cookie: 'paul-sid', query: { user: MILTON, from: TODAY, to: shift(TODAY, 1) } })).code, 400);
    assert.equal((await A({ cookie: 'paul-sid', query: { user: MILTON, from: Y, to: shift(Y, -1) } })).code, 400);
    assert.equal((await A({ cookie: 'paul-sid', query: { user: MILTON, from: shift(TODAY, -31), to: TODAY } })).code, 400);
    assert.equal((await A({ cookie: 'paul-sid', query: { user: MILTON, from: shift(TODAY, -30), to: TODAY } })).code, 200);
});

test('only his own calls count, the note is shown without its number, and sources that are off read unknown', async () => {
    seed();
    const { code, body } = await A({ cookie: 'paul-sid', query: { user: MILTON, from: Y, to: Y } });
    assert.equal(code, 200);
    const v = body.review;
    assert.equal(v.totals.outcomes, 1, "another rep's call on the shared log is not his");
    assert.equal(v.totals.reached, 1); assert.equal(v.reached.list[0].how, 'Hung up');
    assert.equal(v.reached.list[0].note, 'She hung up. Her cell is [number]');
    assert.equal(v.totals.dials, null, 'Quo is not connected in this test: dials unknown, not zero'); assert.equal(v.sources.quo, 'not connected');
    assert.equal(v.totals.meetings, null); assert.equal(v.sources.calendly, 'not connected');
    assert.ok(v.supply && typeof v.supply.neverDialled === 'number');
    assert.ok(!/\d{10}/.test(JSON.stringify(body)), 'no full phone number in the answer');
    assert.ok(!('records' in body.review), 'the queue itself is never sent');
});
