// Hiring now: the call-first campaign built from current job posts. Every outside service is a stub;
// nothing here calls, texts, emails or spends a credit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HK, HIRING_ID, FRESH_MS, parseAts, roleFamily, qualifyPosting, restrictions, hiringCallReady, applyOutcome, callRow, linksToBoard, boardHomepage, getRecord, allRecords, allBacklog, putRecord, hiringReportRows } from '../api/_hiring-intent.js';
import { processPosting, runHiring, refreshReady, addPending, PENDING_MAX_ATTEMPTS } from '../api/_hiring-run.js';
import { saveHiringOutcome, hiringBrief, liveStops } from '../api/_hiring-calls.js';
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

test('search results beyond the run cap wait in the pending queue for the next run', async () => {
    const t = threeBoards();
    const w = world({ json: t.json, pages: t.pages, links: t.links });
    const first = await runHiring(w.deps, { maxSearches: 1, maxCandidates: 1, refresh: 0 });
    assert.equal(first.verdicts.ready, 1);
    assert.equal(first.pendingAfter, 2, 'two paid-for postings are kept, not discarded');
    let searched = 0;
    const second = await runHiring({ ...w.deps, serpSearch: async () => { searched++; return { links: [] }; } }, { maxSearches: 1, maxCandidates: 5, refresh: 0 });
    assert.equal(second.verdicts.ready, 2);
    assert.equal(second.pendingAfter, 0);
    assert.equal((await allRecords(w.kv)).length, 3);
    assert.equal(searched, 1, 'a search runs only after the waiting work is done');
});

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
