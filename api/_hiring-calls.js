// A caller's outcome on a Hiring now card, saved to the hiring store (not the email queue).
// ------------------------------------------------------------------
// The dialer posts the same call-outcome and suppress actions for every card; api/outreach-queue.js
// hands 'hire:' ids here. Same rules as the email campaigns (api/_hiring-intent.js applyOutcome),
// same side effects where they apply:
//   callback / gatekeeper  a HubSpot task, when the caller has a HubSpot user
//   wrong number           the number is marked bad for this card only and the card goes to the
//                          research backlog, where the next run looks for a different listed number
//   not interested / stop  the card is closed, the company never comes back through this campaign,
//                          and the number dialled (the card's number when none was recorded) and any
//                          contact email go through optOutEverywhere: the global list every campaign
//                          checks, plus the CRM contact's other address and number
//   timing                 comes back on the date given. No nurture email: this campaign is call-first.
import { HK, MAX_AGE_DAYS, getRecord, putRecord, putBacklog, applyOutcome, callRow, boardKey, domainKey, companyKey, phoneKey, parseAts, hiringCallReady } from './_hiring-intent.js';
import { hiringCallScript } from './_call-scripts.js';
import { scheduleCallbackTask } from './_callback-task.js';
import { markBad } from './_bad-numbers.js';
import { optOutEverywhere, isOptedOut } from './_optout.js';
import { maskPhoneRuns } from './_shift.js';
import { clientCheck } from './_client-guard.js';
import { contact as crmContact } from './_outreach-crm.js';
import { crmStop } from './_rep-email-gates.js';
import { loadBad, isBad } from './_bad-numbers.js';
import { KEY as QUEUE_KEY } from './_outreach-queue.js';
import { recordActivity } from './_hub-activity.js';

export const isHiringId = id => /^hire:[0-9a-f]{16}$/.test(String(id || ''));

export async function saveHiringOutcome(kv, { rep, body }, deps = {}) {
    const id = String(body.id || '');
    const outcome = body.action === 'suppress' ? 'suppress' : String(body.outcome || '');
    const lockKey = HK.recLock(id);
    let locked = false;
    for (let i = 0; i < 8 && !locked; i++) { locked = !!await kv.set(lockKey, '1', { nx: true, ex: 10 }); if (!locked) await new Promise(r => setTimeout(r, 150)); }
    if (!locked) return { ok: false, status: 409, error: 'Someone is saving this card right now. Your notes are still here; press save again.' };
    let rec, next;
    try {
        rec = await getRecord(kv, id);
        if (!rec) return { ok: false, status: 409, error: 'This prospect is no longer in the call queue' };
        try { next = applyOutcome(rec, { outcome, notes: body.notes, nextCallAt: body.nextCallAt, dialled: body.dialled }, String(rep.email || '').toLowerCase()); }
        catch (e) { return { ok: false, status: 409, error: e.message }; }
        await putRecord(kv, next);
    } finally { await kv.del(lockKey).catch(() => {}); }

    const row = callRow(next, rep.email);
    const co = next.company && next.company.name || null;
    const act = deps.recordActivity || recordActivity;
    await act(kv, { email: rep.email, kind: outcome === 'suppress' ? 'suppress' : 'call_outcome', page: '/dialer/', detail: [co, outcome].filter(Boolean).join(' · ') }).catch(() => {});
    if (String(body.notes || '').trim()) await act(kv, { email: rep.email, kind: 'note_saved', page: '/dialer/', detail: co }).catch(() => {});
    if (outcome === 'callback' && body.nextCallAt) await act(kv, { email: rep.email, kind: 'callback_set', page: '/dialer/', detail: co }).catch(() => {});

    const out = { ok: true, record: next };
    if ((outcome === 'callback' || outcome === 'gatekeeper') && body.nextCallAt) out.callbackTask = await (deps.scheduleCallbackTask || scheduleCallbackTask)({ redis: kv, row, rep, nextCallAt: body.nextCallAt, notes: body.notes });
    if (outcome === 'wrong_number') {
        const known = [next.phone && next.phone.number, ...((next.phone && next.phone.alternates) || [])].filter(Boolean);
        out.wrongNumber = body.dialled ? await (deps.markBad || markBad)(kv, { email: id, phone: body.dialled, known, by: rep.email }) : { ok: false, reason: 'the dialled number was not recorded' };
        const now = Date.now();
        const gjob = next.job && next.job.source === 'google_jobs';
        await putBacklog(kv, { id, campaignId: next.campaignId, company: next.company, job: next.job, jobs: next.jobs, contact: next.contact, ...(next.listing ? { listing: next.listing } : {}), provenance: next.provenance, reason: 'wrong_number', detail: gjob ? 'A caller logged the listed number as wrong. The next run looks for another number on their website, if they have one.' : 'A caller logged the listed number as wrong. The next run looks for another number on their site.', missing: ['phone'], attempts: 0, state: 'open', firstSeenAt: new Date(now).toISOString(), lastTriedAt: null, nextTryAt: new Date(now).toISOString() });
    }
    if (outcome === 'suppress') {
        const p = parseAts(next.job && next.job.url);
        const mark = JSON.stringify({ id, verdict: 'suppressed', at: new Date().toISOString(), by: rep.email });
        if (p) await kv.hset(HK.companies, { [boardKey(p)]: mark });
        if (next.job && next.job.source === 'google_jobs' && next.company) await kv.hset(HK.companies, { [companyKey(next.company.name, next.job.location)]: mark });
        if (next.phone && next.phone.number) await kv.hset(HK.companies, { [phoneKey(next.phone.number)]: mark });
        if (next.company && next.company.domain) await kv.hset(HK.companies, { [domainKey(next.company.domain)]: mark });
        // The global stop list (api/_optout.js), read by every send, text and call path: the number they
        // answered on and, if we have one, their email. A phone-only card is still stopped everywhere.
        const phone = String(body.dialled || '').replace(/\D/g, '').slice(-10).length === 10 ? body.dialled : next.phone && next.phone.number;
        out.optOut = await (deps.optOut || optOutEverywhere)({ phone: phone || null, email: next.contact && (next.contact.email || next.contact.candidateEmail) || null, reason: 'Not interested / stop on a call', source: 'hub-dialer-hiring', text: String(body.notes || '').slice(0, 200) });
    }
    return out;
}

