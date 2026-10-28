// Hiring now: the call-first campaign built from current job posts. Every outside service is a stub;
// nothing here calls, texts, emails or spends a credit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HK, HIRING_ID, FRESH_MS, MAX_AGE_DAYS, JOB_QUERIES, JOB_TERMS, METROS, qualifyJob, profileMatches, jobAgeDays, stateOf, companyKey, phoneKey, parseAts, roleFamily, qualifyPosting, restrictions, hiringCallReady, applyOutcome, callRow, linksToBoard, boardHomepage, getRecord, allRecords, allBacklog, putRecord, hiringReportRows } from '../api/_hiring-intent.js';
import { processPosting, runHiring, refreshReady, addPending, PENDING_MAX_ATTEMPTS, compactListing } from '../api/_hiring-run.js';
import { saveHiringOutcome, hiringBrief, liveStops } from '../api/_hiring-calls.js';
import { putBacklog as putBacklogStore } from '../api/_hiring-intent.js';
import { hiringCallScript } from '../api/_call-scripts.js';
import { crmStop } from '../api/_rep-email-gates.js';
import { loadBad, isBad } from '../api/_bad-numbers.js';
import { stats } from '../api/_campaigns-model.js';
import { orderCallQueue } from '../assets/js/call-queue-order.js';
import { hubEntriesFrom } from '../api/_daily-report.js';
import { calledFirst } from '../api/rep-email.js';

const NOW = Date.parse('2026-10-27T18:00:00Z');
function fakeKv() {
    const m = new Map(), hashes = new Map(), lists = new Map();
    const H = k => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
    const L = k => { if (!lists.has(k)) lists.set(k, []); return lists.get(k); };
    return { m, hashes, lists,
        async get(k) { return m.has(k) ? m.get(k) : null; },
        async set(k, v, o = {}) { if (o.nx && m.has(k)) return null; m.set(k, v); return 'OK'; },
        async del(k) { m.delete(k); return 1; },
        async incr(k) { m.set(k, Number(m.get(k) || 0) + 1); return m.get(k); },
        async expire() { return 1; },
        async hget(k, f) { return H(k).has(f) ? H(k).get(f) : null; },
        async hset(k, o) { for (const [f, v] of Object.entries(o)) H(k).set(f, v); return 1; },
        async hsetnx(k, f, v) { if (H(k).has(f)) return 0; H(k).set(f, v); return 1; },
        async hgetall(k) { return H(k).size ? Object.fromEntries(H(k)) : null; },
        async hdel(k, ...fs) { for (const f of fs) H(k).delete(f); return fs.length; },
        async lpush(k, v) { L(k).unshift(v); return L(k).length; },
        async rpush(k, v) { L(k).push(v); return L(k).length; },
        async ltrim(k, a, b) { lists.set(k, L(k).slice(a, b + 1)); return 'OK'; },
        async lrange(k, a, b) { return L(k).slice(a, b + 1); },
        async lrem(k, n, v) { const l = L(k), i = l.indexOf(v); if (i >= 0) l.splice(i, 1); return i >= 0 ? 1 : 0; },
    };
}

const LEVER_ID = '999a0f10-0738-42f7-a9f6-5c7192e74873';
const LEVER_URL = 'https://jobs.lever.co/acme/' + LEVER_ID;
const leverJob = (over = {}) => ({ text: 'Customer Support Specialist', createdAt: NOW - 5 * 864e5, workplaceType: 'remote', country: 'US', hostedUrl: LEVER_URL, categories: { location: 'Remote in Latin America', allLocations: ['Remote in Latin America', 'Remote in Philippines'], team: 'Support', commitment: 'Full-time' }, descriptionPlain: 'Help our customers by chat and email.', lists: [], additionalPlain: '', ...over });
const leverPage = (home = 'https://www.acme.com/') => ({ url: LEVER_URL, html: `<title>Acme - Customer Support Specialist</title><a href="${home}">Acme Home Page</a>`, text: 'Acme' });

/** A world of stubs: the posting APIs, the sites, the vendors and the controls. */
function world(over = {}) {
    const kv = fakeKv();
    const json = { [`https://api.lever.co/v0/postings/acme/${LEVER_ID}`]: { status: 200, body: leverJob() }, 'https://api.lever.co/v0/postings/acme?mode=json&limit=200': { status: 200, body: new Array(12).fill({}) }, ...(over.json || {}) };
    const pages = { [LEVER_URL]: leverPage(), 'https://www.acme.com/': { url: 'https://www.acme.com/', html: '<a href="/contact">Contact</a>', text: 'Acme makes software' }, ...(over.pages || {}) };
    const calls = { phone: [], contact: [], optOut: [] };
    const deps = {
        kv, now: NOW,
        getJson: async u => json[u] || { status: 404, body: null },
        getPage: async u => { const p = pages[u] || pages[u.replace(/\/$/, '')] || pages[u + '/']; if (!p) throw Error('unreachable'); return p; },
        findSitePhone: async ({ website }) => { calls.phone.push(website); return over.phone === null ? null : { phone: '+13056360188', alternates: [], sourceUrl: website + 'contact', context: 'Call us', checkedAt: new Date(NOW).toISOString(), source: 'business website' }; },
        findContact: async d => { calls.contact.push(d); return over.contact === undefined ? { name: 'Dana Reyes', role: 'Head of Support', email: 'dana@acme.com' } : over.contact; },
        verifyEmail: async e => ({ email: e, status: 'verified', provider: 'google', checkedAt: new Date(NOW).toISOString() }),
        isOptedOut: async q => !!(over.optedOut && (over.optedOut.includes(q.phone) || over.optedOut.includes(q.email))),
        clientCheck: async () => over.client || { status: 'clear' },
        crmContact: async () => { if (over.crmError) throw Error('HubSpot 503'); if (over.crm) return { properties: over.crm }; throw Error('CRM contact missing'); },
        crmStop, loadBad, isBad,
        outreachDomains: new Set(over.outreach || []),
        serpAccount: async () => ({ left: 900 }),
        serpSearch: async () => ({ links: over.links || [] }),
        findymailCredits: async () => ({ credits: 1800 }),
    };
    return { kv, deps, calls };
}
const lever = parseAts(LEVER_URL);

test('only official postings on systems we can read back are accepted', () => {
    assert.deepEqual(lever, { ats: 'lever', board: 'acme', id: LEVER_ID });
    assert.equal(parseAts('https://boards.greenhouse.io/figma/jobs/5426468004?gh_jid=1').ats, 'greenhouse');
    assert.equal(parseAts('https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245').ats, 'ashby');
    assert.equal(parseAts('https://www.indeed.com/viewjob?jk=1'), null);
    assert.equal(parseAts('https://www.linkedin.com/jobs/view/1'), null);
});

