// The "Not now" nurture never emails a client or someone who has booked.
// ------------------------------------------------------------------
// The 2026-10-30 trace proved it could: the enrolment's client check read fields the client guard
// never returns, a guard that could not answer passed, and nothing at send time looked at bookings,
// the stop list or the CRM. Each hole is pinned here, at enrolment and at the moment a touch is due,
// with a near miss beside it so a gate that stops everybody fails too. Stubs only: nothing here
// sends, calls HubSpot or writes a real store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.UNSUBSCRIBE_SECRET ||= 'test-secret';
const { enrolInNurture } = await import('../api/_nurture-enrol.js');
const { runNurture } = await import('../api/cron-nurture.js');
const { clientCheck } = await import('../api/_client-guard.js');
const { sendGate, bookingEnds, clientVerdict } = await import('../api/_nurture-gates.js');
const { KEY } = await import('../api/_outreach-queue.js');
const { IDENTITIES } = await import('../api/_booked-leads.js');

const DAY = 86400000;
const NOW = Date.parse('2026-10-30T14:30:00Z');
const ISO = t => new Date(t).toISOString();

// One fake store for the whole stack: strings, hashes and the nurture's sorted set.
function fakeKv(seed = {}, { failGet = [], failHget = false } = {}) {
    const m = new Map(Object.entries(seed.strings || {})), h = new Map(), z = new Map();
    for (const [k, v] of Object.entries(seed.hashes || {})) h.set(k, new Map(Object.entries(v)));
    for (const [k, v] of Object.entries(seed.sets || {})) z.set(k, [...v]);
    const H = k => { if (!h.has(k)) h.set(k, new Map()); return h.get(k); };
    return { m, h, z,
        async get(k) { if (failGet.some(p => k.startsWith(p))) throw Error('store down'); return m.has(k) ? m.get(k) : null; },
        async set(k, v) { m.set(k, v); return 'OK'; },
        async hget(k, f) { if (failHget) throw Error('store down'); return H(k).has(f) ? H(k).get(f) : null; },
        async hset(k, o) { for (const [f, v] of Object.entries(o)) H(k).set(f, v); return 1; },
        async hgetall(k) { return h.has(k) && h.get(k).size ? Object.fromEntries(h.get(k)) : null; },
        async zadd(k, { member }) { if (!z.has(k)) z.set(k, []); if (!z.get(k).includes(member)) z.get(k).push(member); return 1; },
        async zrange(k) { return [...(z.get(k) || [])]; },
        async zrem(k, member) { z.set(k, (z.get(k) || []).filter(x => x !== member)); return 1; },
    };
}

const PROSPECT = 'sam@brightframe.com', CLIENT = 'owner@paidus.com';
const queue = (records = [], suppressions = []) => JSON.stringify({ revision: 3, records, suppressions, assignments: [], pausedOwners: [] });
const row = (recipient, extra = {}) => ({ id: 'r-' + recipient, campaignId: 'staffify-agency-outreach', recipient, owner: 'Paul', status: 'sent', sentTouches: 4, agencyKey: recipient.split('@')[1], ...extra });
// A rep's "Not now", eight days ago: the day 7 email is due.
const callRec = (email, extra = {}) => ({ email, name: '', enrolled_at: String(NOW - 8 * DAY), enrolled_source: 'call-timing', enrolled_by: 'milton@trystaffify.com', company: 'Brightframe', domain: email.split('@')[1], day3_sent_at: '', day14_sent_at: '', day45_sent_at: '', ...extra });
const booking = (email, startTime, at = startTime) => JSON.stringify({ at, email, inviteeUri: 'https://api.calendly.com/invitees/1', eventName: 'Discovery call', startTime, source: 'calendly webhook' });

const clear = async () => ({ status: 'clear', sources: [] });
const noStops = async () => ({ emails: new Set(), numbers: new Set() });
const lead = async () => ({ properties: { lifecyclestage: 'lead' } });

