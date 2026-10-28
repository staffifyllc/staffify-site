// Hiring now: the call-first campaign built from current job posts. Every outside service is a stub;
// nothing here calls, texts, emails or spends a credit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sectorExcluded, postEvidence, listingEvidence, addressCity, qualifyLead, leadKey, leadDomain, leadPostedAt, leadStatedDate, leadDateLabel, HK, HIRING_ID, FRESH_MS, MAX_AGE_DAYS, JOB_QUERIES, JOB_TERMS, METROS, qualifyJob, profileMatches, jobAgeDays, stateOf, companyKey, phoneKey, parseAts, roleFamily, qualifyPosting, restrictions, hiringCallReady, applyOutcome, callRow, linksToBoard, boardHomepage, getRecord, allRecords, allBacklog, putRecord, hiringReportRows } from '../api/_hiring-intent.js';
import { processPosting, runHiring, refreshReady, addPending, PENDING_MAX_ATTEMPTS, compactListing, localNumber, preferLocal, holdCards, alignNumbers, siteCheck, processLead, fillResearch, ownerLines, ownerCells, cellMatch, cellsOf, RR_DAILY_CAP, RR_TRIED } from '../api/_hiring-run.js';
import { saveHiringOutcome, hiringBrief, liveStops, saveHiringContactEmail } from '../api/_hiring-calls.js';
import { templatesFor, HIRING_TEMPLATES } from '../api/_rep-email.js';
import { putBacklog as putBacklogStore } from '../api/_hiring-intent.js';
import { hiringCallScript, spokenRole, articleFor } from '../api/_call-scripts.js';
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
    // Paul, 2026-10-28: ask for the person first, by name when we have one.
    // and, later that day, to name the job first: "can the beginning of the call script mention the job we're calling about?"
    assert.match(named.opener, /^Hi, this is Milton with Staffify\. I'm calling about the Customer Support Specialist job you posted\. I'm looking to speak with Dana, or the person in charge of hiring\. Is that you\?$/);
    assert.match(anon.opener, /I'm calling about the Customer Support Specialist job you posted\. I'm looking to speak with the person in charge of hiring for it\./);
    assert.match(named.tree.intro.say, /this is a cold call\. Do you have a quick second\?/);
    // Paul, that evening, word for word with the role swapped in.
    assert.equal(named.reason, "The reason I'm calling is I saw you're hiring a Customer Support Specialist. We help companies hire dedicated Customer Support Specialists from Latin America and the Philippines, and we handle the recruiting, vetting, and ongoing management. I wanted to see if you'd be open to a quick conversation with our team so we can learn more about the role and see if we can put a few great candidates in front of you.");
    assert.deepEqual(named.tree.reason.choices[0], ['Yes, open to it', 'close'], 'a yes goes to booking the conversation');
    assert.match(named.tree.reason.note, /open to candidates in Latin America/);
    assert.equal(named.tree.open.choices[0][1], 'intro');
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
    assert.match(s.reason, /I saw you're hiring an Administrative Assistant\. We help companies hire dedicated Administrative Assistants from Latin America and the Philippines/);
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
    // With a website: since 2026-10-28 a listing with no website is research, never a card (listingEvidence).
    const w = jobsWorld();
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

// ---- the first live Google Jobs run, 2026-10-28: what it let through, pinned ----------------------
test('live-run catches: a staffing firm, a prosecutor, a school district, a tax board, mass recruiting ads', () => {
    for (const c of ['Green Key Resources', "Cook County State's Attorney's Office", 'Alvin ISD', 'California Franchise Tax Board']) assert.ok(qualifyJob(listing({ company_name: c }), NOW).ok === false, c);
    for (const t of ['Entry-Level Administrative Assistant - Chicago, IL', 'Customer Service Sales Representative - Now Hiring']) assert.equal(qualifyJob(listing({ title: t }), NOW).reason, 'recruiting_ad', t);
    for (const c of ['Frontline International, Inc.', 'Haga Kommer, Ltd.', 'Central Credit Union of Illinois']) assert.equal(qualifyJob(listing({ company_name: c }), NOW).ok, true, c);
    assert.equal(profileMatches("Cook County State's Attorney's Office", { title: 'State Attorney', address: 'Markham, IL 60428' }, 'Markham, IL').ok, false, 'two shared words out of five is not the same name');
});

test('a big employer by Google\'s own panel is left out before any contact credit is spent', async () => {
    const w = jobsWorld({ profile: { ...ROYAL, size: { employees: 2400, listed: false, parent: null } } });
    let contacts = 0; w.deps.findContact = async () => { contacts++; return {}; };
    const r = await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    assert.equal(r.reasons.large_employer, 1); assert.equal((await allRecords(w.kv)).length, 0); assert.equal(contacts, 0);
});

test('cards made under older rules are re-checked every run: a staffing firm or a public body leaves the list', async () => {
    const w = jobsWorld();
    await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    const rec = (await allRecords(w.kv))[0];
    await putRecord(w.kv, { ...rec, company: { ...rec.company, name: 'Green Key Resources' } });
    const owned = { ...rec, id: 'hire:00000000000000ee', company: { ...rec.company, name: "Cook County State's Attorney's Office" }, callOwner: MILTON.email, callOutcome: 'callback', nextCallAt: new Date(NOW + 3600e3).toISOString() };
    await putRecord(w.kv, owned);
    const out = await refreshReady(w.deps, { limit: 5 });
    assert.equal(out.excluded, 1);
    assert.equal((await getRecord(w.kv, rec.id)).status, 'excluded');
    assert.equal((await getRecord(w.kv, owned.id)).status, 'ready', 'a card a caller owns is left for a person to judge');
});

test('a hospital found through its own Google listing is a large employer, not a card', async () => {
    const w = jobsWorld({ profile: { title: 'Royal Electrical Services', type: 'Hospital', website: 'https://www.royalelect.com/', phone: '(945) 218-4003', address: '4518 Ash Ln, Dallas, TX 75223' } });
    const r = await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    assert.equal(r.reasons.large_employer, 1); assert.equal((await allRecords(w.kv)).length, 0);
    const ok = jobsWorld();
    await runHiring(ok.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    const rec = (await allRecords(ok.kv))[0];
    assert.equal(rec.job.usState, 'TX'); assert.equal(rec.job.state, undefined, 'the job state is open/closed/stale, never a US state');
});

test('old cards are held to the current rules: named large employers and a hospital by its cached listing type leave the list', async () => {
    const w = jobsWorld();
    await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    const base = (await allRecords(w.kv))[0];
    const make = async (id, name, extra = {}) => { await putRecord(w.kv, { ...base, id, company: { ...base.company, name }, ...extra }); return id; };
    const unity = await make('hire:00000000000000a1', 'UnityPoint Health');
    const cs = await make('hire:00000000000000a2', 'C&S Wholesale Grocers');
    const hosp = await make('hire:00000000000000a3', 'Lakeview Care Partners', { job: { ...base.job, location: 'Dallas, TX' } });
    await w.kv.set(HK.profile(companyKey('Lakeview Care Partners', 'Dallas, TX')), { profile: { title: 'Lakeview Care Partners', type: 'Hospital', address: 'Dallas, TX 75201' }, expiresAt: new Date(NOW + 864e5).toISOString() });
    const out = await refreshReady(w.deps, { limit: 5 });
    assert.equal(out.excluded, 3);
    for (const id of [unity, cs, hosp]) { const r = await getRecord(w.kv, id); assert.equal(r.status, 'excluded'); assert.equal(r.exclusion.reason, 'large_employer'); assert.equal(r.job.title, base.job.title, 'history and metadata kept'); }
    assert.equal((await getRecord(w.kv, base.id)).status, 'ready', 'the small business stays');
    assert.equal(qualifyJob(listing({ company_name: 'Byram Healthcare' }), NOW).reason, 'large_employer');
});

test('an in-office ad is described as one on the card, never as a remote opening', async () => {
    const w = jobsWorld();
    await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    const rec = (await allRecords(w.kv))[0];
    assert.equal(rec.job.workplace, 'onsite');
    assert.match(rec.brief.need, /posted it as an in-office job, not a remote opening/);
    const b = await hiringBrief(w.kv, { id: rec.id, caller: 'Milton', callerEmail: MILTON.email, shiftGate: { allowed: true, required: true } }, { kv: w.kv, isOptedOut: async () => false, clientCheck: async () => ({ status: 'clear' }), crmContact: async () => { throw Error('CRM contact missing'); }, crmStop, loadBad, isBad, queueState: async () => ({ records: [] }) });
    assert.match(b.body.why, /Posted as an in-office job: offer a remote person for the seat, do not call it a remote opening/);
});

test('the number the employer lists next to the job\'s city goes first; the Google number stays as an alternate', async () => {
    const pages = {
        'https://www.damotech.com/': { url: 'https://www.damotech.com/', html: '<a href="/contact-us">Contact</a> 1 (877) 990-3266', text: 'Damotech 1 (877) 990-3266' },
        'https://www.damotech.com/contact-us': { url: 'https://www.damotech.com/contact-us', html: '', text: 'TOLL FREE Number: 1 (877) 990-3266 Lockport, IL, Sales (Mac Rak): 815-723-7400 Moberly, MO, Manufacturing: 660-372-1885' },
    };
    const getPage = async u => { const p = pages[u]; if (!p) throw Error('no'); return p; };
    const loc = await localNumber({ website: 'https://www.damotech.com/', city: 'Lockport', getPage });
    assert.equal(loc.phone, '+18157237400'); assert.equal(loc.sourceUrl, 'https://www.damotech.com/contact-us'); assert.match(loc.context, /Lockport/);
    assert.equal(await localNumber({ website: 'https://www.damotech.com/', city: 'Tampa', getPage }), null, 'no number next to the city: nothing changes');
    const p = preferLocal({ number: '+18553997225', alternates: [], source: 'Google business listing' }, loc);
    assert.equal(p.number, '+18157237400'); assert.deepEqual(p.alternates, ['+18553997225']); assert.equal(p.previous.number, '+18553997225');
    // An existing card is updated once by the refresh pass, keeping the old number as an alternate.
    const w = jobsWorld();
    await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    const rec = (await allRecords(w.kv))[0];
    await putRecord(w.kv, { ...rec, company: { ...rec.company, website: 'https://www.damotech.com/' }, job: { ...rec.job, city: 'Lockport' }, phone: { ...rec.phone, localCheckedAt: undefined } });
    const out = await refreshReady({ ...w.deps, getPage }, { limit: 5 });
    assert.equal(out.localNumbers, 1);
    const after = await getRecord(w.kv, rec.id);
    assert.equal(after.phone.number, '+18157237400'); assert.ok(after.phone.alternates.includes('+19452184003'));
    const again = await refreshReady({ ...w.deps, getPage }, { limit: 5 });
    assert.equal(again.localNumbers || 0, 0, 'looked for once, not every run');
});

test('a person\'s hold takes only the named ready cards off the list, keeps owner and history, and is dry unless written', async () => {
    const kv = fakeKv();
    const card = (id, extra = {}) => ({ id, campaignId: HIRING_ID, status: 'ready', company: { name: 'Co ' + id, board: 'gco:co' + id.slice(-2) + ':fl' }, job: { title: 'CSR', location: 'Tampa, FL' }, phone: { number: '+18135550100' }, callOwner: null, callHistory: [], ...extra });
    await putRecord(kv, card('hire:00000000000000a1'));
    await putRecord(kv, card('hire:00000000000000a2', { callOwner: 'milton@trystaffify.com', callHistory: [{ outcome: 'no_answer' }] }));
    await putRecord(kv, card('hire:00000000000000a3', { status: 'conversation' }));
    await putRecord(kv, card('hire:00000000000000a4'));
    const holds = [
        { id: 'hire:00000000000000a1', action: 'exclude', reason: 'store_floor_role', detail: 'register work', company: 'large' },
        { id: 'hire:00000000000000a2', action: 'hold', reason: 'branch_listing', detail: 'a store number' },
        { id: 'hire:00000000000000a3', action: 'exclude', reason: 'large_employer', detail: 'x' },
    ];
    const dry = await holdCards(kv, { holds, by: 'test', now: NOW });
    assert.equal((await getRecord(kv, 'hire:00000000000000a1')).status, 'ready', 'a dry run changes nothing');
    assert.deepEqual(dry.map(r => r.to || r.why), ['excluded', 'research', 'already conversation']);
    const out = await holdCards(kv, { holds, write: true, by: 'test', now: NOW });
    const a1 = await getRecord(kv, 'hire:00000000000000a1'), a2 = await getRecord(kv, 'hire:00000000000000a2');
    assert.equal(a1.status, 'excluded'); assert.equal(a1.exclusion.reason, 'store_floor_role'); assert.equal(a1.exclusion.by, 'test');
    assert.equal(a2.status, 'research'); assert.equal(a2.hold.reason, 'branch_listing');
    assert.equal(a2.callOwner, 'milton@trystaffify.com', 'the owner stays'); assert.equal(a2.callHistory.length, 1, 'the history stays');
    assert.equal((await getRecord(kv, 'hire:00000000000000a3')).status, 'conversation', 'a conversation is left for a person');
    assert.equal((await getRecord(kv, 'hire:00000000000000a4')).status, 'ready', 'an unnamed card is untouched');
    assert.equal(JSON.parse(await kv.hget(HK.companies, 'gco:coa1:fl')).verdict, 'large');
    assert.equal(hiringCallReady(a1, NOW) || hiringCallReady(a2, NOW), false, 'neither is offered');
    assert.deepEqual(out.map(r => r.done), [true, true, false]);
});

// ---- PM, 2026-10-28: admission on evidence, not title keywords ----------------------------------
// Short excerpts of the morning's real leaks, and of cards that must stay.
const POSTS = {
    walgreens: 'Registers sales on assigned cash register, provides customers with checkout service. Keeps counters and shelves clean and well merchandised. Checks in merchandise as directed by store manager or shift leader.',
    circleK: 'Store 2721229. You will greet customers, run the register, cashier, and work around the store to maintain store appearance.',
    kors: 'Thrive in a fast-paced store environment. Perform store tasks. Keep selling floor and stock room neat. POS experience.',
    breakthru: 'Rotate through a number of different territories. Calls on accounts and covers daily routes. Assist the Merchandising Department. Restocking shelves and delivering products.',
    hospital: 'Assist in arranging for admission of patients. Maintain communication with Utilization Review and the business office.',
    cbv: 'A not-for-profit community caring for older adults. We are a CMS five star rated community, here for our residents and their families.',
    molina: 'Provides support to Molina members and providers. Supports Medicaid, Medicare and/or Marketplace lines of business. Provider portal and member eligibility questions.',
    att: 'Be the voice of AT&T - a global leader in communications and technology.',
    breakthruPortal: 'Are you a current Associate? To be considered, you must submit your application through the internal Career Portal (Jobs Hub).',
    painIntake: 'Schedule video appointments between providers and patients, confirm details by phone and manage the scheduling system.',
    damotech: 'Maintain installation schedules, confirm dates with customers and installers by phone, coordinate shipments and keep records in ClickUp.',
    lawIntake: 'Answer intake calls from potential clients, schedule consultations with attorneys and keep the case management system current.',
    dispatch: 'Schedule technicians in the field, plan daily routes for the crew and answer customer calls. Reliable transportation needed.',
};
test('the duties and the employer in the post decide, not the title: the morning\'s leaks are refused before any search', () => {
    const q = (title, description, company = 'Some Co') => qualifyJob(listing({ title, description, company_name: company }), NOW);
    assert.equal(q('Customer Service Associate', POSTS.walgreens, 'Walgreens').reason, 'store_floor_role');
    assert.equal(q('Customer Service Representative', POSTS.circleK, 'Circle K').reason, 'store_floor_role');
    assert.equal(q('Sales Development Representative', POSTS.breakthru, 'Breakthru Beverage Group').ok, false);
    assert.equal(q('Intake Coordinator', POSTS.hospital, 'Hospital for Behavioral Medicine').reason, 'institutional_clinical');
    assert.equal(q('Executive Assistant', POSTS.cbv, 'Central Baptist Village').reason, 'institutional_clinical');
    assert.equal(q('Call Center Representative', POSTS.molina, 'Molina Healthcare').reason, 'institutional_clinical');
    // Puffery is not evidence: AT&T's own post passes this check, and its store-page Google listing holds it (listingEvidence).
    assert.equal(q('Call Center Customer Service Representative', POSTS.att, 'AT&T').ok, true);
    assert.equal(q('Call Center Representative', 'Join us at Molina Healthcare (NYSE: MOH).', 'Molina').reason, 'large_employer', 'a stock ticker is the employer describing itself');
    assert.equal(q('Account Coordinator', 'Our clients range from local shops to Fortune 500 brands, and we ship to all 50 states.', 'Small Agency').ok, true, 'big clients do not make a big employer');
    assert.equal(q('Inside Sales Representative', 'Ignite your career at Builders FirstSource, America\u2019s largest supplier of building materials. The #1 name in our industry.', 'Builders FirstSource').reason, 'large_employer', 'the first post-release leak');
    assert.equal(q('Account Coordinator', 'We supply the nation\'s largest retailers from our 12-person office.', 'Small Supply').ok, true, 'their customers being the largest is not them');
    assert.equal(q('Customer Support Specialist', 'Help our merchants by phone and chat with point of sale setup, cash register hardware and in-store printers.', 'POS Soft').ok, true, 'supporting a store product by phone is not store work');
    assert.equal(q('Sales Assistant', 'Support our outside sales representatives: enter orders, track merchandise shipments and answer customer calls from the office.', 'Supply Co').ok, true, 'supporting a field team from the office is not field work');
    assert.equal(q('Front Desk Coordinator', 'Greet patients and schedule visits.', 'Core Health & Rehab').ok, true, 'a Health & Rehab clinic is a small business');
    assert.equal(postEvidence({ company: 'Breakthru', title: 'Sales Development Representative', text: POSTS.breakthru, family: 'sales' }).reason, 'field_sales', 'accounts on daily routes across territories');
    assert.equal(postEvidence({ company: 'X', title: 'Inside Sales Representative', text: POSTS.breakthruPortal, family: 'sales' }).reason, 'large_employer', 'an internal associate portal is a large employer');
    assert.equal(postEvidence({ company: 'Fiesta Park Wellness and Rehabilitation', title: 'Receptionist', text: 'Greets new patients.', family: 'scheduling' }).reason, 'institutional_clinical');
    // Small businesses keep their cards.
    assert.equal(q('Patient Coordinator', POSTS.painIntake, '1st Pain Specialists').ok, true);
    assert.equal(q('Scheduling Coordinator', POSTS.damotech, 'Damotech').ok, true);
    assert.equal(q('Intake Coordinator', POSTS.lawIntake, 'Abrahamson Rdzanek & Wilkins').ok, true);
    assert.equal(q('Dispatcher', POSTS.dispatch, 'Royal Electric').ok, true, 'a dispatcher plans routes without being on one');
    assert.equal(q('Receptionist', 'Greet clients and answer phones.', 'Lakewood Animal Hospital').ok, true, 'an animal hospital is a small business');
    assert.equal(q('Receptionist', 'Greet patients and answer phones.', 'Dallas Family Medical Center').ok, true);
    assert.equal(q('Retail Store Associate', 'x').ok, false, 'a store title is still refused by the title rule');
    assert.equal(q('Senior Executive Assistant', 'The Nagler Group is partnering with an established organization in MetroWest, MA seeking a Senior Executive Assistant.', 'The Nagler Group').reason, 'competitor');
    assert.equal(postEvidence({ company: 'Grand Villa', title: 'Administrative Assistant', text: 'Passionate about contributing to a senior community and to our residents and their families.', family: 'admin' }).reason, 'institutional_clinical');
});

test('a Google listing is proof of the employer only when it is the employer: store pages, branches, no website and a far office are not', () => {
    const base = { company: 'Royal Electric', website: 'https://www.royalelect.com/', domain: 'royalelect.com', listingName: 'Royal Electrical Services', address: '4518 Ash Ln, Dallas, TX 75223', jobLocation: 'Dallas, TX', remote: false };
    assert.equal(listingEvidence(base), null);
    assert.equal(listingEvidence({ ...base, company: 'Michael Kors', website: 'https://locations.michaelkors.com/us/ga/atlanta/3393-peachtree-rd-ne', domain: 'locations.michaelkors.com' }).reason, 'chain_location');
    assert.equal(listingEvidence({ ...base, company: 'Circle K', website: 'https://www.circlek.com/store-locator/US/palm-coast/6125-e-highway-100/2721229', domain: 'circlek.com' }).action, 'exclude');
    assert.equal(listingEvidence({ ...base, company: 'Walgreens', website: 'https://www.walgreens.com/locator/walgreens-6297/id=10576', domain: 'walgreens.com' }).reason, 'chain_location');
    const att = listingEvidence({ ...base, company: 'AT&T', listingName: 'AT&T Store', website: 'https://www.att.com/stores/north-carolina/charlotte/1191', domain: 'att.com' });
    assert.equal(att.action, 'hold'); assert.equal(att.reason, 'branch_listing');
    assert.equal(listingEvidence({ ...base, listingName: 'Royal Electric Outlet', website: 'https://www.royalelect.com/' }).reason, 'branch_listing');
    assert.equal(listingEvidence({ ...base, website: null, domain: null }).reason, 'no_employer_website');
    assert.equal(listingEvidence({ ...base, company: 'Molina Healthcare', listingName: 'Molina Healthcare of Ohio', address: '3000 Corporate Exchange Dr, Columbus, OH 43231', jobLocation: 'Columbia, OH', remote: true }).reason, 'location_unconfirmed');
    assert.equal(listingEvidence({ ...base, address: '125 Parkwood St A, Lowell, AR 72745', jobLocation: 'Springdale, AR', remote: false }), null, 'a neighbouring town is fine for an office job');
    assert.equal(addressCity('3000 Corporate Exchange Dr, Columbus, OH 43231'), 'Columbus');
    assert.equal(listingEvidence({ ...base, company: 'The Nagler Group', listingType: 'Employment agency in Boston, Massachusetts' }).reason, 'competitor');
    assert.equal(listingEvidence({ ...base, company: 'Grand Villa of Delray Beach East', listingType: 'Assisted living facility in Palm Beach County, Florida' }).reason, 'institutional_clinical');
    assert.equal(listingEvidence({ ...base, listingType: 'Civil engineer in Tampa, Florida' }), null);
    assert.equal(listingEvidence({ ...base, company: 'Builders FirstSource', website: 'https://www.bldr.com/contact/request-quote?utm_source=yext&utm_medium=listing&utm_content=WILMNCYD', domain: 'bldr.com' }).reason, 'chain_location');
    assert.equal(listingEvidence({ ...base, listingType: 'Health insurance agency' }).reason, 'law_or_insurance', 'an insurance agency is left out (Paul, 2026-10-28)');
});

test('the number goes in the order the employer publishes it: a site number first, the listing kept as an alternate', () => {
    assert.deepEqual(alignNumbers('+14793912357', [], { numbers: ['+14797176300'], site: { sourceUrl: 'https://www.dewitt.law/' } }).primary, '+14797176300');
    assert.deepEqual(alignNumbers('+14793912357', [], { numbers: ['+14797176300'] }).alternates, ['+14793912357']);
    assert.equal(alignNumbers('+18157237400', ['+18553997225'], { numbers: ['+18157237400'] }).result, 'confirmed');
    assert.equal(alignNumbers('+18553997225', ['+18157237400'], { numbers: ['+18157237400'] }).primary, '+18157237400', 'an alternate the site publishes goes first');
    assert.equal(alignNumbers('+1', [], { unreadable: true }).result, 'unreadable', 'an unreadable site is not evidence');
    assert.equal(alignNumbers('+19452184003', [], { numbers: [] }).result, 'none_published');
});

test('a website that now lives on another domain is held; one that cannot be read changes nothing', async () => {
    const moved = await siteCheck({ website: 'https://sanityhomehealthservices.com/', domain: 'sanityhomehealthservices.com', getPage: async () => ({ url: 'https://www.expireddomains.com/', html: '' }), findSitePhone: async () => null });
    assert.equal(moved.moved, 'expireddomains.com');
    const down = await siteCheck({ website: 'https://reliablewire.com/', domain: 'reliablewire.com', getPage: async () => { throw Error('403'); }, findSitePhone: async () => null });
    assert.equal(down.unreadable, true);
    const ok = await siteCheck({ website: 'https://www.royalelect.com/', domain: 'royalelect.com', getPage: async u => ({ url: u, html: '' }), findSitePhone: async () => ({ phone: '+12146360190', alternates: [] }) });
    assert.deepEqual(ok.numbers, ['+12146360190']);
});

test('a new listing with no website, or a chain store page, never becomes a card; one whose site gives another number rings that first', async () => {
    let w = jobsWorld({ profile: { ...ROYAL, website: null } });
    let r = await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    assert.equal((await allRecords(w.kv)).length, 0);
    assert.ok((await allBacklog(w.kv)).some(b => b.reason === 'no_employer_website'), JSON.stringify(r.reasons));
    w = jobsWorld({ profile: { ...ROYAL, website: 'https://www.royalelect.com/store-locator/dallas' } });
    r = await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    assert.equal((await allRecords(w.kv)).length, 0); assert.equal(r.reasons.chain_location, 1, JSON.stringify(r.reasons));
    w = jobsWorld();
    w.deps.getPage = async u => ({ url: u, html: '<p>Call 214-636-0190</p>', text: 'Call 214-636-0190' });
    w.deps.findSitePhone = async () => ({ phone: '+12146360190', alternates: [], sourceUrl: 'https://www.royalelect.com/contact', context: 'Call 214-636-0190' });
    await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    const rec = (await allRecords(w.kv))[0];
    assert.equal(rec.phone.number, '+12146360190'); assert.deepEqual(rec.phone.alternates, ['+19452184003']);
    assert.equal(rec.phone.source, 'business website'); assert.equal(rec.phone.siteCheck.result, 'replaced');
});

test('cards made before these rules are held to them: a store job is excluded, a missing website is research, owner and history kept', async () => {
    const w = jobsWorld();
    await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    const rec = (await allRecords(w.kv))[0];
    // As if made yesterday: a store job, and a second card whose listing named no website.
    await putRecord(w.kv, { ...rec, listing: { ...rec.listing, description: POSTS.walgreens } });
    const other = { ...rec, id: 'hire:00000000000000e1', listing: { ...rec.listing, description: 'Answer phones.' }, company: { ...rec.company, board: 'gco:other:tx', website: null, domain: null }, callHistory: [{ outcome: 'no_answer' }] };
    await putRecord(w.kv, other);
    const out = await refreshReady({ ...w.deps, now: NOW }, { limit: 0 });
    const a = await getRecord(w.kv, rec.id), b = await getRecord(w.kv, other.id);
    assert.equal(a.status, 'excluded'); assert.equal(a.exclusion.reason, 'store_floor_role'); assert.equal(a.exclusion.by, 'rules re-check');
    assert.equal(b.status, 'research'); assert.equal(b.hold.reason, 'no_employer_website'); assert.equal(b.callHistory.length, 1, 'history kept');
    assert.equal(out.excluded, 1); assert.equal(out.held, 1);
});

// ---- leads a person researched (Madison's list, 2026-10-28) ------------------------------------
const LEAD = (over = {}) => ({ owner_first: 'Zachary', owner_last: 'Rogers', owner_title: 'Owner', business: 'Rogers Home Services - Zachary Rogers', industry: 'Home services', city: 'Tucson', state: 'AZ', website: 'https://agents.farmers.com/az/tucson/zachary-rogers', owner_email: 'zrogers1@farmersagent.com', phone: '520-600-0025', role_posted: 'Customer Service Representative - $40k-$60k/yr', posting_url: 'https://app.idealtraits.com/career/Zachary-Rogers-123', posting_date: 'Active on Indeed as of 2026-10-26', email_source_url: 'https://agents.farmers.com/az/tucson/zachary-rogers', notes: 'Owner is the agent.', vertical: 'small business (new)', ...over });

test('the wider seats: insurance service, legal support, retention and client services; leaders, executives and licences still out', () => {
    for (const t of ['Family Law Paralegal', 'Legal Assistant', 'Legal Secretary', 'CSR 2', 'Commercial Lines Account Manager', 'Insurance Account Representative - Fully Remote', 'Customer Sales and Service Representative', 'Customer Retention Specialist', 'Client Services Coordinator - Legal/Immigration', 'Law Firm Case Manager', 'Insurance Service Associate'])
        assert.ok(roleFamily(t), t);
    for (const t of ['VP, Strategic Finance & FP&A', 'Director, M&A Value Capture', 'Account Executive - New Business', 'Customer Service Manager', 'Legal Intake Team Lead - remote', 'Business Development Manager', 'Account Manager'])
        assert.equal(roleFamily(t), null, t);
    // Paul, 2026-10-28: law firms and insurance agencies are left out, whatever the seat.
    assert.equal(qualifyLead(LEAD({ business: 'Farmers Insurance - Zachary Rogers', industry: 'Insurance (Farmers agency)', role_posted: 'Account Manager - Fully Remote - US' }), NOW).reason, 'law_or_insurance');
    assert.equal(qualifyLead(LEAD({ business: 'Kyle & Kyle Law', industry: 'Law firm', role_posted: 'Family Law Paralegal' }), NOW).reason, 'law_or_insurance');
    assert.equal(qualifyLead(LEAD({ role_posted: 'Licensed Insurance Account Manager', notes: 'P&C license required.' }), NOW).reason, 'hard_restriction');
    assert.equal(qualifyLead(LEAD({ role_posted: 'Licensed Farmers Administrative Assistant / Client Experience Manager', notes: '' }), NOW).reason, 'hard_restriction');
    assert.equal(qualifyLead(LEAD({ role_posted: 'Insurance Service Associate (licensed)', notes: '' }), NOW).reason, 'hard_restriction');
    assert.equal(qualifyLead(LEAD({ role_posted: 'Client Intake Specialist ($37,440-$43,000/yr)', notes: '' }), NOW).ok, true, 'a salary is not a licence');
});

test('a provided lead is qualified on its own facts: role, place, freshness, the shared franchise host is not its website', () => {
    const q = qualifyLead(LEAD(), NOW);
    assert.equal(q.ok, true); assert.equal(q.family, 'support'); assert.equal(q.usState, 'AZ'); assert.equal(q.location, 'Tucson, AZ'); assert.equal(q.workplace, 'onsite');
    assert.equal(leadPostedAt(LEAD(), NOW), '2026-10-26T12:00:00.000Z');
    assert.equal(qualifyLead(LEAD({ role_posted: 'VP, Strategic Finance & FP&A' }), NOW).reason, 'role_not_fillable');
    assert.equal(qualifyLead(LEAD({ posting_date: 'Seen 2026-09-01' }), NOW).reason, 'stale_post');
    assert.equal(qualifyLead(LEAD({ state: null, city: null, role_posted: 'Customer Service Representative (remote)' }), NOW).location, 'Remote (US)');
    assert.equal(leadDomain('https://agents.farmers.com/az/tucson/x'), null);
    assert.equal(leadDomain('https://www.ransonlaw.com/'), 'ransonlaw.com');
    assert.equal(leadKey(LEAD()), leadKey(LEAD({ notes: 'other' })), 'one key per business, role and state');
});

test('an imported lead becomes a card with the owner as the contact and its own number, and spends no search', async () => {
    const w = jobsWorld();
    let searches = 0; w.deps.serpJobs = async () => { searches++; return { jobs: [] }; };
    w.deps.businessProfile = async () => { searches++; return null; };
    await addPending(w.kv, { kind: 'lead', key: leadKey(LEAD()), lead: LEAD() }, { seed: true, discoveredBy: 'provided', source: 'Madison' }, NOW);
    const r = await runHiring(w.deps, { leadsOnly: true, maxCandidates: 10, refresh: 0 });
    assert.equal(searches, 0, 'a lead run never searches'); assert.equal(r.searchBudget.allowedThisRun, 0);
    assert.equal(r.verdicts.ready, 1, JSON.stringify(r.reasons));
    const rec = (await allRecords(w.kv))[0];
    assert.equal(rec.job.source, 'provided'); assert.equal(rec.job.foundBy, 'Madison'); assert.equal(rec.company.domain, null, 'a Farmers page is not their own domain');
    assert.equal(rec.contact.name, 'Zachary Rogers'); assert.equal(rec.contact.firstName, 'Zachary'); assert.equal(rec.contact.email, 'zrogers1@farmersagent.com'); assert.equal(rec.contact.status, 'verified');
    assert.equal(rec.phone.number, '+15206000025'); assert.equal(rec.phone.source, 'provided');
    assert.equal(hiringCallReady(rec, NOW), true);
    const row = callRow(rec, 'milton@trystaffify.com', NOW);
    assert.equal(row.callContact.phoneStatus, 'provided'); assert.match(row.callContact.phoneSource, /Madison/);
    assert.match(rec.brief.summary, /Found by Madison/);
    assert.equal((await w.kv.hgetall(HK.pending)) || null, null, 'the pending entry is cleared on a saved verdict');
});

test('a lead meets every stop a found posting meets: booked, a number already on a card, opted out, no number', async () => {
    let w = jobsWorld();
    w.deps.bookedIdentity = async q => (q.email === 'zrogers1@farmersagent.com' ? { at: 'x' } : null);
    assert.equal((await processLead({ kind: 'lead', lead: LEAD() }, { source: 'Madison' }, w.deps)).reason, 'booked_call');
    w = jobsWorld();
    w.deps.isOptedOut = async q => q.phone === '+15206000025';
    assert.equal((await processLead({ kind: 'lead', lead: LEAD() }, { source: 'Madison' }, w.deps)).reason, 'opted_out');
    w = jobsWorld();
    assert.equal((await processLead({ kind: 'lead', lead: LEAD({ phone: null, website: null }) }, { source: 'Madison' }, w.deps)).reason, 'no_listed_phone');
    w = jobsWorld();
    await processLead({ kind: 'lead', lead: LEAD() }, { source: 'Madison' }, w.deps);
    const again = await processLead({ kind: 'lead', key: 'lead:other', lead: LEAD({ business: 'Zachary Rogers Agency', role_posted: 'Receptionist' }) }, { source: 'Madison' }, w.deps);
    assert.equal(again.verdict, 'merged'); assert.equal(again.reason, 'same_number');
    assert.equal((await allRecords(w.kv)).length, 1);
});

// Paul, 2026-10-28: "if there are ones ... that truly cannot be done remotely, that didn't make it through our filters, please make sure to do that."
test('a seat that needs someone there in person is out whatever its title; a phone seat posted in-office stays', () => {
    const ev = (title, text, family = 'support') => postEvidence({ company: 'A Small Co', title, text, family });
    assert.equal(ev('Entry Level Customer Service Rep', 'Connect with customers face-to-face, providing friendly service and helpful support.').reason, 'in_person_role');
    assert.equal(ev('Client Care Coordinator', 'Reliable transportation and willingness to travel throughout the territory. License/Certification: Driver\'s License (Required)').reason, 'in_person_role');
    assert.equal(ev('Parts Customer Service Assistant', 'Counter Customer Service, as needed. Ability to lift up to 50 pounds, ability to drive forklift.').reason, 'in_person_role');
    assert.equal(ev('Office Administrative Assistant', 'Greet clients, vendors, and other guests from the reception desk. Receive, sort, and distribute incoming mail and packages. Keep kitchen supplies stocked.').reason, 'in_person_desk');
    assert.equal(ev('Customer Service Rep / Appointment Setter', 'A full-time, in-office job, on the phone all day. In-office at our shop in Ardmore, OK. This is not remote.'), null, 'a phone seat the employer wants in the office is one a remote person does');
    assert.equal(ev('Dispatcher', 'Dispatch our drivers from home. Valid driver\'s license preferred.'), null, 'one sign is not enough');
    assert.equal(ev('Receptionist', 'Answer phones, greet visitors and schedule appointments.'), null, 'greeting is not a front desk on its own');
});

test('a chain\'s Yext link, one job posted in many cities and a stock purchase plan each mark a large employer', () => {
    const le = listingEvidence({ company: 'Capital One', website: 'https://www.capitalone.com/local/eastontowncenter/?utm_source=PowerListings&utm_medium=Local&utm_campaign=Yext', domain: 'capitalone.com', listingName: 'Capital One Café', listingType: 'Coffee shop', address: '167 Easton Town Ctr, Columbus, OH 43219', jobLocation: 'Columbus, OH (+7 others)', remote: true });
    assert.equal(le.reason, 'chain_location');
    assert.equal(qualifyJob(listing({ location: 'Columbus, OH (+7 others)' }), NOW).reason, 'large_employer');
    assert.equal(qualifyJob(listing({ location: 'Dallas, TX (+1 other)' }), NOW).ok, true, 'two cities is not a chain');
    assert.equal(postEvidence({ company: 'X', title: 'Customer Service Coordinator', text: 'Benefits: 401 K and Stock Purchase Plan.', family: 'support' }).reason, 'large_employer');
});

test('a number looked up for a research lead: dry first, blank fields only, then a lead run makes a card that says whose number it is', async () => {
    const w = jobsWorld();
    const lead = LEAD({ business: 'Park Consulting Group', owner_first: 'Glenn', owner_last: 'Park', owner_title: 'Founder', owner_email: null, phone: null, website: 'https://www.parkconsulting.com', city: 'Irvine', state: 'CA', role_posted: 'Executive Assistant to Founder & CEO', email_source_url: null });
    const first = await processLead({ kind: 'lead', key: leadKey(lead), lead }, { source: 'Madison', postingKey: leadKey(lead) }, w.deps);
    assert.equal(first.reason, 'no_listed_phone');
    const id = first.id;
    const fill = { id, phone: '+1 714-345-6538', phone_type: 'mobile', phone_person: 'Glenn Park', phone_grade: 'A', phone_alternates: ['+19494613400'], owner_first: 'Glen', owner_email: 'glenn@parkconsulting.com', public_phone: '(949) 753-1201' };
    const dry = await fillResearch(w.kv, { source: 'RocketReach', fills: [fill, { id: 'hire:0000000000000000', phone: '5551234567' }], by: 'test', now: NOW });
    assert.deepEqual(dry.map(x => x.done), [false, false]); assert.deepEqual(dry[0].added, ['phone', 'owner_email']); assert.equal(dry[1].why, 'not in research');
    assert.equal((await w.kv.hgetall(HK.pending)) || null, null, 'a dry run changes nothing');
    const wrote = await fillResearch(w.kv, { source: 'RocketReach', fills: [fill], write: true, by: 'test', now: NOW });
    assert.equal(wrote[0].done, true);
    const b = (await allBacklog(w.kv)).find(x => x.id === id);
    assert.equal(b.lead.owner_first, 'Glenn', 'what the researcher wrote stays'); assert.equal(b.lead.phone_source, 'RocketReach'); assert.equal(b.enrichment.by, 'RocketReach');
    // Their website publishes the front desk; the owner's mobile still goes first.
    w.deps.getPage = async u => ({ url: u, html: '<p>Call 949-753-1200</p>', text: 'Call 949-753-1200' });
    w.deps.findSitePhone = async () => ({ phone: '+19497531200', alternates: [], sourceUrl: 'https://www.parkconsulting.com/contact', context: 'Call 949-753-1200' });
    const r = await runHiring(w.deps, { leadsOnly: true, maxCandidates: 10, refresh: 0 });
    assert.equal(r.verdicts.ready, 1, JSON.stringify(r.reasons));
    const rec = await getRecord(w.kv, id);
    assert.equal(rec.phone.number, '+17143456538'); assert.equal(rec.phone.source, 'vendor'); assert.equal(rec.phone.vendor, 'RocketReach');
    assert.equal(rec.phone.person, 'Glenn Park'); assert.equal(rec.phone.lineType, 'mobile'); assert.equal(rec.phone.owner, 'Glenn Park');
    assert.deepEqual(rec.phone.alternates, ['+19494613400', '+19497531201', '+19497531200'], 'the owner\'s numbers, then the business line a checker saw, then the website\'s'); assert.equal(rec.phone.siteCheck.result, 'person_line');
    assert.equal(rec.job.foundBy, 'Madison'); assert.equal(rec.contact.email, 'glenn@parkconsulting.com'); assert.equal(rec.contact.source, 'RocketReach lookup');
    const row = callRow(rec, MILTON.email, NOW);
    assert.equal(row.callContact.phoneStatus, 'vendor_direct'); assert.equal(row.callContact.phoneSource, 'RocketReach'); assert.match(row.callContact.phoneDetail, /Glenn Park's mobile from a RocketReach lookup \(grade A\), not published on their website/);
    assert.deepEqual(orderCallQueue([row], { now: NOW }).map(x => x.id), [id], 'a looked-up number reaches the dialler queue');
    const base = { kv: w.kv, isOptedOut: async () => false, clientCheck: async () => ({ status: 'clear' }), crmContact: async () => { throw Error('CRM contact missing'); }, crmStop, loadBad, isBad, queueState: async () => ({ records: [] }) };
    const brief = await hiringBrief(w.kv, { id, caller: 'Milton', callerEmail: MILTON.email, shiftGate: { allowed: true, required: true } }, base);
    assert.equal(brief.body.dial.label, "Glenn Park's mobile, from RocketReach"); assert.match(brief.body.dial.detail, /Madison found the lead\. Ask for Glenn Park\./);
    assert.equal((await allBacklog(w.kv)).some(x => x.id === id), false, 'the research entry is cleared once it is a card');
});

test('when the owner\'s looked-up number is logged wrong, the next one up says it is the company line, not theirs', async () => {
    const w = jobsWorld();
    const lead = LEAD({ business: 'Coleman Roofing', owner_first: 'Joseph', owner_last: 'Coleman', owner_title: 'Founder', phone: '239-248-9252', website: null, city: 'Naples', state: 'FL', role_posted: 'Paralegal (remote in Florida)', phone_source: 'RocketReach', phone_type: 'mobile', phone_person: 'Joseph Coleman', phone_grade: 'A', phone_alternates: '', public_phone: '2394351052' });
    w.deps.loadBad = async () => new Set(['2392489252']);
    w.deps.isBad = (bad, n) => bad.has(String(n).replace(/\D/g, '').slice(-10));
    const r = await processLead({ kind: 'lead', key: leadKey(lead), lead }, { source: 'Madison' }, w.deps);
    assert.equal(r.verdict, 'ready');
    const lead2 = { ...lead, public_phone_url: 'https://www.floridabar.org/directories/find-mbr/profile/?num=1' };
    const w2 = jobsWorld(); w2.deps.loadBad = w.deps.loadBad; w2.deps.isBad = w.deps.isBad;
    const r2 = await processLead({ kind: 'lead', key: leadKey(lead2), lead: lead2 }, { source: 'Madison' }, w2.deps);
    for (const x of [r, r2]) {
        assert.equal(x.record.phone.number, '+12394351052'); assert.equal(x.record.phone.source, 'business website', 'not labelled as the vendor\'s');
        assert.equal(x.record.phone.person, undefined); assert.equal(x.record.phone.owner, 'the company, not a named person'); assert.equal(x.record.phone.type, 'company line the business publishes');
    }
    assert.equal(r2.record.phone.sourceUrl, 'https://www.floridabar.org/directories/find-mbr/profile/?num=1');
    assert.equal(callRow(r2.record, MILTON.email, NOW).callContact.phoneStatus, 'site_main');
});

test('a spreadsheet date kept as an Excel serial is read as the date it is, so an old post is not offered as new', async () => {
    assert.equal(leadStatedDate({ posting_date: '46266.0' }), '2026-09-01T12:00:00.000Z');
    assert.equal(leadStatedDate({ posting_date: '46302' }), '2026-10-07T12:00:00.000Z');
    assert.equal(leadStatedDate({ posting_date: 'No post date shown' }), null);
    assert.equal(leadDateLabel({ posting_date: '46266.0' }), 'Posted 2026-09-01');
    assert.equal(leadDateLabel({ posting_date: 'Active on Indeed as of 2026-10-26' }), 'Active on Indeed as of 2026-10-26');
    assert.equal(qualifyLead(LEAD({ posting_date: '46266.0' }), NOW).reason, 'stale_post');
    assert.equal(qualifyLead(LEAD({ posting_date: String((Date.parse(new Date(NOW).toISOString().slice(0, 10)) - Date.UTC(1899, 11, 30)) / 864e5 - 3) }), NOW).ok, true, 'three days old is fine');
    // A card already made under the old reading takes the stated date and expires on the next pass; owner and history stay.
    const w = jobsWorld();
    await processLead({ kind: 'lead', key: leadKey(LEAD()), lead: LEAD() }, { source: 'Madison' }, w.deps);
    const rec = (await allRecords(w.kv))[0];
    await putRecord(w.kv, { ...rec, lead: { ...rec.lead, posting_date: '46266.0' }, callHistory: [{ at: 'x', outcome: 'no_answer' }] });
    const out = await refreshReady({ ...w.deps, now: NOW }, { limit: 0, siteChecks: 0 });
    assert.equal(out.redated, 1); assert.equal(out.stale, 1);
    const after = await getRecord(w.kv, rec.id);
    assert.equal(after.job.postedAt, '2026-09-01T12:00:00.000Z'); assert.equal(after.job.state, 'stale'); assert.equal(after.job.postedLabel, 'Posted 2026-09-01');
    assert.equal(after.callHistory.length, 1); assert.equal(hiringCallReady(after, NOW), false);
});

test('the opener says the job the way a person would, not the posting\'s full title', () => {
    assert.equal(spokenRole('Customer Service Representative - $40k-$60k/yr + commission'), 'Customer Service Representative');
    assert.equal(spokenRole('Family Law Paralegal (remote in Florida, $15-$35/hr, FT/PT)'), 'Family Law Paralegal');
    assert.equal(spokenRole('Account Manager - Fully Remote - US, $65k-$95k + commission'), 'Account Manager');
    assert.equal(spokenRole('Executive Assistant / Account Manager (remote)'), 'Executive Assistant and Account Manager');
    assert.equal(spokenRole('Customer Service Rep / Appointment Setter – Full-Time, In-Office (Phone-Based) – $18–$25/hr'), 'Customer Service Rep and Appointment Setter');
    assert.equal(spokenRole('CSR 2'), 'CSR', 'a level number is not said'); assert.equal(spokenRole('Farmers Insurance Customer Service'), 'Customer Service', 'nor the carrier');
    assert.deepEqual(['Account Manager', 'L1 Technical Support Agent', 'SDR', 'Senior Paralegal', 'HR Assistant', 'Legal Assistant'].map(articleFor), ['an', 'an', 'an', 'a', 'an', 'a']);
    const s = hiringCallScript({ caller: 'Milton', company: 'Farmers Insurance - Zachary Rogers', firstName: 'Zachary', jobTitle: 'Customer Service Representative - $40k-$60k/yr + commission', family: 'support', city: 'Tucson' });
    assert.equal(s.opener, "Hi, this is Milton with Staffify. I'm calling about the Customer Service Representative job you posted in Tucson. I'm looking to speak with Zachary, or the person in charge of hiring. Is that you?");
    assert.match(s.reason, /I saw you're hiring a Customer Service Representative\. We help companies hire dedicated Customer Service Representatives/, 'the person put through hears the job in the pitch');
    assert.deepEqual(s.tree.open.choices[0], ["That's me / putting you through", 'intro']); assert.deepEqual(s.tree.intro.choices[0], ['Go ahead', 'reason']);
    const a = hiringCallScript({ caller: 'Milton', company: 'Acme', firstName: '', jobTitle: 'Account Manager - Fully Remote', family: 'account' });
    assert.match(a.reason, /I saw you're hiring an Account Manager\. We help companies hire dedicated Account Managers/); assert.match(a.voicemail, /is hiring an Account Manager\./);
    // Paul's example, and titles that name the work rather than the person.
    const ea = hiringCallScript({ caller: 'Paul', company: 'Park Consulting', firstName: 'Glenn', jobTitle: 'Executive Assistant to Founder & CEO', family: 'admin', direct: true });
    assert.match(ea.reason, /I saw you're hiring an Executive Assistant to Founder & CEO\. We help companies hire dedicated EAs from Latin America/);
    const cs = hiringCallScript({ caller: 'Paul', company: 'Araceli Rubio Agency', firstName: '', jobTitle: 'Farmers Insurance Customer Service', family: 'support' });
    assert.match(cs.reason, /I saw you're hiring for a Customer Service role\. We help companies hire dedicated Customer Service staff/);
    assert.match(hiringCallScript({ caller: 'Paul', company: 'X', firstName: '', jobTitle: 'CSR 2', family: 'support' }).reason, /hiring a CSR\. We help companies hire dedicated CSRs/);
});

// Paul, 2026-10-28: "I need cell phone numbers here from rocket reach, the folks I am hitting a gatekeeper each and every single time".
test('an owner\'s cell goes first on a live card, the old line stays behind it, and the opener greets them by name', async () => {
    const w = jobsWorld();
    await processLead({ kind: 'lead', key: leadKey(LEAD()), lead: LEAD({ owner_email: null }) }, { source: 'Madison' }, w.deps);
    const rec = (await allRecords(w.kv))[0];
    assert.equal(rec.contact.status, 'named');
    await putRecord(w.kv, { ...rec, callOwner: 'hello@gostaffify.com', callHistory: [{ outcome: 'gatekeeper', at: 'x', caller: 'hello@gostaffify.com', dialled: '+15206000025' }] });
    const deps = { isOptedOut: async q => q.phone === '+15205550000', loadBad, isBad };
    const line = { id: rec.id, phone: '+1 520-301-7788', phone_type: 'mobile', phone_person: 'Zachary Rogers', phone_grade: 'A', phone_alternates: ['5208881234'] };
    const dry = await ownerLines(w.kv, { source: 'RocketReach', lines: [line], by: 'test', now: NOW, ...deps });
    assert.equal(dry[0].done, false); assert.equal(dry[0].to, '+15203017788'); assert.equal((await getRecord(w.kv, rec.id)).phone.number, '+15206000025', 'dry changes nothing');
    const res = await ownerLines(w.kv, { source: 'RocketReach', lines: [line, { ...line, id: 'hire:00000000000000ff' }, { id: rec.id, phone: '520-555-0000', phone_person: 'Zachary Rogers' }], write: true, by: 'test', now: NOW, ...deps });
    assert.equal(res[0].done, true); assert.equal(res[1].why, 'not found'); assert.equal(res[2].why, 'opted out');
    const after = await getRecord(w.kv, rec.id);
    assert.equal(after.phone.number, '+15203017788'); assert.deepEqual(after.phone.alternates, ['+15208881234', '+15206000025'], 'the line Madison found stays, behind the owner\'s');
    assert.equal(after.phone.source, 'vendor'); assert.equal(after.phone.person, 'Zachary Rogers'); assert.equal(after.phone.previous.number, '+15206000025');
    assert.equal(after.callOwner, 'hello@gostaffify.com'); assert.equal(after.callHistory.length, 1, 'owner and history untouched');
    assert.equal(callRow(after, 'hello@gostaffify.com', NOW).callContact.phoneStatus, 'vendor_direct');
    const base = { kv: w.kv, isOptedOut: async () => false, clientCheck: async () => ({ status: 'clear' }), crmContact: async () => { throw Error('CRM contact missing'); }, crmStop, loadBad, isBad, queueState: async () => ({ records: [] }) };
    const brief = await hiringBrief(w.kv, { id: rec.id, caller: 'Paul', callerEmail: 'hello@gostaffify.com', shiftGate: { allowed: true, required: true } }, base);
    assert.equal(brief.body.opener, 'Hi, is this Zachary? (Wait for them.) Hi Zachary, this is Paul with Staffify.');
    assert.equal(brief.body.reason, "The reason I'm calling is I saw you're hiring a Customer Service Representative. We help companies hire dedicated Customer Service Representatives from Latin America and the Philippines, and we handle the recruiting, vetting, and ongoing management. I wanted to see if you'd be open to a quick conversation with our team so we can learn more about the role and see if we can put a few great candidates in front of you.", 'on their own phone the pitch, with the job, comes right after the greeting');
    assert.deepEqual(brief.body.tree.open.choices[0], ["Yes, that's me", 'reason']);
    assert.equal(brief.body.dial.label, "Zachary Rogers's mobile, from RocketReach");
    assert.equal(brief.body.name, 'Zachary Rogers', 'a researched owner with no email is still named on the card');
});

test('a post that calls its employer a listed public company marks it large, in any of the forms they write it', () => {
    const ev = text => postEvidence({ company: 'EVI Industries, Inc.', title: 'Executive Assistant', text, family: 'admin' });
    assert.equal(ev('EVI Industries, Inc. (NYSE American: EVI) is the only U.S. public company focused on laundry.').reason, 'large_employer');
    assert.equal(ev('You will see how a growing public company is run.').reason, 'large_employer');
    assert.equal(ev('We support public companies and private clients with bookkeeping.'), null, 'a phrase about clients is not the employer');
});

// Paul, 2026-10-28: "I just upgraded our rocketreach account to 1000 + a month". Every run finds a few owners' cells.
const RRP = (over = {}) => ({ id: 501, name: 'Zachary Rogers', title: 'Owner', employer: 'Rogers Home Services', employerDomain: null, region: 'AZ', phones: [{ number: '+15203017788', type: 'mobile', grade: 'A', valid: true, recommended: true }, { number: '+15204440000', type: 'direct dial', grade: 'A-', valid: true }, { number: '+18005551212', type: 'mobile', grade: 'A', valid: true }], ...over });
const fakeRR = (over = {}) => {
    const calls = { lookups: [], searches: 0, status: 0 };
    return { calls, rr: {
        account: async () => ({ ok: true, creditUsage: [{ credit_type: 'premium_lookup', remaining: over.left ?? 900 }] }),
        lookupPerson: async q => { calls.lookups.push(q); return over.lookup ? over.lookup(q) : { found: true, profile: RRP() }; },
        searchPeople: async () => { calls.searches++; return { profiles: over.profiles || [] }; },
        checkStatus: async ids => { calls.status++; return over.status ? over.status(ids) : {}; },
    } };
};
async function cardWorld() {
    const w = jobsWorld();
    await processLead({ kind: 'lead', key: leadKey(LEAD()), lead: LEAD({ owner_email: null }) }, { source: 'Madison' }, w.deps);
    return { w, rec: (await allRecords(w.kv))[0] };
}
test('each run puts an owner\'s cell first on a card that rings a main line, once, inside the caps', async () => {
    const { w, rec } = await cardWorld();
    const f = fakeRR();
    const out = await ownerCells({ ...w.deps, rr: f.rr, now: NOW });
    assert.equal(out.added, 1); assert.equal(out.lookups, 1); assert.equal(out.creditsLeft, 900);
    assert.deepEqual(f.calls.lookups[0], { name: 'Zachary Rogers', employer: 'Rogers Home Services - Zachary Rogers' }, 'the owner is looked up at their business');
    const after = await getRecord(w.kv, rec.id);
    assert.equal(after.phone.number, '+15203017788'); assert.equal(after.phone.lineType, 'mobile'); assert.equal(after.phone.person, 'Zachary Rogers');
    assert.deepEqual(after.phone.alternates, ['+15204440000', '+15206000025'], 'toll-free dropped; the old line kept behind');
    assert.equal(after.ownerCell.result, 'added'); assert.equal(after.ownerCell.profileId, 501);
    const again = await ownerCells({ ...w.deps, rr: f.rr, now: NOW });
    assert.equal(again.lookups, 0, 'a card is tried once');
    assert.equal(Number(await w.kv.get('staffify:hiring:rr:' + new Date(NOW).toISOString().slice(0, 10))), 1);
});
test('a RocketReach profile that is someone else, elsewhere, or has no mobile is noted and never put on the card', async () => {
    for (const [p, why] of [[RRP({ name: 'Zachary Rogers', employer: 'Rogers Plumbing', title: 'Owner' }), /works at Rogers Plumbing/], [RRP({ region: 'TX' }), /is in TX/], [RRP({ name: 'Zach Miller' }), /not Zachary Rogers/]]) {
        const { w, rec } = await cardWorld();
        const out = await ownerCells({ ...w.deps, rr: fakeRR({ lookup: () => ({ found: true, profile: p }) }).rr, now: NOW });
        assert.equal(out.mismatch, 1);
        const after = await getRecord(w.kv, rec.id);
        assert.equal(after.phone.number, '+15206000025'); assert.match(after.ownerCell.why, why);
    }
    const { w, rec } = await cardWorld();
    await ownerCells({ ...w.deps, rr: fakeRR({ lookup: () => ({ found: true, profile: RRP({ phones: [{ number: '+15204440000', type: 'direct dial', grade: 'A', valid: true }] }) }) }).rr, now: NOW });
    assert.equal((await getRecord(w.kv, rec.id)).ownerCell.result, 'no_mobile');
    assert.equal(cellMatch({ company: { name: 'Park Consulting Group', domain: 'parkconsulting.com' }, contact: { name: 'Glenn Park' }, job: { usState: 'CA' } }, { name: 'Glenn Park', employer: 'PCG', employerDomain: 'parkconsulting.com', region: 'CA' }).ok, true, 'the domain is enough');
    assert.equal(cellsOf({ phones: [{ number: '+15551110000', type: 'mobile', grade: 'B', valid: true }, { number: '+15552220000', type: 'mobile', grade: 'A', valid: true }, { number: '+15553330000', type: 'mobile', grade: 'A', valid: false }] }, null).mobile.number, '+15552220000');
});
test('the daily cap and the monthly reserve stop spending; a "still searching" answer is collected free later', async () => {
    let { w, rec } = await cardWorld();
    await w.kv.set('staffify:hiring:rr:' + new Date(NOW).toISOString().slice(0, 10), String(RR_DAILY_CAP));
    let f = fakeRR();
    assert.match((await ownerCells({ ...w.deps, rr: f.rr, now: NOW })).skipped, /daily cap/); assert.equal(f.calls.lookups.length, 0);
    ({ w, rec } = await cardWorld());
    f = fakeRR({ left: 100 });
    assert.match((await ownerCells({ ...w.deps, rr: f.rr, now: NOW })).skipped, /kept in reserve/); assert.equal(f.calls.lookups.length, 0);
    ({ w, rec } = await cardWorld());
    f = fakeRR({ lookup: () => ({ found: false, pending: true, id: 777 }), status: ids => ({ [ids[0]]: { done: true, profile: RRP({ id: 777 }) } }) });
    const first = await ownerCells({ ...w.deps, rr: f.rr, now: NOW });
    assert.equal(first.pending, 1); assert.equal((await getRecord(w.kv, rec.id)).ownerCell.result, 'pending');
    const second = await ownerCells({ ...w.deps, rr: f.rr, now: NOW });
    assert.equal(second.collected, 1); assert.equal(second.lookups, 0, 'collecting costs nothing');
    assert.equal((await getRecord(w.kv, rec.id)).phone.number, '+15203017788');
    // No owner on the card: the free search finds one, then a single lookup by id.
    ({ w, rec } = await cardWorld());
    await putRecord(w.kv, { ...rec, contact: { status: 'not_found' } });
    f = fakeRR({ profiles: [{ id: 902, name: 'Zachary Rogers', current_title: 'Owner', current_employer: 'Zachary Rogers Agency' }], lookup: q => ({ found: true, profile: RRP({ id: q.id }) }) });
    const anon = await ownerCells({ ...w.deps, rr: f.rr, now: NOW });
    assert.equal(f.calls.searches, 1); assert.deepEqual(f.calls.lookups, [{ id: 902 }]); assert.equal(anon.added, 1);
});
test('a firm named for its owner still matches its own name, and only its own name', () => {
    const m = (co, owner, emp, st = 'CA', title = null) => cellMatch({ company: { name: co }, contact: { name: owner }, job: { usState: st } }, { name: owner, employer: emp, region: st, title }).ok;
    assert.equal(m('Abrolat Law', 'Nancy Abrolat', 'Abrolat Law PC'), true);
    assert.equal(m('Law Office of Lalo Garcia APC', 'Lalo Garcia', 'Law Office of Lalo Garcia, APC'), true);
    assert.equal(m('Coleman Litigation', 'Joseph Coleman', 'Coleman Litigation', 'FL'), true);
    assert.equal(m('Peyton Pettus - State Farm Agent', 'Peyton Pettus', 'Peyton Pettus Insurance Agencies, Inc.(State Farm)', 'GA', 'Owner and President'), true);
    assert.equal(m('Peyton Pettus - State Farm Agent', 'Peyton Pettus', 'Peyton Pettus Insurance Agencies, Inc.(State Farm)', 'GA'), false, 'a carrier match needs an agent or owner title');
    assert.equal(m('Peyton Pettus - State Farm Agent', 'Peyton Pettus', 'Pettus Roofing', 'GA'), false);
    assert.equal(m('Mark Jameson Allstate Agency', 'Mark Jameson', 'State Farm', 'TX'), false, 'another carrier is another business');
});

// Paul, 2026-10-28: "dont ever publish a 1800 number because we wont call it, go find the cell phone".
test('a toll-free number is never on a card: dropped at intake, stripped from old cards, and a card with nothing else waits for a cell', async () => {
    // Intake: a lead whose only number is toll-free becomes a held card, not a callable one.
    const w = jobsWorld();
    const r = await processLead({ kind: 'lead', key: leadKey(LEAD()), lead: LEAD({ phone: '888-553-3476', owner_email: null }) }, { source: 'Madison' }, w.deps);
    const rec = await getRecord(w.kv, r.id);
    assert.equal(rec.status, 'research'); assert.equal(rec.hold.reason, 'toll_free_only');
    assert.equal(hiringCallReady({ ...rec, status: 'ready' }, NOW), false, 'never callable on a toll-free line');
    const row = callRow({ ...rec, status: 'ready' }, MILTON.email, NOW);
    assert.equal(row.phone, null); assert.equal(row.callContact.phone, null);
    // The hourly lookup goes to it first, and the owner's cell releases it.
    const f = fakeRR();
    const out = await ownerCells({ ...w.deps, rr: f.rr, now: NOW });
    assert.equal(out.added, 1);
    const after = await getRecord(w.kv, r.id);
    assert.equal(after.status, 'ready'); assert.equal(after.hold, null); assert.equal(after.phone.number, '+15203017788');
    assert.ok(!after.phone.alternates.some(n => /^\+1(800|888|877|866|855|844|833)/.test(n)), 'and the toll-free line is not kept as a backup');
    // An older card: the toll-free line leaves, the next number rings.
    const w2 = jobsWorld();
    const r2 = await processLead({ kind: 'lead', key: leadKey(LEAD()), lead: LEAD() }, { source: 'Madison' }, w2.deps);
    const old = await getRecord(w2.kv, r2.id);
    await putRecord(w2.kv, { ...old, phone: { ...old.phone, number: '+18008330128', alternates: ['+13236330000', '+18665551234'] } });
    const res = await refreshReady({ ...w2.deps, now: NOW }, { limit: 0, siteChecks: 0 });
    assert.equal(res.tollFree, 1);
    const fixed = await getRecord(w2.kv, r2.id);
    assert.equal(fixed.phone.number, '+13236330000'); assert.deepEqual(fixed.phone.alternates, []); assert.equal(fixed.phone.previous.why, 'toll-free');
    // A website's toll-free line is not a number the site check uses.
    const chk = await siteCheck({ website: 'https://x.com/', domain: 'x.com', getPage: async u => ({ url: u, html: '<p>Call 800-833-0128 or 562-345-8700</p>', text: 'Call 800-833-0128 or 562-345-8700' }), findSitePhone: async () => ({ phone: '+18008330128', alternates: [] }) });
    assert.deepEqual(chk.numbers, ['+15623458700']);
});
test('the website check never moves a card off the owner\'s cell', async () => {
    const w = jobsWorld();
    await runHiring(w.deps, { maxSearches: 1, maxCandidates: 5, refresh: 0, cells: 0 });
    const rec = (await allRecords(w.kv))[0];
    await putRecord(w.kv, { ...rec, phone: { ...rec.phone, number: '+12145550111', alternates: ['+19452184003'], source: 'vendor', vendor: 'RocketReach', person: 'Maria Lopez', lineType: 'mobile', siteCheck: undefined } });
    w.deps.getPage = async u => ({ url: u, html: '<p>Call 945-218-4003</p>', text: 'Call 945-218-4003' });
    w.deps.findSitePhone = async () => ({ phone: '+19452184003', alternates: [] });
    await refreshReady({ ...w.deps, now: NOW }, { limit: 0, siteChecks: 6 });
    assert.equal((await getRecord(w.kv, rec.id)).phone.number, '+12145550111');
});

test('the review of the owner-cell step: state names, search matches, the counter, and a paid answer never lost', async () => {
    // "Texas" is a state too; a company-search match with no state at all is refused.
    const card = { company: { name: 'Sun Plumbing' }, contact: {}, job: { usState: 'AZ' } };
    assert.equal(cellMatch(card, { name: 'Bob Sun', employer: 'Sun Plumbing LLC', region: 'Texas' }).ok, false);
    assert.equal(cellMatch(card, { name: 'Bob Sun', employer: 'Sun Plumbing LLC', location: 'Phoenix, AZ, US' }).ok, true);
    assert.equal(cellMatch(card, { name: 'Bob Sun', employer: 'Sun Plumbing LLC' }, { strictState: true }).ok, false);
    // Two runs together: the counter, taken before each lookup, is what stops the spend.
    let { w } = await cardWorld();
    await w.kv.set('staffify:hiring:rr:' + new Date(NOW).toISOString().slice(0, 10), String(RR_DAILY_CAP));
    let f = fakeRR();
    const capped = await ownerCells({ ...w.deps, rr: f.rr, now: NOW });
    assert.match(capped.skipped, /daily cap/); assert.equal(f.calls.lookups.length, 0); assert.equal((await w.kv.hgetall(RR_TRIED)) || null, null, 'the card is left to try another day');
    // A caller saving the card when the answer lands: kept, and put on the card next run without a new lookup.
    let rec; ({ w, rec } = await cardWorld());
    f = fakeRR();
    await w.kv.set('staffify:hiring:lock:' + rec.id, '1');
    const busy = await ownerCells({ ...w.deps, rr: f.rr, now: NOW });
    assert.equal(busy.added, 0); assert.equal(JSON.parse((await w.kv.hgetall(RR_TRIED))[rec.id]).result, 'apply_later');
    await w.kv.del('staffify:hiring:lock:' + rec.id);
    const later = await ownerCells({ ...w.deps, rr: f.rr, now: NOW });
    assert.equal(later.reapplied, 1); assert.equal(later.added, 1); assert.equal(f.calls.lookups.length, 1, 'one lookup, not two');
    assert.equal((await getRecord(w.kv, rec.id)).phone.number, '+15203017788');
    // An outage stops the run and leaves the card untried.
    ({ w, rec } = await cardWorld());
    f = fakeRR({ lookup: () => ({ found: false, retryable: true, reason: 'rate limited' }) });
    const down = await ownerCells({ ...w.deps, rr: f.rr, now: NOW });
    assert.equal(down.errors, 1); assert.equal((await w.kv.hgetall(RR_TRIED)) || null, null);
    // The owner found with no phone is not searched for again (no second credit).
    ({ w, rec } = await cardWorld());
    f = fakeRR({ lookup: () => ({ found: false, profile: RRP({ phones: [] }) }), profiles: [{ id: 9, name: 'Zachary Rogers', current_employer: 'Farmers Insurance' }] });
    const empty = await ownerCells({ ...w.deps, rr: f.rr, now: NOW });
    assert.equal(f.calls.searches, 0); assert.equal(empty.noMobile, 1);
    // The card already rings the owner's best mobile: it is relabelled, not swapped for a weaker one.
    ({ w, rec } = await cardWorld());
    f = fakeRR({ lookup: () => ({ found: true, profile: RRP({ phones: [{ number: '+15206000025', type: 'mobile', grade: 'A', valid: true }, { number: '+15207770000', type: 'mobile', grade: 'B', valid: true }] }) }) });
    await ownerCells({ ...w.deps, rr: f.rr, now: NOW });
    const same = await getRecord(w.kv, rec.id);
    assert.equal(same.phone.number, '+15206000025'); assert.equal(same.phone.lineType, 'mobile'); assert.equal(same.phone.person, 'Zachary Rogers');
});

test('identity rules from the second review: trade words, carrier staff, bare carriers, suffixes', () => {
    const m = (co, owner, emp, st, title, region) => cellMatch({ company: { name: co }, contact: owner ? { name: owner } : {}, job: { usState: st } }, { name: owner || 'Bob Sun', employer: emp, region: region === undefined ? st : region, title }).ok;
    assert.equal(m('Lee Dental Care', 'David Lee', 'Pacific Dental Services', 'CA'), false, 'a shared trade word is not the same business');
    assert.equal(m('Farmers Insurance - Zachary Rogers', 'Zachary Rogers', 'Farmers Insurance', 'AZ', 'Claims Adjuster'), false, 'carrier staff are not the agent');
    assert.equal(m('Farmers Insurance - Zachary Rogers', 'Zachary Rogers', 'Farmers Insurance', 'AZ', 'Agency Owner'), true);
    assert.equal(m('Golden Star Technology', 'Shirley Tai', 'Apex Technology Inc', null), false);
    assert.equal(m('Ware Insurance', 'Sidney S. Kellam II', 'Ware Insurance', 'VA'), true, 'suffixes and initials do not break a match');
    assert.equal(m('Sun Plumbing', null, 'Sun Valley Plumbing', 'AZ'), false, 'with no owner, only the same business name will do');
    assert.equal(m('Dental Care', 'Ann Smith', 'Pacific Dental Care', 'CA'), false);
});

// Paul, 2026-10-28: "The call portal should be able to dispurse more emails and right now its not leaving a trail of breadcrumbs".
test('an email given on the call goes on the card for the rep who called; the Hiring now templates never claim an earlier email', async () => {
    const w = jobsWorld();
    await processLead({ kind: 'lead', key: leadKey(LEAD()), lead: LEAD({ owner_email: null }) }, { source: 'Madison' }, w.deps);
    const rec = (await allRecords(w.kv))[0];
    const rep = { email: 'hello@gostaffify.com', name: 'Paul Chareth' };
    const deps = { isOptedOut: async q => q.email === 'stop@x.com', recordActivity: async () => {} };
    assert.equal((await saveHiringContactEmail(w.kv, { rep, body: { id: rec.id, email: 'zach@x.com' } }, deps)).status, 409, 'not before a call');
    await putRecord(w.kv, { ...rec, callHistory: [{ at: 'x', caller: 'hello@gostaffify.com', outcome: 'connected' }] });
    assert.equal((await saveHiringContactEmail(w.kv, { rep, body: { id: rec.id, email: 'not an email' } }, deps)).status, 400);
    assert.match((await saveHiringContactEmail(w.kv, { rep, body: { id: rec.id, email: 'stop@x.com' } }, deps)).error, /do-not-contact/);
    const ok = await saveHiringContactEmail(w.kv, { rep, body: { id: rec.id, email: ' Zach@RogersAgency.com ' } }, deps);
    assert.equal(ok.ok, true);
    const after = await getRecord(w.kv, rec.id);
    assert.equal(after.contact.email, 'zach@rogersagency.com'); assert.equal(after.contact.status, 'given_on_call'); assert.equal(after.contact.name, 'Zachary Rogers', 'the name stays');
    assert.equal(callRow(after, rep.email, NOW).recipient, 'zach@rogersagency.com', 'Email them works now');
    // The opt-out list unreadable: nothing saved.
    assert.equal((await saveHiringContactEmail(w.kv, { rep, body: { id: rec.id, email: 'a@b.com' } }, { isOptedOut: async () => { throw Error('down'); } })).status, 503);
    // Templates: the call-first set only on a Hiring now card, with the role in, and never "we sent you".
    const hiring = templatesFor('milton@trystaffify.com', { kind: 'hiring', hiring: { title: 'Customer Service Representative - $40k-$60k/yr' } });
    assert.deepEqual(hiring.map(t => t.id), HIRING_TEMPLATES.map(t => t.id));
    for (const t of hiring) { assert.ok(!/\{role\}|\{roles\}/.test(t.body)); assert.doesNotMatch(t.body, /we sent|sent you|our (e-?mails?|notes)|—/i); }
    assert.match(hiring[0].body, /filling the Customer Service Representative role/); assert.match(hiring[0].body, /dedicated Customer Service Representatives/);
    assert.deepEqual(templatesFor('milton@trystaffify.com', { kind: 'rep' }).map(t => t.id), ['thanks-book', 'missed-book']);
});
test('the filled-role branch: Paul\'s pivot, then stay in touch books a callback a month out with the summary email', () => {
    const s = hiringCallScript({ caller: 'Paul', company: 'Acme', firstName: 'Shirley', jobTitle: 'Executive Assistant', family: 'admin', direct: true });
    assert.match(s.tree.filled.say, /^Okay, and just wanted to let you know, the reason I'm calling is I work for a company called Staffify/);
    assert.deepEqual(s.tree.filled.choices[0], ['Yes, stay in touch', 'keepintouch']);
    assert.equal(s.tree.keepintouch.log, 'callback'); assert.equal(s.tree.keepintouch.callbackDays, 30); assert.equal(s.tree.keepintouch.email, 'hiring-stay-in-touch');
    assert.equal(s.tree.booked.email, 'hiring-thanks'); assert.equal(s.tree.sendinfo.email, 'hiring-thanks');
    assert.equal(s.objections.find(o => o.label === 'Already filled it').say, s.tree.filled.say);
});

// Paul, 2026-10-28: "exclude most of all the law firms and insurance firms" (his choice: all of them, callbacks kept).
test('law firms and insurance agencies are left out from every source; a card someone is working stays with them', async () => {
    for (const [n, c] of [['Farmers Insurance - Zachary Rogers', ''], ['Insuramax', 'Insurance (independent P&C agency)'], ['Coleman Litigation', ''], ['Kyle & Kyle Law', ''], ['Gabriel C Garza Ins Agency Inc (The Garza Agency - Farmers)', ''], ['Peyton Pettus - State Farm Agent', '']])
        assert.equal(sectorExcluded(n, c).reason, 'law_or_insurance', n);
    for (const [n, c] of [['Zoe Rose Therapy, PLLC', 'Mental health counseling'], ['Lawrence Plumbing', ''], ['Farmers Market Co-op', ''], ['NextPath Care Management & Consulting', '']])
        assert.equal(sectorExcluded(n, c), null, n);
    assert.equal(qualifyJob(listing({ company_name: 'Smith & Jones Law Group' }), NOW).reason, 'law_or_insurance', 'the hourly search too');
    // Cards made before: the untouched one leaves on the next run; the one a caller booked a callback on stays.
    const w = jobsWorld();
    for (const [biz, key] of [['Mormile Agency Inc. (Farmers Insurance)', 'lead:a'], ['Abrolat Law', 'lead:b']]) {
        const l = LEAD({ business: biz, industry: '', vertical: '', phone: biz === 'Abrolat Law' ? '310-999-2007' : '520-600-0025' });
        await putRecord(w.kv, { id: 'hire:' + key.slice(-1).repeat(16), campaignId: 'staffify-hiring-intent', status: 'ready', lead: l, company: { name: biz }, job: { source: 'provided', title: 'Customer Service Representative', postedAt: new Date(NOW - 864e5).toISOString(), state: 'open' }, phone: { number: biz === 'Abrolat Law' ? '+13109992007' : '+15206000025', alternates: [] }, contact: {}, callHistory: [], ...(biz === 'Abrolat Law' ? { callOwner: 'hello@gostaffify.com', callOutcome: 'no_answer', nextCallAt: new Date(NOW + 864e5).toISOString() } : {}), createdAt: new Date(NOW).toISOString() });
    }
    const out = await refreshReady({ ...w.deps, now: NOW }, { limit: 0, siteChecks: 0 });
    assert.equal(out.excluded, 1);
    assert.equal((await getRecord(w.kv, 'hire:aaaaaaaaaaaaaaaa')).exclusion.reason, 'law_or_insurance');
    assert.equal((await getRecord(w.kv, 'hire:bbbbbbbbbbbbbbbb')).status, 'ready', 'a callback a caller booked is left with them');
});