test('the roles Staffify fills, and not leaders, engineers or sales', () => {
    assert.equal(roleFamily('Customer Care Agent'), 'support');
    assert.equal(roleFamily('L1 Technical Support Agent (Spanish and English Speaking)'), 'support');
    assert.equal(roleFamily('Executive Assistant to the CEO'), 'admin');
    assert.equal(roleFamily('Scheduling Coordinator'), 'scheduling');
    assert.equal(roleFamily('Customer Support Manager'), null);
    assert.equal(roleFamily('Account Executive'), null);
    assert.equal(roleFamily('Senior Software Engineer'), null);
});

test('a post is excluded for being closed, stale, a competitor, onsite or hard-restricted', () => {
    const base = { live: true, title: 'Customer Support Specialist', postedAt: new Date(NOW - 3 * 864e5).toISOString(), workplace: 'remote', company: 'Acme', text: 'Remote role', location: 'Remote', locations: [], openRoles: 10 };
    assert.equal(qualifyPosting(base, NOW).ok, true);
    assert.equal(qualifyPosting({ ...base, live: false }, NOW).reason, 'closed_post');
    assert.equal(qualifyPosting({ ...base, postedAt: new Date(NOW - 90 * 864e5).toISOString() }, NOW).reason, 'stale_post');
    assert.equal(qualifyPosting({ ...base, text: 'We are a staffing agency hiring on behalf of our client.' }, NOW).reason, 'competitor');
    assert.equal(qualifyPosting({ ...base, company: 'TaskUs' }, NOW).reason, 'competitor');
    assert.equal(qualifyPosting({ ...base, workplace: 'onsite' }, NOW).reason, 'not_remote');
    assert.equal(qualifyPosting({ ...base, text: 'Remote. Must be a U.S. citizen.' }, NOW).reason, 'hard_restriction');
    assert.equal(qualifyPosting({ ...base, openRoles: 140 }, NOW).reason, 'large_employer');
    // Soft rules are kept and shown to the caller; "remote user" is not "remote US".
    assert.deepEqual(restrictions('Remote (US only). Authorized to work in the US').soft.length, 2);
    assert.deepEqual(restrictions('Help remote users with support').soft, []);
});

test('company identity: the job board names the homepage, or the site links back to that exact board', () => {
    assert.equal(boardHomepage('lever', leverPage('https://www.acme.com/').html), 'https://www.acme.com/');
    assert.equal(linksToBoard('<a href="https://jobs.lever.co/acme">Careers</a>', lever), true);
    assert.equal(linksToBoard('<a href="https://jobs.lever.co/acmecorp">Careers</a>', lever), false);
    assert.equal(linksToBoard('<p>Acme is hiring!</p>', lever), false);
});

test('a guessed boardname.com that only mentions the brand is research, never phone-ready', async () => {
    // The Lever page names no homepage. acme.com exists and says "Acme" but never links to this board.
    const { kv, deps, calls } = world({ pages: { [LEVER_URL]: { url: LEVER_URL, html: '<title>Acme - Customer Support Specialist</title>', text: '' }, 'https://acme.com': { url: 'https://acme.com/', html: '<h1>Acme</h1><a href="/careers">Careers</a>', text: 'Acme' }, 'https://acme.com/careers': { url: 'https://acme.com/careers', html: '<p>Join Acme</p>', text: 'Join Acme' } } });
    const r = await processPosting(lever, { discoveredBy: 'test' }, deps, null);
    assert.equal(r.verdict, 'backlog'); assert.equal(r.reason, 'identity_unresolved');
    assert.equal((await allRecords(kv)).length, 0);
    assert.equal(calls.phone.length, 0, 'no number is looked up for an unproven company');
    assert.equal(calls.contact.length, 0, 'no credit is spent on an unproven company');
    const b = (await allBacklog(kv))[0];
    assert.deepEqual(b.missing, ['website', 'phone']); assert.equal(b.state, 'open');
});

test('a careers page that links back to the exact board admits the company', async () => {
    const { kv, deps } = world({ pages: { [LEVER_URL]: { url: LEVER_URL, html: '<title>Acme - Customer Support Specialist</title>', text: '' }, 'https://acme.com': { url: 'https://acme.com/', html: '<a href="/careers">Careers</a>', text: 'Acme' }, 'https://acme.com/careers': { url: 'https://acme.com/careers', html: '<a href="https://jobs.lever.co/acme">Open roles</a>', text: '' } } });
    const r = await processPosting(lever, { discoveredBy: 'test' }, deps, null);
    assert.equal(r.verdict, 'ready');
    const rec = await getRecord(kv, r.id);
    assert.equal(rec.company.identity.how, 'backlink');
    assert.equal(rec.company.identity.evidenceUrl, 'https://acme.com/careers');
});

test('a ready record carries the job, the listed number and the contact, each with its source and time', async () => {
    const { kv, deps } = world();
    const report = { samples: [] };
    const r = await processPosting(lever, { discoveredBy: 'SerpApi Google search', searchQuery: 'q' }, deps, report);
    assert.equal(r.verdict, 'ready');
    const rec = await getRecord(kv, r.id);
    assert.equal(rec.campaignId, HIRING_ID);
    assert.equal(rec.job.url, LEVER_URL); assert.equal(rec.job.title, 'Customer Support Specialist');
    assert.equal(rec.job.checkedAt, new Date(NOW).toISOString()); assert.equal(rec.job.ageDays, 5);
    assert.equal(rec.company.identity.how, 'board_link');
    assert.equal(rec.phone.source, 'business website'); assert.match(rec.phone.sourceUrl, /acme\.com/);
    assert.equal(rec.phone.owner, 'the company, not a named person');
    assert.deepEqual([rec.contact.name, rec.contact.role, rec.contact.email, rec.contact.status], ['Dana Reyes', 'Head of Support', 'dana@acme.com', 'verified']);
    assert.equal(rec.provenance.verifiedVia, 'lever public postings API');
    assert.match(rec.brief.summary, /Latin America/);
    assert.equal(hiringCallReady(rec, NOW), true);
    assert.equal(report.samples.length, 1);
});

test('no published number: a persistent research entry, never the ready list', async () => {
    const { kv, deps } = world({ phone: null });
    const r = await processPosting(lever, { discoveredBy: 'test' }, deps, null);
    assert.equal(r.reason, 'no_listed_phone');
    assert.equal((await allRecords(kv)).length, 0);
    const b = (await allBacklog(kv))[0];
    assert.equal(b.attempts, 1); assert.ok(Date.parse(b.nextTryAt) > NOW);
    assert.equal(b.contact.email, 'dana@acme.com', 'what was found is kept for the retry');
});