// The cron, run once over one enrolled person.
async function runFor(email, { rec = callRec(email), strings = {}, hashes = {}, deps = {}, kvOpts } = {}) {
    const kv = fakeKv({ strings: { [KEY]: queue([row(email)]), ...strings }, hashes: { [`nurture:${email}`]: rec, ...hashes }, sets: { 'nurture:active': [email] } }, kvOpts);
    const sent = [];
    const result = await runNurture({ kv, now: NOW, send: async msg => { sent.push(msg); return { id: 'x' }; }, deps: { optedOutSet: noStops, contact: lead, clientCheck: clear, ...deps } });
    return { kv, sent, result, record: await kv.hgetall(`nurture:${email}`), active: await kv.zrange('nurture:active') };
}

// ---- the client guard's real answer --------------------------------------------------------------

test('the gate reads the client guard by its real shape: only clear passes', async () => {
    // The guard itself, with its own store stubbed: this exact address has paid us.
    const guardKv = fakeKv({ strings: {
        'clients:hubspot:cache': JSON.stringify({ ts: ISO(Date.now()), emails: [CLIENT], companies: [] }),
        'clients:snapshot': JSON.stringify({ ts: ISO(Date.now()), emails: [createHash('sha256').update('someone@else.com').digest('hex').slice(0, 32)], companies: [] }),
    } });
    const real = await clientCheck({ email: CLIENT, company: '' }, { redis: guardKv });
    assert.equal(real.status, 'client');
    assert.equal(real.isClient, undefined, 'the fields the old check read do not exist');
    assert.equal(real.match, undefined);
    assert.deepEqual(clientVerdict(real), { verdict: 'stop', reason: 'existing client' });
    assert.equal(clientVerdict(await clientCheck({ email: PROSPECT, company: 'Brightframe' }, { redis: guardKv })), null, 'a prospect every source cleared passes');
    assert.equal(clientVerdict({ status: 'possible', matched: 'company' }).verdict, 'stop');
    assert.deepEqual(clientVerdict({ status: 'unknown', why: 'HubSpot did not answer' }), { verdict: 'hold', reason: 'client check unavailable' });
    assert.equal(clientVerdict(null).verdict, 'hold', 'no answer at all is a hold');
});

// ---- at enrolment --------------------------------------------------------------------------------

test('enrolment: a client logged "Not now" is left out, with a reason the rep can read', async () => {
    const guardKv = fakeKv({ strings: { 'clients:hubspot:cache': JSON.stringify({ ts: ISO(Date.now()), emails: [CLIENT], companies: [] }) } });
    const kv = fakeKv();
    const out = await enrolInNurture({ redis: kv, email: 'Owner@PaidUs.com', company: 'Paid Us' }, { isOptedOut: async () => false, clientCheck: a => clientCheck(a, { redis: guardKv, refreshClients: async () => ({ ok: false }) }) });
    assert.equal(out.enrolled, false);
    assert.equal(out.reason, 'existing client');
    assert.equal(out.message, 'already a client');
    assert.equal(await kv.hgetall('nurture:owner@paidus.com'), null, 'nothing written');
    assert.deepEqual(await kv.zrange('nurture:active'), []);
});

test('enrolment: a guard that cannot answer, or a company-name match, is not a pass', async () => {
    for (const [guard, reason] of [
        [async () => ({ status: 'unknown', why: 'the live HubSpot customer list could not be established' }), 'client check unavailable'],
        [async () => { throw Error('guard store down'); }, 'client check unavailable'],
        [async () => ({ status: 'possible', matched: 'company', reason: 'the company name matches an existing client' }), 'possible client'],
    ]) {
        const kv = fakeKv();
        const out = await enrolInNurture({ redis: kv, email: PROSPECT, company: 'Brightframe' }, { isOptedOut: async () => false, clientCheck: guard });
        assert.equal(out.enrolled, false, reason);
        assert.equal(out.reason, reason);
        assert.ok(out.message && !/\u2014/.test(out.message), 'a plain message, no em dash');
        assert.deepEqual(await kv.zrange('nurture:active'), [], 'nobody added');
    }
});