/**
 * The card a caller sees for a Hiring now record: the job and its proof, the company line and where
 * it is published, the contact as verified, and the call-first script. The number is withheld off
 * shift, exactly as for every other card.
 */
export async function hiringBrief(kv, { id, caller, callerEmail, shiftGate }, deps = {}) {
    let rec = await getRecord(kv, id);
    if (!rec) return { status: 404, body: { error: 'Record not available' } };
    // Re-checked every time the card opens, before any number is shown (PM, 2026-10-27): someone who
    // opted out, became a client, replied or was taken by a person since the card was built.
    const allowed = !shiftGate || shiftGate.allowed;
    // Off shift, no number leaves here in any field: not the dialled one on a past call, not one typed in a note.
    const history = h => (allowed ? h : (h || []).map(c => (c && typeof c === 'object' ? { ...c, dialled: c.dialled ? null : c.dialled, notes: typeof c.notes === 'string' ? maskPhoneRuns(c.notes) : c.notes } : c)));
    const check = await liveStops(rec, { kv, ...deps });
    if (check.stop || check.unavailable) {
        const message = check.stop ? 'Do not call: ' + check.stop : 'Call check unavailable. Do not call yet. ' + check.unavailable;
        if (check.stop && !check.keep) rec = await closeCard(kv, rec, check.stop);
        const j = rec.job || {}, co = rec.company || {};
        return { status: check.stop ? 409 : 503, body: { error: message, callable: false, hiring: true, recipient: rec.contact && rec.contact.email || null, company: co.name, website: co.website, source: { url: j.url, excerpt: rec.brief && rec.brief.summary }, events: [], callHistory: history(rec.callHistory), sentTouches: 0, syncedAt: j.checkedAt } };
    }
    const j = rec.job || {}, c = rec.contact || {}, ph = rec.phone || {}, co = rec.company || {};
    const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'their website'; } };
    const named = c.name && (c.status === 'verified' || c.status === 'unconfirmed') ? c.name : null;
    const askFor = named || `whoever is hiring the ${j.title}`;
    const script = hiringCallScript({ caller, callerEmail, company: co.name, firstName: named ? c.firstName : '', jobTitle: j.title, family: rec.family, offshore: j.restrictions && j.restrictions.offshore, city: j.city || null });
    const fromListing = ph.source === 'Google business listing';
    const checked = new Date(ph.checkedAt).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    const dial = ph.number ? { number: ph.number, label: fromListing ? 'Main line from their Google business listing' : 'Published on their own website', detail: fromListing ? `The main line on their Google business listing (${(co.identity && co.identity.listingName) || co.name}), checked ${checked}. It reaches the business, not a named person: ask for ${askFor}.` : `The company line from ${host(ph.sourceUrl)}, checked ${checked}. It reaches the company, not a named person: ask for ${askFor}.`, alternates: ph.alternates || [], sourceUrl: ph.sourceUrl || null } : null;
    const posted = j.postedAt ? new Date(j.postedAt).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }) : null;
    return { status: 200, body: {
        callable: hiringCallReady(rec), hiring: true, campaignId: rec.campaignId, callQueue: 'shared', callerName: caller,
        company: co.name, website: co.website, recipient: c.email || null,
        name: named, title: named ? c.role : null,
        identity: named ? { status: 'researched', source: c.source + (c.status === 'verified' ? ', email verified' : ', email ' + c.status), checkedAt: c.checkedAt } : { status: 'unknown', reason: (c.status === 'lookup_failed' ? 'The contact lookup failed (' + (c.reason || 'error') + ').' : c.status === 'not_searched' ? 'Their Google listing names no website, so no contact search was run.' : 'Findymail found no named contact.') + ' Ask for ' + askFor + '.' },
        industry: { key: 'hiring', label: 'Hiring now', source: 'job post' },
        location: j.location || null, prospectTimezone: null,
        phone: allowed ? ph.number || null : null, dial: allowed ? dial : null,
        phoneEvidence: allowed ? null : { status: 'withheld', detail: shiftGate.message, checkedAt: null, sourceUrl: null },
        shiftGate,
        checkedAt: j.checkedAt,
        why: j.source === 'google_jobs'
            ? `Hiring now: ${j.title}${j.city ? ' in ' + j.city : ''}, listed on Google Jobs${j.via ? ' via ' + j.via : ''}${posted ? ' around ' + posted : ''}. ${j.workplace === 'remote' ? 'Posted as remote.' : 'Posted as an in-office job: offer a remote person for the seat, do not call it a remote opening.'} A post can be filled any day; this one is under ${MAX_AGE_DAYS} days old. Nothing has been emailed; this is the first touch.`
            : `Hiring now: ${j.title}${posted ? ', posted ' + posted : ''}. Still open on their careers page when checked ${new Date(j.checkedAt).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET. Nothing has been emailed; this is the first touch.`,
        fact: [rec.brief && rec.brief.summary, rec.brief && rec.brief.need].filter(Boolean).join(' '),
        source: { url: j.url },
        job: { source: j.source || 'ats', city: j.city || null, via: j.via || null, title: j.title, url: j.url, postedAt: j.postedAt, ageDays: j.ageDays, checkedAt: j.checkedAt, location: j.location, workplace: j.workplace, restrictions: j.restrictions, more: (rec.jobs || []).slice(1).map(x => ({ title: x.title, url: x.url })) },
        companyIdentity: co.identity, openRoles: co.openRoles, contactStatus: c.status || null,
        nextStep: rec.brief && rec.brief.nextStep, provenance: rec.provenance,
        events: [], callHistory: history(rec.callHistory),
        ...script,
    } };
}