test('exclusions: a client, an opted-out number, a company already in an email thread', async () => {
    let w = world({ client: { status: 'client' } });
    assert.equal((await processPosting(lever, {}, w.deps, null)).reason, 'client');
    w = world({ optedOut: ['+13056360188'] });
    assert.equal((await processPosting(lever, {}, w.deps, null)).reason, 'opted_out');
    w = world({ outreach: ['acme.com'] });
    assert.equal((await processPosting(lever, {}, w.deps, null)).reason, 'already_in_outreach');
    w = world({ crm: { lifecyclestage: 'customer' } });
    assert.equal((await processPosting(lever, {}, w.deps, null)).reason, 'crm_stop');
    w = world({ client: { status: 'unknown', why: 'snapshot stale' } });
    assert.equal((await processPosting(lever, {}, w.deps, null)).reason, 'client_check_unavailable', 'an unreadable client list is research, never a pass');
});

// ---- freshness: a job that closes stops being offered -------------------------------------------
test('a card is offered only while its post was confirmed live in the last 72 hours', async () => {
    const { kv, deps } = world();
    const r = await processPosting(lever, {}, deps, null);
    const rec = await getRecord(kv, r.id);
    assert.equal(hiringCallReady(rec, NOW + FRESH_MS - 60000), true);
    assert.equal(hiringCallReady(rec, NOW + FRESH_MS + 60000), false, 'unconfirmed for three days: not offered');
});

test('the refresh pass closes a card whose job came down, and keeps an owned callback with its history', async () => {
    const w = world();
    const r = await processPosting(lever, {}, w.deps, null);
    // Milton spoke to a gatekeeper and promised a callback; a second card nobody worked.
    let rec = await getRecord(w.kv, r.id);
    rec = applyOutcome(rec, { outcome: 'gatekeeper', notes: 'Ask for Dana', nextCallAt: new Date(NOW + 3600e3).toISOString(), dialled: '+13056360188' }, 'milton@trystaffify.com', NOW);
    await putRecord(w.kv, rec);
    const other = { ...rec, id: 'hire:0000000000000002', callOutcome: null, nextCallAt: null, callOwner: null, callHistory: [] };
    await putRecord(w.kv, other);
    // The posting is gone the next day.
    const later = { ...w.deps, now: NOW + 864e5, getJson: async () => ({ status: 404, body: null }) };
    const out = await refreshReady(later, { limit: 10 });
    assert.equal(out.closed, 2);
    const owned = await getRecord(w.kv, rec.id), unworked = await getRecord(w.kv, other.id);
    assert.equal(owned.job.state, 'closed'); assert.ok(owned.job.closedAt);
    assert.equal(owned.callOwner, 'milton@trystaffify.com'); assert.equal(owned.callHistory.length, 1, 'history kept');
    assert.equal(hiringCallReady(unworked, NOW + 864e5), false, 'nobody is handed a closed job');
    assert.equal(hiringCallReady(owned, NOW + 864e5), true, 'a promised callback stays due for its owner');
    assert.equal(callRow(owned, 'milton@trystaffify.com', NOW + 864e5).hiring.jobState, 'closed');
    // A read that fails changes nothing.
    const flaky = { ...w.deps, now: NOW + 2 * 864e5, getJson: async () => { throw Error('timeout'); } };
    await putRecord(w.kv, { ...other, id: 'hire:0000000000000003', job: { ...other.job, state: 'open' } });
    const f = await refreshReady(flaky, { limit: 10 });
    assert.equal(f.errors, 1);
    assert.equal((await getRecord(w.kv, 'hire:0000000000000003')).job.state, 'open');
});

// ---- durability: nothing paid for is dropped -------------------------------------------------
const ids = ['aaaaaaaa-0738-42f7-a9f6-5c7192e74873', 'bbbbbbbb-0738-42f7-a9f6-5c7192e74873', 'cccccccc-0738-42f7-a9f6-5c7192e74873'];
function threeBoards() {
    const json = {}, pages = {};
    ids.forEach((id, i) => {
        const b = 'co' + i, url = `https://jobs.lever.co/${b}/${id}`;
        json[`https://api.lever.co/v0/postings/${b}/${id}`] = { status: 200, body: leverJob({ hostedUrl: url }) };
        json[`https://api.lever.co/v0/postings/${b}?mode=json&limit=200`] = { status: 200, body: [] };
        pages[url] = { url, html: `<title>Co${i} - Support</title><a href="https://www.co${i}.com/">Co${i} Home Page</a>`, text: '' };
        pages[`https://www.co${i}.com/`] = { url: `https://www.co${i}.com/`, html: '', text: '' };
    });
    return { json, pages, links: ids.map((id, i) => `https://jobs.lever.co/co${i}/${id}`) };
}

test('a posting that cannot be read stays pending, then is parked as research, never lost', async () => {
    const w = world();
    await addPending(w.kv, { ...lever, url: LEVER_URL }, { seed: true, discoveredBy: 'seed' }, NOW);
    const broken = { ...w.deps, getJson: async () => ({ status: 502, body: null }) };
    for (let i = 1; i < PENDING_MAX_ATTEMPTS; i++) {
        const r = await runHiring({ ...broken, now: NOW + i * 864e5 }, { discover: false, refresh: 0 });
        assert.equal(r.verdicts.error, 1);
        const p = Object.values(await w.kv.hgetall(HK.pending)).map(JSON.parse)[0];
        assert.equal(p.attempts, i); assert.match(p.lastError, /Lever answered 502/);
    }
    await runHiring({ ...broken, now: NOW + 9 * 864e5 }, { discover: false, refresh: 0 });
    assert.equal(await w.kv.hgetall(HK.pending), null);
    const parked = (await allBacklog(w.kv))[0];
    assert.equal(parked.reason, 'posting_unreadable'); assert.equal(parked.job.url, LEVER_URL);
});

test('a seed survives a run that crashes mid-posting, and is worked by the next one', async () => {
    const w = world();
    await addPending(w.kv, { ...lever, url: LEVER_URL }, { seed: true, discoveredBy: 'seed', note: 'PM seed' }, NOW);
    const crashing = { ...w.deps, findSitePhone: async () => { throw Error('worker died'); }, clientCheck: async () => { throw Error('worker died'); } };
    // clientCheck failing is caught as "unknown" (research); make the crash a store failure instead.
    const kvCrash = { ...w.kv, hget: async (k, f) => { if (k === HK.companies) throw Error('store down'); return w.kv.hget(k, f); } };
    await runHiring({ ...crashing, kv: kvCrash }, { discover: false, refresh: 0 });
    assert.ok(await w.kv.hget(HK.pending, 'lever:acme:' + LEVER_ID), 'still pending after the crash');
    // Retried after its back-off, not lost.
    const ok = await runHiring({ ...w.deps, now: NOW + 2 * 3600e3 }, { discover: false, refresh: 0 });
    assert.equal(ok.verdicts.ready, 1);
    const rec = (await allRecords(w.kv))[0];
    assert.equal(rec.provenance.seed, true); assert.equal(rec.provenance.note, 'PM seed');
    assert.equal(await w.kv.hgetall(HK.pending), null);
});