test('enrolment: someone who booked, by address or by their company, is left out; an unreadable list is not "no booking"', async () => {
    const byEmail = fakeKv({ hashes: { [IDENTITIES]: { ['email:' + PROSPECT]: booking(PROSPECT, '2026-11-02T15:00:00Z') } } });
    let out = await enrolInNurture({ redis: byEmail, email: PROSPECT, domain: 'brightframe.com' }, { isOptedOut: async () => false, clientCheck: clear });
    assert.deepEqual([out.enrolled, out.reason, out.message], [false, 'booked', 'they have booked a call']);
    const byDomain = fakeKv({ hashes: { [IDENTITIES]: { 'domain:brightframe.com': booking('lee@brightframe.com', '2026-11-02T15:00:00Z') } } });
    out = await enrolInNurture({ redis: byDomain, email: 'sam@gmail.com', domain: 'www.brightframe.com' }, { isOptedOut: async () => false, clientCheck: clear });
    assert.equal(out.reason, 'booked', 'a colleague booked from the company site the queue row names');
    out = await enrolInNurture({ redis: fakeKv({}, { failHget: true }), email: PROSPECT }, { isOptedOut: async () => false, clientCheck: clear });
    assert.deepEqual([out.enrolled, out.reason], [false, 'booking check unavailable']);
});

test('enrolment near miss: a prospect every gate clears is enrolled, with the provenance the cron reads', async () => {
    const kv = fakeKv({ hashes: { [IDENTITIES]: { 'email:someone@other.com': booking('someone@other.com', '2026-11-02T15:00:00Z') } } });
    const out = await enrolInNurture({ redis: kv, email: PROSPECT, company: 'Brightframe', domain: 'brightframe.com', caller: 'milton@trystaffify.com' }, { isOptedOut: async () => false, clientCheck: clear });
    assert.deepEqual(out, { enrolled: true, reason: 'enrolled' });
    const rec = await kv.hgetall('nurture:' + PROSPECT);
    assert.equal(rec.enrolled_source, 'call-timing');
    assert.equal(rec.domain, 'brightframe.com');
    assert.deepEqual(await kv.zrange('nurture:active'), [PROSPECT]);
    const again = await enrolInNurture({ redis: kv, email: PROSPECT }, { isOptedOut: async () => false, clientCheck: clear });
    assert.deepEqual([again.enrolled, again.reason, again.message], [false, 'already in nurture', 'they have already been added to it']);
});

// ---- at send time --------------------------------------------------------------------------------

test('send time near miss: a normal non-client still gets the day 7 email, marked sent', async () => {
    const { sent, result, record, active } = await runFor(PROSPECT);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, PROSPECT);
    assert.equal(result.day3_sent, 1);
    assert.ok(Number(record.day3_sent_at) > 0, 'marked sent');
    assert.deepEqual(active, [PROSPECT], 'still in the nurture for day 14');
    assert.equal(result.stopped + result.held, 0);
});

test('send time: someone who became a client after enrolment gets nothing, and the nurture ends with the reason', async () => {
    const { sent, result, record, active } = await runFor(PROSPECT, { deps: { clientCheck: async () => ({ status: 'client', reason: 'already a client', matched: 'email' }) } });
    assert.equal(sent.length, 0, 'no email');
    assert.equal(result.stopped, 1);
    assert.deepEqual(result.stopped_by, { 'existing client': 1 });
    assert.equal(record.stopped_reason, 'existing client');
    assert.equal(record.day3_sent_at, '', 'not marked sent');
    assert.deepEqual(active, [], 'off the nurture');
    // HubSpot calling them a customer is the same answer, whatever the guard says.
    const crm = await runFor(PROSPECT, { deps: { contact: async () => ({ properties: { lifecyclestage: 'customer' } }) } });
    assert.equal(crm.sent.length, 0); assert.equal(crm.record.stopped_reason, 'existing client');
});