/**
 * Every control a call must clear right now. { stop } is a definite no (the card leaves the queue);
 * { unavailable } means a check could not run (the card stays, nothing is shown). Never a pass on error.
 */
export async function liveStops(rec, deps = {}) {
    const d = { isOptedOut, clientCheck, crmContact, crmStop, loadBad, isBad, queueState: kv => kv.get(QUEUE_KEY), kv: null, ...deps };
    const email = rec.contact && (rec.contact.email || rec.contact.candidateEmail) || null;
    const numbers = [rec.phone && rec.phone.number, ...((rec.phone && rec.phone.alternates) || [])].filter(Boolean);
    try {
        for (const n of numbers) if (await d.isOptedOut({ phone: n })) return { stop: 'a number on this card is on the do-not-contact list.' };
        if (email && await d.isOptedOut({ email })) return { stop: 'this contact is on the do-not-contact list.' };
    } catch { return { unavailable: 'The do-not-contact list could not be read.' }; }
    const client = await d.clientCheck({ email, company: rec.company && rec.company.name }).catch(() => ({ status: 'unknown' }));
    if (client.status === 'client') return { stop: 'this business is a Staffify client.' };
    // Kept, not closed: a name match is a question for a person, not a verdict.
    if (client.status === 'possible') return { stop: 'the company name matches a Staffify client. Check with Paul first.', keep: true };
    if (client.status !== 'clear') return { unavailable: 'The client list could not be checked.' };
    if (email) {
        let props = null;
        try { const c = await d.crmContact(email); props = c && c.properties || null; }
        catch (e) { if (!/CRM contact missing/.test(String(e && e.message))) return { unavailable: 'The CRM could not be checked.' }; }
        const crm = d.crmStop(props);
        if (crm) return { stop: 'CRM: ' + crm };
    }
    // Anyone at this company now in an email thread (a reply, a person's conversation, a stop) is worked there.
    let state;
    try { state = await d.queueState(d.kv); } catch { return { unavailable: 'The outreach queue could not be read.' }; }
    const domain = rec.company && rec.company.domain;
    const same = (state && state.records || []).find(r => { const rd = String(r.recipient || '').toLowerCase().split('@')[1]; return (email && String(r.recipient || '').toLowerCase() === email) || (domain && rd && rd.replace(/^www\./, '') === domain); });
    if (same) return { stop: 'someone at this company is already in a Staffify email thread (' + (same.status || 'queued') + '). Work it there.' };
    try {
        const bad = await d.loadBad(d.kv, rec.id);
        if (rec.phone && rec.phone.number && d.isBad(bad, rec.phone.number)) return { stop: 'this number was logged as wrong. A new one is being looked for.' };
    } catch { return { unavailable: 'The wrong-number list could not be read.' }; }
    return {};
}

/** A card that must not be called any more: out of the queue, history and owner kept, reason on it. */
async function closeCard(kv, rec, why) {
    if (rec.status !== 'ready') return rec;
    const at = new Date().toISOString();
    const next = { ...rec, status: /wrong/.test(why) ? 'number_research' : 'excluded', exclusion: { reason: why, at }, updatedAt: at };
    await putRecord(kv, next);
    return next;
}