// ---- the caller's side -------------------------------------------------------------------------
async function readyCard(over) { const w = world(over); const r = await processPosting(lever, {}, w.deps, null); return { ...w, id: r.id }; }
const MILTON = { email: 'milton@trystaffify.com', name: 'Milton Hodgson' };

test('STOP on a phone-only card writes the number to the global stop list and closes the company', async () => {
    const w = await readyCard({ contact: {} });
    const optOuts = [];
    const r = await saveHiringOutcome(w.kv, { rep: MILTON, body: { action: 'suppress', id: w.id, notes: 'Take us off', dialled: '(305) 636-0188' } }, { optOut: async q => { optOuts.push(q); return { ok: true }; }, recordActivity: async () => {} });
    assert.equal(r.ok, true);
    assert.equal(optOuts.length, 1); assert.equal(optOuts[0].phone, '(305) 636-0188'); assert.equal(optOuts[0].email, null);
    const rec = await getRecord(w.kv, w.id);
    assert.equal(rec.status, 'suppressed'); assert.equal(rec.callHistory[0].outcome, 'suppress');
    assert.equal(JSON.parse(await w.kv.hget(HK.companies, 'lever:acme')).verdict, 'suppressed');
    // The company never comes back through a later search, not even for another role.
    const other = { ats: 'lever', board: 'acme', id: 'dddddddd-0738-42f7-a9f6-5c7192e74873' };
    const json = { [`https://api.lever.co/v0/postings/acme/${other.id}`]: { status: 200, body: leverJob({ text: 'Scheduling Coordinator' }) } };
    const deps = { ...w.deps, getJson: async u => json[u] || w.deps.getJson(u) };
    assert.equal((await processPosting(other, {}, deps, null)).reason, 'company_suppressed');
});

test('a wrong number is marked bad for this card and the card goes back to research', async () => {
    const w = await readyCard();
    const r = await saveHiringOutcome(w.kv, { rep: MILTON, body: { action: 'call-outcome', id: w.id, outcome: 'wrong_number', dialled: '+13056360188' } }, { recordActivity: async () => {} });
    assert.equal(r.wrongNumber.ok, true);
    assert.equal((await getRecord(w.kv, w.id)).status, 'number_research');
    assert.equal((await allBacklog(w.kv))[0].reason, 'wrong_number');
    assert.equal(isBad(await loadBad(w.kv, w.id), '+13056360188'), true);
});

test('outcomes follow the queue rules: future time for retries, refused once no longer due', async () => {
    const w = await readyCard();
    const bad = await saveHiringOutcome(w.kv, { rep: MILTON, body: { action: 'call-outcome', id: w.id, outcome: 'callback', nextCallAt: new Date(Date.now() - 1000).toISOString() } }, { recordActivity: async () => {} });
    assert.equal(bad.ok, false); assert.match(bad.error, /future/);
    const ok = await saveHiringOutcome(w.kv, { rep: MILTON, body: { action: 'call-outcome', id: w.id, outcome: 'connected', notes: 'Interested' } }, { recordActivity: async () => {} });
    assert.equal(ok.ok, true); assert.equal(ok.record.status, 'conversation'); assert.equal(ok.record.callOwner, 'milton@trystaffify.com');
    const again = await saveHiringOutcome(w.kv, { rep: MILTON, body: { action: 'call-outcome', id: w.id, outcome: 'no_answer', nextCallAt: new Date(Date.now() + 864e5).toISOString() } }, { recordActivity: async () => {} });
    assert.equal(again.ok, false);
});

test('the card re-checks every control before showing a number, including a client made since', async () => {
    const w = await readyCard();
    const gate = { allowed: true, required: true };
    const base = { kv: w.kv, isOptedOut: async () => false, clientCheck: async () => ({ status: 'clear' }), crmContact: async () => { throw Error('CRM contact missing'); }, crmStop, loadBad, isBad, queueState: async () => ({ records: [] }) };
    let b = await hiringBrief(w.kv, { id: w.id, caller: 'Milton', callerEmail: MILTON.email, shiftGate: gate }, base);
    assert.equal(b.status, 200); assert.equal(b.body.phone, '+13056360188'); assert.equal(b.body.callable, true);
    assert.match(b.body.dial.detail, /not a named person/);
    // Off shift: the card loads, the number does not.
    b = await hiringBrief(w.kv, { id: w.id, caller: 'Milton', callerEmail: MILTON.email, shiftGate: { allowed: false, required: true, message: 'Start your shift' } }, base);
    assert.equal(b.body.phone, null); assert.equal(b.body.dial, null);
    // The CRM cannot be read: no number, card kept.
    b = await hiringBrief(w.kv, { id: w.id, caller: 'Milton', callerEmail: MILTON.email, shiftGate: gate }, { ...base, crmContact: async () => { throw Error('HubSpot 503'); } });
    assert.equal(b.status, 503); assert.equal(b.body.phone, undefined); assert.equal((await getRecord(w.kv, w.id)).status, 'ready');
    // They became a client after the card was built: refused and out of the queue, history kept.
    b = await hiringBrief(w.kv, { id: w.id, caller: 'Milton', callerEmail: MILTON.email, shiftGate: gate }, { ...base, clientCheck: async () => ({ status: 'client' }) });
    assert.equal(b.status, 409); assert.equal(b.body.callable, false); assert.match(b.body.error, /client/);
    assert.equal((await getRecord(w.kv, w.id)).status, 'excluded');
});

test('live stops: an opt-out, a person who owns them in the CRM, an email thread at the company', async () => {
    const w = await readyCard();
    const rec = await getRecord(w.kv, w.id);
    const base = { kv: w.kv, isOptedOut: async () => false, clientCheck: async () => ({ status: 'clear' }), crmContact: async () => { throw Error('CRM contact missing'); }, crmStop, loadBad, isBad, queueState: async () => ({ records: [] }) };
    assert.deepEqual(await liveStops(rec, base), {});
    assert.match((await liveStops(rec, { ...base, isOptedOut: async q => q.phone === '+13056360188' })).stop, /do-not-contact/);
    assert.match((await liveStops(rec, { ...base, crmContact: async () => ({ properties: { rep_lifecycle_state: 'HUMAN_OWNED' } }) })).stop, /owns this conversation/);
    assert.match((await liveStops(rec, { ...base, queueState: async () => ({ records: [{ recipient: 'ceo@acme.com', status: 'human_reply_hold' }] }) })).stop, /email thread/);
    assert.ok((await liveStops(rec, { ...base, isOptedOut: async () => { throw Error('down'); } })).unavailable);
});