test('send time: a client guard that cannot answer holds the touch, unsent and unmarked, and the next run retries', async () => {
    for (const guard of [async () => ({ status: 'unknown', why: 'the shared client snapshot (never uploaded) could not be established' }), async () => { throw Error('guard store down'); }]) {
        const first = await runFor(PROSPECT, { deps: { clientCheck: guard } });
        assert.equal(first.sent.length, 0, 'nothing sent');
        assert.equal(first.result.held, 1);
        assert.deepEqual(first.result.held_by, { 'client check unavailable': 1 });
        assert.equal(first.record.day3_sent_at, '', 'not marked sent');
        assert.equal(first.record.stopped_at, undefined, 'not ended either');
        assert.deepEqual(first.active, [PROSPECT], 'still waiting');
        // The guard answers on the next run: the same touch goes then.
        const sent = [];
        await runNurture({ kv: first.kv, now: NOW + DAY, send: async m => { sent.push(m); }, deps: { optedOutSet: noStops, contact: lead, clientCheck: clear } });
        assert.equal(sent.length, 1, 'retried and sent once the guard could answer');
    }
});

test('send time: a booked Discovery call ends a "Not now" nurture, by address, by company, or on the queue row', async () => {
    const after = ISO(NOW - DAY);
    for (const setup of [
        { hashes: { [IDENTITIES]: { ['email:' + PROSPECT]: booking(PROSPECT, '2026-11-03T15:00:00Z', after) } } },
        { hashes: { [IDENTITIES]: { 'domain:brightframe.com': booking('lee@brightframe.com', '2026-11-03T15:00:00Z', after) } } },
        { strings: { [KEY]: queue([row(PROSPECT, { booking: { at: after, email: PROSPECT, startTime: '2026-11-03T15:00:00Z' } })]) } },
    ]) {
        const { sent, result, record, active } = await runFor(PROSPECT, setup);
        assert.equal(sent.length, 0, 'no email after a booking');
        assert.deepEqual(result.stopped_by, { booked: 1 });
        assert.equal(record.stopped_reason, 'booked');
        assert.deepEqual(active, []);
    }
    const unreadable = await runFor(PROSPECT, { kvOpts: { failHget: true } });
    assert.equal(unreadable.sent.length, 0);
    assert.deepEqual(unreadable.result.held_by, { 'booking check unavailable': 1 }, 'an unreadable booked list holds, never sends');
});

test('send time: the post-call nurture keeps the Discovery call it follows, and ends on a newer one', async () => {
    // Paul's "Not a fit" (api/decide.js): enrolled after the call, so that booking is the reason for the drip.
    const decided = { email: PROSPECT, enrolled_at: String(NOW - 8 * DAY), day3_sent_at: '', day14_sent_at: '', day45_sent_at: '' };
    const earlier = booking(PROSPECT, ISO(NOW - 10 * DAY), ISO(NOW - 12 * DAY));
    const keep = await runFor(PROSPECT, { rec: decided, hashes: { [IDENTITIES]: { ['email:' + PROSPECT]: earlier } } });
    assert.equal(keep.sent.length, 1, 'the call it follows does not stop it');
    const rebooked = await runFor(PROSPECT, { rec: decided, hashes: { [IDENTITIES]: { ['email:' + PROSPECT]: booking(PROSPECT, ISO(NOW + 3 * DAY), ISO(NOW - DAY)) } } });
    assert.equal(rebooked.sent.length, 0, 'they booked again: the drip ends');
    assert.equal(rebooked.record.stopped_reason, 'booked');
    // A booking whose time cannot be read counts.
    assert.equal(bookingEnds(decided, { email: PROSPECT }), true);
    assert.equal(bookingEnds({ ...decided, enrolled_source: 'call-timing' }, JSON.parse(earlier)), true, 'after a "Not now", any booking counts');
});

