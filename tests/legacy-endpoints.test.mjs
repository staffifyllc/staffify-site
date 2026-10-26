// The two legacy endpoints, signed in and shift-gated (Paul, 2026-10-26, through Codex).
// ------------------------------------------------------------------
// /api/lookup/ ("Who is calling?") and /api/call-queue/ were open to anyone from 2026-07-27; a
// signed-out request returned prospect numbers, a way around the shift gate. The real handlers run
// here over an in-memory Redis (the REST calls @upstash/redis makes) and a stub of the lead portal.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KV_REST_API_URL = 'https://example.invalid';
process.env.KV_REST_API_TOKEN = 'test';
process.env.ADMIN_TOKEN = 'test-admin';
process.env.SALES_PORTAL_BASE = 'https://portal.invalid/exec';
process.env.SALES_PORTAL_TOKEN = 'portal-token';
delete process.env.HUBSPOT_TOKEN; delete process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const lookup = (await import('../api/lookup.js')).default;
const callQueue = (await import('../api/call-queue.js')).default;
const { SESSION_TTL } = await import('../api/_auth.js');
const { dayOf } = await import('../api/_hub-activity.js');

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
    if (v === 'SADD') { const s = store.get(key) instanceof Set ? store.get(key) : new Set(); for (const a of args) s.add(String(a)); store.set(key, s); return 1; }
    if (v === 'SMEMBERS') { const s = store.get(key); return s instanceof Set ? [...s] : []; }
    if (v === 'SISMEMBER') { const s = store.get(key); return s instanceof Set && s.has(String(args[0])) ? 1 : 0; }
    if (v === 'HGET') { const h = hash(); return h && args[0] in h ? h[args[0]] : null; }
    if (v === 'HGETALL') { const h = hash(); return h ? Object.entries(h).flat() : []; }
    if (v === 'HSET') { const h = hash() || {}; for (let i = 0; i < args.length; i += 2) h[args[i]] = args[i + 1]; store.set(key, h); return 1; }
    if (v === 'ZRANGE') return [];
    if (v === 'KEYS') { const pat = String(key).replace('*', ''); return [...store.keys()].filter(k => k.startsWith(pat)); }
    if (v === 'LPUSH' || v === 'LTRIM') return 1;
    throw new Error('unhandled ' + v);
};
const b64 = v => (typeof v === 'string' ? Buffer.from(v).toString('base64') : Array.isArray(v) ? v.map(b64) : v);
const portalCalls = [];
const LEADS = () => ({
    websites: [
        { id: 'agency:9107695931', company: 'Riley Jones Media', name: 'Tom', phone: '+19107695931', allowNonMobile: true, email: 'tom@rj.com' },
        { id: 'w2', company: 'Opted Out Co', name: 'Ann', phone: '+15125550100', allowNonMobile: true },
        { id: 'w3', company: 'Worked Co', name: 'Bo', phone: '+15125550101', allowNonMobile: true },
    ],
    staffing: [{ id: 'vaowner:5125550102', company: 'Loft & Light', name: 'Priya', phone: '+15125550102', allowNonMobile: true }],
    total: 4,
});
globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.host === 'portal.invalid') {
        portalCalls.push({ action: u.searchParams.get('action'), body: opts.body ? JSON.parse(opts.body) : null });
        const a = u.searchParams.get('action');
        const body = !a ? { motions: [{ brand: 'Staffify', warm: [{ phone: '+15125550199', name: 'Wendy', company: 'Warm Co', grade: 'interested', allowNonMobile: true, typeCheckedAt: '2026-10-20T12:00:00Z', phoneType: 'mobile', carrier: 'T-Mobile' }] }] } : a === 'list' ? LEADS() : a === 'scoreboard' ? { dials: 12, answers: 4, recent: [{ id: 'agency:9107695931', rep: 'Milton', phone: '+19107695931', outcome: 'voicemail' }] } : a === 'log' ? { ok: true } : { ok: true };
        return { ok: true, status: 200, json: async () => body };
    }
    if (u.host !== 'example.invalid') return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    const batch = JSON.parse(opts.body || '[]');
    const payload = Array.isArray(batch[0]) ? batch.map(c => ({ result: b64(run(c)) })) : { result: b64(run(batch)) };
    const text = JSON.stringify(payload);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => payload };
};
const MILTON = 'miltion@trystaffify.com';
const seed = () => {
    store.clear(); portalCalls.length = 0;
    store.set('sess:milton-sid', MILTON); store.set('sess:paul-sid', 'hello@gostaffify.com');
    store.set('rep:' + MILTON, { email: MILTON, name: 'Milton', role: 'caller' });
    store.set('rep:hello@gostaffify.com', { email: 'hello@gostaffify.com', name: 'Paul', role: 'admin' });
    store.set('optout:numbers', new Set(['5125550100']));
    store.set('hot:handled', new Set(['5125550101']));
};
const shift = state => {
    const now = Date.now();
    const doc = { id: 'sh-test', startedAt: new Date(now - 30 * 60000).toISOString(), day: dayOf(now - 30 * 60000), breaks: state === 'break' ? [{ startedAt: new Date(now - 60000).toISOString(), endedAt: null }] : [] };
    store.set('shift:cur:' + MILTON, JSON.stringify(doc));
};
const invoke = handler => async ({ method = 'GET', cookie = null, bearer = null, query = {}, body = null }) => {
    let code = 200, out = null;
    const res = { setHeader() {}, status(n) { code = n; return this; }, json(v) { out = v; return v; } };
    await handler({ method, headers: { ...(cookie ? { cookie: 'sfy_sess=' + cookie } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, query, body: body ? JSON.stringify(body) : undefined }, res);
    return { code, body: out };
};
const L = invoke(lookup), Q = invoke(callQueue);
// Any US number however it is written, ids included (the portal builds ids from the number).
const numbers = body => (JSON.stringify(body || {}).match(/(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g) || []);

test('signed out: both endpoints answer 401 and carry no number', async () => {
    seed();
    for (const r of [await L({ query: { q: 'riley' } }), await L({ query: { q: '9107695931' } }), await Q({ query: { action: 'list' } }), await Q({ query: { action: 'scoreboard' } }), await Q({ method: 'POST', query: { action: 'log' }, body: { id: 'agency:9107695931', outcome: 'voicemail' } })]) {
        assert.equal(r.code, 401); assert.deepEqual(numbers(r.body), []);
    }
    assert.equal(portalCalls.length, 0, 'the portal is never asked on behalf of a stranger');
    const named = await Q({ query: { action: 'list', rep: 'Anyone' } });
    assert.equal(named.code, 401, 'a typed name is no longer an identity');
});

test('a machine token and an owner keep the full answer; the opt-out and worked filters still run', async () => {
    seed();
    const m = await Q({ bearer: 'test-admin', query: { action: 'list' } });
    assert.equal(m.code, 200); assert.equal(m.body.phonesWithheld, undefined);
    assert.deepEqual(m.body.websites.map(l => l.phone), ['+19107695931']);
    assert.equal(m.body.suppressed, 1); assert.equal(m.body.alreadyWorked, 1);
    const p = await Q({ cookie: 'paul-sid', query: { action: 'list' } });
    assert.deepEqual(p.body.staffing.map(l => l.phone), ['+15125550102'], 'an owner is never gated, shift or not');
    const pl = await L({ cookie: 'paul-sid', query: { q: 'riley' } });
    assert.equal(pl.code, 200); assert.equal(pl.body.found[0].phone, '+19107695931'); assert.equal(pl.body.shiftGate.allowed, true);
});

test('a caller off shift: who it is, never the number; the filters ran on the real numbers first', async () => {
    seed();
    const q = await Q({ cookie: 'milton-sid', query: { action: 'list' } });
    assert.equal(q.code, 200); assert.equal(q.body.phonesWithheld, true); assert.equal(q.body.shiftGate.reason, 'off');
    assert.deepEqual(numbers(q.body), []);
    assert.deepEqual(q.body.websites.map(l => [l.company, l.phone]), [['Riley Jones Media', null]], 'opted-out and worked leads were removed by their real numbers');
    assert.match(q.body.websites[0].id, /^agency:h-[0-9a-f]{10}$/, 'an id built from the number carries a token instead');
    assert.equal(q.body.staffing[0].id.startsWith('vaowner:h-'), true);
    assert.equal(q.body.suppressed, 1); assert.equal(q.body.alreadyWorked, 1);
    const sb = await Q({ cookie: 'milton-sid', query: { action: 'scoreboard' } });
    assert.equal(sb.body.dials, 12, 'the scoreboard still reads'); assert.deepEqual(numbers(sb.body), []);
    const byName = await L({ cookie: 'milton-sid', query: { q: 'riley' } });
    assert.equal(byName.code, 200); assert.equal(byName.body.phonesWithheld, true); assert.deepEqual(numbers(byName.body), []);
    assert.equal(byName.body.found[0].company, 'Riley Jones Media', 'the lookup still says who it is');
    const byPhone = await L({ cookie: 'milton-sid', query: { q: '(910) 769-5931' } });
    assert.equal(byPhone.body.found[0].company, 'Riley Jones Media', 'an inbound number is still identified');
    assert.equal(byPhone.body.found[0].phone, null); assert.match(byPhone.body.query, /^h-[0-9a-f]{10}$/, 'even the echo of what was typed carries no number');
    const opted = await L({ cookie: 'milton-sid', query: { q: '5125550100' } });
    assert.equal(opted.body.optedOut, true, 'the opt-out check runs on the real number'); assert.match(opted.body.advice, /Do not pitch/);
});

test('a caller on a break is withheld; on a running shift gets the numbers', async () => {
    seed(); shift('break');
    const b = await Q({ cookie: 'milton-sid', query: { action: 'list' } });
    assert.equal(b.body.shiftGate.reason, 'break'); assert.deepEqual(numbers(b.body), []);
    assert.deepEqual(numbers((await L({ cookie: 'milton-sid', query: { q: 'loft' } })).body), []);
    shift('on');
    const on = await Q({ cookie: 'milton-sid', query: { action: 'list' } });
    assert.equal(on.body.phonesWithheld, undefined); assert.deepEqual(on.body.websites.map(l => l.phone), ['+19107695931']);
    const lk = await L({ cookie: 'milton-sid', query: { q: 'loft' } });
    assert.equal(lk.body.found[0].phone, '+15125550102'); assert.equal(lk.body.shiftGate.allowed, true);
});

test('logging an outcome off shift still goes through, with the number the dialer sent', async () => {
    seed();
    const r = await Q({ method: 'POST', cookie: 'milton-sid', query: { action: 'log' }, body: { id: 'agency:9107695931', outcome: 'voicemail', phone: '+19107695931', company: 'Riley Jones Media', motion: 'websites' } });
    assert.equal(r.code, 200); assert.equal(r.body.ok, true);
    const sent = portalCalls.find(c => c.action === 'log');
    assert.equal(sent.body.phone, '+19107695931', 'the disposition keeps its phone upstream'); assert.equal(sent.body.rep, 'Milton', 'credited to the signed-in rep');
    assert.ok(store.get('hot:handled').has('9107695931'), 'and the lead is marked worked by phone');
});

test('a store that cannot be read fails closed for a caller', async () => {
    seed(); shift('on');
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts) => { const b = JSON.parse(opts?.body || '[]'); const keys = Array.isArray(b[0]) ? b.map(c => String(c[1])) : [String(b[1])]; if (keys.some(k => k.startsWith('shift:'))) throw new Error('store down'); return real(url, opts); };
    try {
        const q = await Q({ cookie: 'milton-sid', query: { action: 'list' } });
        assert.equal(q.body.phonesWithheld, true); assert.deepEqual(numbers(q.body), []);
    } finally { globalThis.fetch = real; }
});

test('the STOP list matches although the store hands digit-only members back as numbers', async () => {
    seed();
    const { optedOutSet } = await import('../api/_optout.js');
    const { numbers } = await optedOutSet();
    assert.ok(numbers.has('5125550100'), 'a string lookup finds the opted-out number');
});

test('the shared phone guard: signed out refused; a caller off shift leaves without numbers; an owner and a token untouched', async () => {
    seed();
    const { phoneGuard } = await import('../api/_phone-guard.js');
    const mk = () => { const r = { code: 200, body: null, setHeader() {}, status(n) { r.code = n; return r; }, json(v) { r.body = v; return v; } }; return r; };
    const BODY = { leads: [{ company: 'Riley Jones Media', phone: '+19107695931', name: 'Tom' }], count: 1 };
    let res = mk(); assert.equal(await phoneGuard({ headers: {}, query: {} }, res), null); assert.equal(res.code, 401);
    res = mk(); const g = await phoneGuard({ headers: { cookie: 'sfy_sess=milton-sid' }, query: {} }, res);
    assert.equal(g.shiftGate.allowed, false); res.json(BODY);
    assert.equal(res.body.leads[0].phone, null); assert.equal(res.body.leads[0].company, 'Riley Jones Media'); assert.equal(res.body.phonesWithheld, true);
    shift('on'); res = mk(); await phoneGuard({ headers: { cookie: 'sfy_sess=milton-sid' }, query: {} }, res); res.json(BODY);
    assert.equal(res.body.leads[0].phone, '+19107695931', 'on a running shift the number is there');
    res = mk(); await phoneGuard({ headers: { cookie: 'sfy_sess=paul-sid' }, query: {} }, res); res.json(BODY); assert.equal(res.body.leads[0].phone, '+19107695931');
    res = mk(); await phoneGuard({ headers: { authorization: 'Bearer test-admin' }, query: {} }, res); res.json(BODY); assert.equal(res.body.leads[0].phone, '+19107695931');
});

test('hot leads, campaign metrics and the OpenPhone list refuse a signed-out request before reading anything', async () => {
    seed();
    for (const f of ['../api/hot-leads.js', '../api/campaign-metrics.js', '../api/openphone-calls.js']) {
        const h = (await import(f)).default;
        const before = portalCalls.length;
        const r = await invoke(h)({ query: {} });
        assert.equal(r.code, 401, f); assert.deepEqual(numbers(r.body), []);
        assert.equal(portalCalls.length, before, f + ' asked nothing upstream');
    }
});

test('the legacy queue reads only its three actions; any other is refused before the portal is asked', async () => {
    seed();
    const before = portalCalls.length;
    const r = await Q({ cookie: 'paul-sid', query: { action: 'dialer' } });
    assert.equal(r.code, 400); assert.deepEqual(r.body.allowed, ['list', 'training', 'scoreboard']);
    assert.equal(portalCalls.length, before);
    assert.equal((await Q({ cookie: 'paul-sid', query: { action: 'training' } })).code, 200);
});

test('winback leads refuse a signed-out request', async () => {
    seed();
    const h = (await import('../api/winback-leads.js')).default;
    const r = await invoke(h)({ query: {} });
    assert.equal(r.code, 401); assert.deepEqual(numbers(r.body), []);
});

test('hot leads, the real handler: an engine id built from the number never reaches a caller off shift or on a break', async () => {
    seed();
    const h = invoke((await import('../api/hot-leads.js')).default);
    const owner = await h({ cookie: 'paul-sid', query: {} });
    assert.equal(owner.code, 200); assert.ok(owner.body.leads.some(l => l.id === 'engine:+15125550199'), 'the fixture lead is served to an owner as it was');
    const off = await h({ cookie: 'milton-sid', query: {} });
    assert.equal(off.code, 200); assert.equal(off.body.phonesWithheld, true); assert.deepEqual(numbers(off.body), [], 'no number in any field, the id included');
    assert.ok(off.body.leads.some(l => /^engine:h-[0-9a-f]{10}$/.test(l.id) && l.company === 'Warm Co'), 'the lead is still there, by name, with a token id');
    shift('break');
    assert.deepEqual(numbers((await h({ cookie: 'milton-sid', query: {} })).body), []);
    shift('on');
    assert.ok((await h({ cookie: 'milton-sid', query: {} })).body.leads.some(l => l.phone === '+15125550199'), 'on a running shift the number is there');
});