test('the call-first script never claims an email was sent', () => {
    const named = hiringCallScript({ caller: 'Milton', company: 'Acme', firstName: 'Dana', jobTitle: 'Customer Support Specialist', family: 'support', offshore: 'Latin America' });
    const anon = hiringCallScript({ caller: 'Milton', company: 'Acme', firstName: '', jobTitle: 'Customer Support Specialist', family: 'support' });
    for (const s of [named, anon]) {
        const spoken = [s.opener, s.reason, s.voicemail, ...s.questions, ...Object.values(s.tree).map(n => n.say || ''), ...s.objections.map(o => o.say)].join(' ');
        // The claims the email campaigns make ("We sent you over a few notes by email") and nothing like them.
        assert.doesNotMatch(spoken, /we sent|sent you (over|a few|some)|our (e-?mails?|notes)|e-?mailed you|notes by e-?mail|repl(y|ying) to (that|our) e-?mail/i);
        assert.doesNotMatch(spoken, /—/);
        for (const n of Object.values(s.tree)) if (n.log) assert.ok(['connected', 'callback', 'gatekeeper', 'timing', 'suppress'].includes(n.log));
    }
    assert.match(named.opener, /Hi Dana/); assert.match(anon.opener, /Who would be the right person/);
    assert.match(named.reason, /Latin America/);
});

// ---- the rest of the Hub sees these calls -------------------------------------------------------
test('hiring calls reach the daily report, the campaign counts and the dialer order', async () => {
    const w = await readyCard();
    await saveHiringOutcome(w.kv, { rep: MILTON, body: { action: 'call-outcome', id: w.id, outcome: 'voicemail', nextCallAt: new Date(Date.now() + 864e5).toISOString(), dialled: '+13056360188' } }, { recordActivity: async () => {} });
    const rows = await hiringReportRows(w.kv);
    const { entries } = hubEntriesFrom(rows, ['milton@trystaffify.com']);
    assert.equal(entries.length, 1); assert.equal(entries[0].campaignId, HIRING_ID); assert.equal(entries[0].dialledRecorded, true);
    const s = stats(rows, { motion: 'call' });
    assert.equal(s.called, 1); assert.equal(s.connectRate.n !== undefined || s.connectRate === null || typeof s.connectRate === 'object', true);
    // Hiring first among cards nobody has called.
    const fresh = callRow({ ...(await getRecord(w.kv, w.id)), id: 'hire:00000000000000aa', callOutcome: null, nextCallAt: null, callOwner: null, callHistory: [], job: { ...(await getRecord(w.kv, w.id)).job } }, 'x', NOW);
    const tobit = { id: 'tobit-1', campaignId: 'staffify-tobit-outreach', callReady: true, unclaimed: true, lastSentAt: '2026-10-01T00:00:00Z', callContact: { phone: '+13055551234', phoneStatus: 'business_listed' } };
    assert.equal(orderCallQueue([tobit, fresh], { now: NOW })[0].id, 'hire:00000000000000aa');
});

test('rep email: a hiring contact is found, and only after this rep has called them', async () => {
    const kv = fakeKv();
    const row = { id: 'hire:00000000000000bb', kind: 'hiring', callHistory: [] };
    assert.equal(await calledFirst(row, MILTON, kv), false);
    await kv.set('staffify:call-hold:hire:00000000000000bb', { by: 'milton@trystaffify.com', kind: 'calling' });
    assert.equal(await calledFirst(row, MILTON, kv), true);
    assert.equal(await calledFirst(row, { email: 'someone@else.com' }, kv), false);
    assert.equal(await calledFirst({ kind: 'queue' }, MILTON, kv), true, 'other campaigns are unchanged');
});

test('one card per employer: a second job board at the same confirmed website joins the first card', async () => {
    const w = world();
    const first = await processPosting(lever, {}, w.deps, null);
    assert.equal(first.verdict, 'ready');
    // The same employer on Greenhouse (an ATS migration), whose board content links to the same homepage
    // and whose careers page links back to that board.
    const gh = { ats: 'greenhouse', board: 'acmeinc', id: '7001234' };
    const json = {
        'https://boards-api.greenhouse.io/v1/boards/acmeinc/jobs/7001234': { status: 200, body: { title: 'Scheduling Coordinator', company_name: 'Acme', first_published: new Date(NOW - 2 * 864e5).toISOString(), location: { name: 'Remote' }, absolute_url: 'https://job-boards.greenhouse.io/acmeinc/jobs/7001234', content: '&lt;a href=&quot;https://www.acme.com/&quot;&gt;Acme&lt;/a&gt; remote role' } },
        'https://boards-api.greenhouse.io/v1/boards/acmeinc/jobs': { status: 200, body: { meta: { total: 3 } } },
        'https://boards-api.greenhouse.io/v1/boards/acmeinc': { status: 200, body: { name: 'Acme', content: '' } },
    };
    const pages = { 'https://acme.com': { url: 'https://www.acme.com/', html: '<a href="https://job-boards.greenhouse.io/acmeinc">Careers</a>', text: 'Acme' } };
    const deps = { ...w.deps, getJson: async u => json[u] || w.deps.getJson(u), getPage: async u => pages[u] || w.deps.getPage(u) };
    const second = await processPosting(gh, {}, deps, null);
    assert.equal(second.verdict, 'merged'); assert.equal(second.reason, 'same_domain'); assert.equal(second.id, first.id);
    const recs = await allRecords(w.kv);
    assert.equal(recs.length, 1, 'no duplicate caller card');
    assert.equal(recs[0].jobs.length, 2);
});

test('a refused card hides dialled numbers and numbers in notes from a caller off shift', async () => {
    const w = await readyCard();
    await saveHiringOutcome(w.kv, { rep: MILTON, body: { action: 'call-outcome', id: w.id, outcome: 'gatekeeper', notes: 'Front desk said try 305-636-0199 after 3', nextCallAt: new Date(Date.now() + 3600e3).toISOString(), dialled: '+13056360188' } }, { recordActivity: async () => {} });
    const base = { kv: w.kv, isOptedOut: async () => false, clientCheck: async () => ({ status: 'unknown' }), crmContact: async () => { throw Error('CRM contact missing'); }, crmStop, loadBad, isBad, queueState: async () => ({ records: [] }) };
    const off = { allowed: false, required: true, message: 'Start your shift' };
    const b = await hiringBrief(w.kv, { id: w.id, caller: 'Milton', callerEmail: MILTON.email, shiftGate: off }, base);
    assert.equal(b.status, 503);
    const text = JSON.stringify(b.body);
    assert.doesNotMatch(text, /3056360188|636-0199|636-0188/);
    assert.equal(b.body.callHistory[0].dialled, null);
});