test('send time: the stop list ends it, from the queue, a row, or a number on file', async () => {
    const supp = await runFor(PROSPECT, { strings: { [KEY]: queue([row(PROSPECT)], [PROSPECT]) } });
    assert.equal(supp.sent.length, 0); assert.equal(supp.record.stopped_reason, 'stop list');
    const rowSupp = await runFor(PROSPECT, { strings: { [KEY]: queue([row(PROSPECT, { status: 'suppressed' })]) } });
    assert.equal(rowSupp.sent.length, 0); assert.equal(rowSupp.record.stopped_reason, 'stop list');
    const number = await runFor(PROSPECT, { strings: { ['staffify:call-phone:' + PROSPECT]: { phone: '+1 (512) 555-0100' } }, deps: { optedOutSet: async () => ({ emails: new Set(), numbers: new Set(['5125550100']) }) } });
    assert.equal(number.sent.length, 0); assert.equal(number.record.stopped_reason, 'opted out');
    const crmNumber = await runFor(PROSPECT, { deps: { optedOutSet: async () => ({ emails: new Set(), numbers: new Set(['5125550199']) }), contact: async () => ({ properties: { mobilephone: '512-555-0199' } }) } });
    assert.equal(crmNumber.sent.length, 0, 'a STOP from the CRM\'s mobile'); assert.equal(crmNumber.record.stopped_reason, 'opted out');
    const unreadable = await runFor(PROSPECT, { kvOpts: { failGet: [KEY] } });
    assert.equal(unreadable.sent.length, 0); assert.deepEqual(unreadable.result.held_by, { 'queue unavailable': 1 });
    const numbersDown = await runFor(PROSPECT, { kvOpts: { failGet: ['staffify:call-'] } });
    assert.equal(numbersDown.sent.length, 0); assert.deepEqual(numbersDown.result.held_by, { 'stop list unavailable': 1 });
    // The global list, read strictly: an address on it is dropped before any gate runs.
    const optedOut = await runFor(PROSPECT, { deps: { optedOutSet: async () => ({ emails: new Set([PROSPECT]), numbers: new Set() }) } });
    assert.equal(optedOut.sent.length, 0); assert.equal(optedOut.result.suppressed, 1); assert.deepEqual(optedOut.active, []);
});

test('send time: CRM do not contact ends it; a CRM that cannot answer holds; nobody in the CRM is not a stop', async () => {
    for (const p of [{ do_not_contact: 'true' }, { hs_email_optout: 'true' }, { rep_lifecycle_state: 'DNC' }]) {
        const r = await runFor(PROSPECT, { deps: { contact: async () => ({ properties: p }) } });
        assert.equal(r.sent.length, 0, JSON.stringify(p));
        assert.equal(r.record.stopped_reason, 'do not contact');
    }
    const down = await runFor(PROSPECT, { deps: { contact: async () => { throw Error('CRM unavailable: 502'); } } });
    assert.equal(down.sent.length, 0); assert.deepEqual(down.result.held_by, { 'CRM unavailable': 1 }); assert.equal(down.record.day3_sent_at, '');
    const missing = await runFor(PROSPECT, { deps: { contact: async () => { throw Error('CRM contact missing'); } } });
    assert.equal(missing.sent.length, 1, 'not in HubSpot: the client guard decides, and it cleared them');
});

test('send time: the queue is read once per run, and only when a touch is due', async () => {
    const kv = fakeKv({ strings: { [KEY]: queue([row(PROSPECT), row('kim@other.com')]) }, hashes: {
        ['nurture:' + PROSPECT]: callRec(PROSPECT), 'nurture:kim@other.com': callRec('kim@other.com'),
        'nurture:new@later.com': callRec('new@later.com', { enrolled_at: String(NOW - DAY) }),
    }, sets: { 'nurture:active': [PROSPECT, 'kim@other.com', 'new@later.com'] } });
    let reads = 0; const get = kv.get.bind(kv); kv.get = async k => { if (k === KEY) reads++; return get(k); };
    let checks = 0;
    const result = await runNurture({ kv, now: NOW, send: async () => {}, deps: { optedOutSet: noStops, contact: lead, clientCheck: async () => { checks++; return { status: 'clear' }; } } });
    assert.equal(result.day3_sent, 2);
    assert.equal(reads, 1, 'one queue read for the run');
    assert.equal(checks, 2, 'nobody is checked before a touch is due');
});

test('sendGate on its own: an unreadable STOP list is a hold', async () => {
    const r = await sendGate(PROSPECT, callRec(PROSPECT), { kv: fakeKv({ strings: { [KEY]: queue([]) } }), optedOut: null, contact: lead, clientCheck: clear });
    assert.deepEqual(r, { verdict: 'hold', reason: 'stop list unavailable' });
});