// ---- Google Jobs: the loop that does not run dry (Paul, 2026-10-28) ------------------------------
const listing = (over = {}) => ({ job_id: 'j1', title: 'Administrative Assistant - Front Desk', company_name: 'Royal Electric', location: 'Dallas, TX', via: 'Indeed',
    extensions: ['2 days ago', 'Full-time'], description: 'Answer phones, schedule service calls and keep the office running.', apply_options: [{ title: 'Indeed', link: 'https://www.indeed.com/viewjob?jk=1' }], share_link: 'https://www.google.com/search?ibp=htl;jobs#j1', ...over });
const ROYAL = { title: 'Royal Electrical Services', type: 'Contractor in Dallas, Texas', website: 'https://www.royalelect.com/', phone: '(945) 218-4003', address: '4518 Ash Ln, Dallas, TX 75223', link: 'https://www.google.com/search?q=Royal+Electric+Dallas+TX' };

test('Google Jobs listings: customer service, sales and admin seats from the last week, no agencies or big employers', () => {
    assert.equal(qualifyJob(listing(), NOW).ok, true);
    assert.equal(qualifyJob(listing({ title: 'Inside Sales Representative' }), NOW).family, 'sales');
    assert.equal(qualifyJob(listing({ title: 'Appointment Setter' }), NOW).family, 'sales');
    assert.equal(qualifyJob(listing({ title: 'Dispatcher and Customer Service Representative' }), NOW).family, 'support');
    assert.equal(qualifyJob(listing({ extensions: ['9 days ago'] }), NOW).reason, 'stale_post');
    assert.equal(qualifyJob(listing({ extensions: ['Full-time'] }), NOW).reason, 'undated_post', 'no date is not assumed fresh');
    assert.equal(qualifyJob(listing({ company_name: 'Randstad USA' }), NOW).reason, 'competitor');
    assert.equal(qualifyJob(listing({ company_name: 'Frontline Source Group' }), NOW).reason, 'competitor');
    assert.equal(qualifyJob(listing({ company_name: 'Spade Recruiting' }), NOW).reason, 'competitor');
    assert.equal(qualifyJob(listing({ company_name: 'UT Southwestern Medical Center', apply_options: [{ link: 'https://jobs.utsouthwestern.edu/x' }] }), NOW).reason, 'institution');
    assert.equal(qualifyJob(listing({ company_name: 'City of Dallas' }), NOW).reason, 'institution');
    // Small businesses that only carry the word stay in.
    for (const c of ['Lakewood Animal Hospital', 'Orange County Plumbing Inc', 'University Park Dental', 'The Roofing Authority', 'College Hunks Hauling Junk & Moving', 'Dallas Family Medical Center']) assert.equal(qualifyJob(listing({ company_name: c }), NOW).ok, true, c);
    assert.equal(qualifyJob(listing({ apply_options: [{ link: 'https://quest.wd1.myworkdayjobs.com/x' }] }), NOW).reason, 'large_employer');
    assert.equal(qualifyJob(listing({ title: 'Customer Service Representative - Store (PT)' }), NOW).reason, 'role_not_fillable');
    // A phone seat in a field services department is still a phone seat (review, 2026-10-28).
    assert.equal(qualifyJob(listing({ title: 'Customer Service Representative - Field Services' }), NOW).family, 'support');
    assert.equal(qualifyJob(listing({ title: 'Account Executive' }), NOW).reason, 'role_not_fillable');
    // An office job is fine: the seat is one a remote person does. A licence is not.
    assert.equal(qualifyJob(listing({ description: 'Must report to the office daily.' }), NOW).ok, true);
    assert.equal(qualifyJob(listing({ description: 'Must hold a licensed insurance agent credential.' }), NOW).reason, 'hard_restriction');
    assert.equal(jobAgeDays(['5 hours ago']), 0); assert.equal(jobAgeDays(['30+ days ago']), 30);
});

test('the searches rotate every role through every city, never the same city twice in a row', () => {
    assert.equal(JOB_QUERIES.length, JOB_TERMS.length * METROS.length);
    assert.equal(new Set(JOB_QUERIES.map(q => q.q + '@' + q.location)).size, JOB_QUERIES.length);
    for (let i = 1; i < JOB_QUERIES.length; i++) assert.notEqual(JOB_QUERIES[i].location, JOB_QUERIES[i - 1].location);
    assert.ok(JOB_QUERIES.every(q => /in the last 3 days$/.test(q.q)));
    assert.ok(new Set(JOB_QUERIES.slice(0, JOB_TERMS.length).map(q => q.term)).size === JOB_TERMS.length, 'the first pass covers every role');
});

test('the employer is matched to its Google business listing by name and state, not by one shared word', () => {
    assert.equal(profileMatches('Royal Electric', ROYAL, 'Dallas, TX').ok, true);
    assert.equal(profileMatches('Royal Electric', { ...ROYAL, title: 'Royal Plumbing' }, 'Dallas, TX').ok, false);
    assert.equal(profileMatches('Royal Electric', { ...ROYAL, address: '12 Main St, Tulsa, OK 74103' }, 'Dallas, TX').ok, false);
    assert.equal(profileMatches('Royal Electric', { ...ROYAL, address: null }, 'Dallas, TX').ok, false, 'no address, no proof of place');
    assert.equal(profileMatches('Royal Electric', {}, 'Dallas, TX').ok, false);
    assert.equal(stateOf('Phoenix, AZ (+3 others)'), 'AZ');
});

function jobsWorld(over = {}) {
    const w = world();
    let lookups = 0, phoneLookups = 0;
    w.deps.businessProfile = async (company, location, budget) => { if (!await budget.take()) return { error: 'no budget', noBudget: true }; lookups++; return over.profile === undefined ? ROYAL : over.profile; };
    w.deps.findSitePhone = async () => { phoneLookups++; return null; };
    w.deps.findContact = async d => (d === 'royalelect.com' ? { name: 'Maria Lopez', role: null, email: 'maria@royalelect.com' } : {});
    w.deps.serpJobs = async () => ({ jobs: over.jobs || [listing()] });
    return { ...w, counts: () => ({ lookups, phoneLookups }) };
}

test('a Google Jobs listing becomes a card with the listing number, the job and the contact, each with its source', async () => {
    const w = jobsWorld();
    const r = await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    assert.equal(r.verdicts.ready, 1, JSON.stringify(r.reasons));
    const rec = (await allRecords(w.kv))[0];
    assert.equal(rec.job.source, 'google_jobs'); assert.equal(rec.job.city, 'Dallas'); assert.equal(rec.job.via, 'Indeed');
    assert.equal(rec.job.ageDays, 2); assert.equal(rec.job.url, 'https://www.google.com/search?ibp=htl;jobs#j1');
    assert.equal(rec.company.identity.how, 'google_business_profile'); assert.equal(rec.company.identity.listingName, 'Royal Electrical Services');
    assert.equal(rec.company.domain, 'royalelect.com');
    assert.equal(rec.phone.number, '+19452184003'); assert.equal(rec.phone.source, 'Google business listing');
    assert.equal(rec.contact.email, 'maria@royalelect.com');
    assert.equal(w.counts().phoneLookups, 0, 'the listing gave the number; no site crawl needed');
    assert.equal(hiringCallReady(rec, NOW), true);
    assert.match(rec.brief.summary, /Google Jobs \(Indeed\)/);
    assert.equal(r.searchBudget.used, 2, 'one job search and one listing lookup');
});

test('a listing whose employer cannot be matched to Google goes to research and is not called', async () => {
    const w = jobsWorld({ profile: { ...ROYAL, title: 'Royal Plumbing' } });
    const r = await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    assert.equal(r.verdicts.backlog, 1); assert.equal(r.reasons.identity_unresolved, 1);
    assert.equal((await allRecords(w.kv)).length, 0);
    assert.equal(w.counts().phoneLookups, 0);
});

test('listings beyond the run cap, or beyond the day\'s search budget, wait in pending untouched', async () => {
    const jobs = [listing(), listing({ job_id: 'j2', company_name: 'DEX Imaging LLC', location: 'Tampa, FL', title: 'Dispatcher and Customer Service Representative' }), listing({ job_id: 'j3', company_name: 'Vickery Development', location: 'Garland, TX', title: 'Administrative Assistant' })];
    const w = jobsWorld({ jobs });
    const first = await runHiring(w.deps, { maxSearches: 1, maxCandidates: 1, refresh: 0 });
    assert.equal(first.listings.queued, 3);
    assert.equal(first.pendingAfter, 2, 'two found listings are kept for the next run');
    // A day with no searches left: nothing is processed, nothing is marked as a failed attempt.
    const broke = await runHiring({ ...w.deps, serpAccount: async () => ({ left: 250 }) }, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    assert.equal(broke.searchBudget.allowedThisRun, 0);
    assert.equal(broke.waitingForBudget, 1);
    const pend = Object.values(await w.kv.hgetall(HK.pending)).map(JSON.parse);
    assert.equal(pend.length, 2); assert.ok(pend.every(e => e.attempts === 0));
});

test('a Google Jobs card expires two weeks after posting, keeping any promised callback', async () => {
    const w = jobsWorld();
    await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    const rec = (await allRecords(w.kv))[0];
    const later = NOW + (MAX_AGE_DAYS - 2 + 1) * 864e5;  // posted 2 days before NOW
    assert.equal(hiringCallReady(rec, later - 2 * 864e5), true);
    assert.equal(hiringCallReady(rec, later + 864e5), false);
    const out = await refreshReady({ ...w.deps, now: later + 864e5 }, { limit: 5 });
    assert.equal(out.stale, 1);
    assert.equal((await getRecord(w.kv, rec.id)).job.state, 'stale');
});

test('the hiring script offers to run their remote hiring, names the city, and never claims an email', () => {
    const s = hiringCallScript({ caller: 'Milton', company: 'Royal Electric', firstName: '', jobTitle: 'Administrative Assistant', family: 'admin', city: 'Dallas' });
    assert.match(s.opener, /in Dallas/);
    assert.match(s.reason, /run the hiring for remote customer service, sales and admin roles/);
    const spoken = [s.opener, s.reason, s.voicemail, ...s.questions, ...Object.values(s.tree).map(n => n.say || '')].join(' ');
    assert.doesNotMatch(spoken, /we sent|sent you (over|a few|some)|our (e-?mails?|notes)|e-?mailed you/i);
    assert.doesNotMatch(spoken, /—/);
});

// ---- the review of 2026-10-28: each confirmed finding, pinned ------------------------------------
test('every searched role term is a seat the rules accept, and office seats next to field work stay in', () => {
    for (const [, term] of JOB_TERMS) assert.ok(roleFamily(term.replace(/\b\w/g, c => c.toUpperCase())), term);
    for (const t of ['Help Desk Technician', 'Field Service Dispatcher', 'Delivery Dispatcher', 'Customer Service Representative - Driver Support', 'Server Support Specialist', 'Office Administrator', 'Lead Generation Specialist']) assert.ok(roleFamily(t), t);
    for (const t of ['HVAC Technician', 'Driver', 'Outside Sales Representative', '911 Dispatcher', 'Front Desk Agent', 'Door to Door Sales Representative']) assert.equal(roleFamily(t), null, t);
    assert.equal(qualifyJob(listing({ title: 'Sales Representative', company_name: 'Park Place Motors', description: 'Sell new and pre-owned vehicles on our lot' }), NOW).reason, 'field_sales');
    assert.equal(qualifyJob(listing({ title: 'Sales Representative', company_name: 'Acme Roofing', description: 'Call inbound leads and book appointments by phone' }), NOW).ok, true);
    assert.equal(qualifyJob(listing({ title: 'Insurance Customer Service Representative', description: 'Must hold a P&C license' }), NOW).reason, 'hard_restriction');
});

test('staffing agencies and BPOs are caught by name, and big brands by their own careers site', () => {
    for (const c of ['Get It Recruit - Customer Service', 'ProStaff', 'PrideStaff', 'ManpowerGroup', 'Kelly', 'Jobot', 'CyberCoders', 'Sutherland', 'TempStaff', 'Advantage Resourcing']) assert.equal(qualifyJob(listing({ company_name: c }), NOW).reason, 'competitor', c);
    assert.equal(qualifyJob(listing({ company_name: 'Spectrum', apply_options: [{ link: 'https://jobs.spectrum.com/job/1' }] }), NOW).reason, 'large_employer');
    assert.equal(qualifyJob(listing({ company_name: 'Amazon', apply_options: [{ link: 'https://amazon.jobs/en/jobs/1' }] }), NOW).reason, 'large_employer');
});

test('the business match needs two distinctive words or the exact name, a state, and never a generic name', () => {
    const at = a => ({ address: a + ', Dallas, TX 75201' });
    assert.equal(profileMatches('Elite Services LLC', { title: 'Elite Auto Repair', ...at('1 Main St') }, 'Dallas, TX').ok, false);
    assert.equal(profileMatches('Premier Solutions Group', { title: 'Premier Plumbing & Drain', ...at('1 Main St') }, 'Dallas, TX').ok, false);
    assert.equal(profileMatches('Confidential', { title: 'Confidential Shredding Services', ...at('1 Main St') }, 'Dallas, TX').ok, false);
    assert.equal(profileMatches('Dental Office', { title: 'Smile Dental Office', ...at('1 Main St') }, 'Dallas, TX').ok, false);
    assert.equal(profileMatches('Smith Dental', { title: 'Smithfield Dental Care', ...at('1 Main St') }, 'Dallas, TX').ok, false);
    assert.equal(profileMatches('Spectrum', { title: 'Spectrum Store', ...at('5000 Belt Line Rd') }, 'Dallas, TX').ok, false);
    assert.equal(profileMatches('Precision Plumbing', { title: 'Precision Plumbing Inc', address: '1 Main St, Phoenix, AZ 85001' }, 'Anywhere').ok, false, 'no state on the job, nothing to confirm');
    assert.equal(profileMatches('QED', { title: 'QED', address: '1 Main St, Mesa, AZ 85201' }, 'Mesa, AZ').ok, true, 'an exact one-word name in the same state');
    assert.equal(profileMatches('DEX Imaging LLC', { title: 'DEX Imaging', address: '5109 W Lemon St, Tampa, FL 33609' }, 'Tampa, FL').ok, true);
});

test('a listing kept for later ages in real days: a retry a week on is stale, not "2 days ago"', async () => {
    const kept = compactListing(listing(), NOW);
    assert.ok(kept.posted_at);
    assert.equal(qualifyJob(kept, NOW).ok, true);
    assert.equal(qualifyJob(kept, NOW + 6 * 864e5).reason, 'stale_post', 'posted 8 days before the retry');
    // A card made from a listing that waited three days carries the real posting date.
    const w = jobsWorld();
    await addPending(w.kv, { kind: 'gjob', key: 'gjobs:waited', listing: kept }, { discoveredBy: 'test' }, NOW);
    const later = NOW + 3 * 864e5;
    await runHiring({ ...w.deps, now: later }, { discover: false, refresh: 0 });
    const rec = (await allRecords(w.kv))[0];
    assert.equal(rec.job.ageDays, 5); assert.equal(rec.job.postedAt, kept.posted_at);
});

test('a wrong number on a Google Jobs card is retried with a number from their website, and never pins the retry step', async () => {
    const w = jobsWorld();
    let site = 0;
    w.deps.findSitePhone = async () => { site++; return { phone: '+12145550190'.replace('555', '636'), alternates: [], sourceUrl: 'https://www.royalelect.com/contact', checkedAt: new Date(NOW).toISOString() }; };
    await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    const rec = (await allRecords(w.kv))[0];
    await saveHiringOutcome(w.kv, { rep: MILTON, body: { action: 'call-outcome', id: rec.id, outcome: 'wrong_number', dialled: '+19452184003' } }, { recordActivity: async () => {} });
    const entry = (await allBacklog(w.kv)).find(b => b.reason === 'wrong_number');
    assert.ok(entry.listing, 'the listing travels with the research entry');
    // The research entry is due from the moment it is saved (saved at the real clock).
    const T = Date.now() + 3600e3;
    const r = await runHiring({ ...w.deps, now: T }, { discover: false, refresh: 0 });
    assert.equal(r.verdicts.ready, 1, JSON.stringify(r.reasons));
    const fixed = await getRecord(w.kv, rec.id);
    assert.equal(fixed.status, 'ready'); assert.equal(fixed.phone.number, '+12146360190'); assert.equal(fixed.phone.source, 'business website');
    assert.equal(fixed.callHistory.length, 1, 'history kept'); assert.ok(site >= 1);
    // An entry with nothing to retry is closed, so it cannot hold one of the four retry slots.
    await putBacklogStore(w.kv, { id: 'hire:00000000000000dd', reason: 'wrong_number', state: 'open', nextTryAt: new Date(T).toISOString(), job: { url: 'https://www.google.com/search?ibp=htl;jobs#x' } });
    await runHiring({ ...w.deps, now: T + 3600e3 }, { discover: false, refresh: 0 });
    assert.equal((await allBacklog(w.kv)).find(b => b.id === 'hire:00000000000000dd').state, 'closed');
});

test('an employer that posts again after its card aged out gets the new job on its card, offered again', async () => {
    const w = jobsWorld();
    await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    const rec = (await allRecords(w.kv))[0];
    const later = NOW + 20 * 864e5;
    assert.equal(hiringCallReady(rec, later), false);
    w.deps.serpJobs = async () => ({ jobs: [listing({ job_id: 'j9', title: 'Receptionist', extensions: ['1 day ago'] })] });
    const r = await runHiring({ ...w.deps, now: later }, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    assert.equal(r.reasons.reopened, 1);
    const again = await getRecord(w.kv, rec.id);
    assert.equal(again.job.title, 'Receptionist'); assert.equal(hiringCallReady(again, later), true);
    assert.equal((await allRecords(w.kv)).length, 1, 'still one card');
});

test('name variants and a shared number make one card, not three', async () => {
    assert.equal(companyKey('Royal Electric', 'Dallas, TX'), companyKey('Royal Electric, LLC', 'Dallas, TX'));
    const w = jobsWorld({ profile: { ...ROYAL, website: null } });
    w.deps.serpJobs = async () => ({ jobs: [listing(), listing({ job_id: 'j2', share_link: 'https://www.google.com/search?ibp=htl;jobs#j2', company_name: 'Royal Electric, LLC', title: 'Receptionist' }), listing({ job_id: 'j3', share_link: 'https://www.google.com/search?ibp=htl;jobs#j3', company_name: 'Royal Electrical Services', title: 'Dispatcher' })] });
    await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    const recs = await allRecords(w.kv);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].jobs.length, 3);
    assert.ok(await w.kv.hget(HK.companies, phoneKey('+19452184003')));
});

test('an unreadable daily search counter spends nothing', async () => {
    const w = jobsWorld();
    const kv = { ...w.kv, get: async k => { if (String(k).startsWith('staffify:hiring:serp:')) throw Error('store down'); return w.kv.get(k); } };
    const r = await runHiring({ ...w.deps, kv }, { maxSearches: 2, maxCandidates: 5, refresh: 0 });
    assert.equal(r.searchBudget.allowedThisRun, 0); assert.equal(r.searches.length, 0); assert.ok(r.searchBudgetError);
});
