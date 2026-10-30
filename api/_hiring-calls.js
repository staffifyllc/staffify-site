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
import { HK, MAX_AGE_DAYS, tollFree, getRecord, putRecord, putBacklog, applyOutcome, callRow, callerNumbers, boardKey, domainKey, companyKey, phoneKey, parseAts, hiringCallReady, companyThread, allRecords } from './_hiring-intent.js';
import { hiringCallScript } from './_call-scripts.js';
import { scheduleCallbackTask } from './_callback-task.js';
import { markBad } from './_bad-numbers.js';
import { optOutEverywhere, optOut, isOptedOut } from './_optout.js';
import { maskPhoneRuns } from './_shift.js';
import { clientCheck } from './_client-guard.js';
import { contact as crmContact } from './_outreach-crm.js';
import { crmStop } from './_rep-email-gates.js';
import { loadBad, isBad } from './_bad-numbers.js';
import { KEY as QUEUE_KEY } from './_outreach-queue.js';
import { recordActivity } from './_hub-activity.js';
import { requestStop } from './_outreach-stops.js';

export const isHiringId = id => /^hire:[0-9a-f]{16}$/.test(String(id || ''));

// Paul, 2026-10-28: "The call portal should be able to dispurse more emails and right now its not leaving a trail of
// breadcrumbs". The address a prospect gives on the call goes on the card, so the rep can email them from the Hub
// right away. Only from someone who called them, never for a closed or booked card, and never past a stop.
export async function saveHiringContactEmail(kv, { rep, body }, deps = {}) {
    const id = String(body.id || ''), email = String(body.email || '').trim().toLowerCase(), me = String(rep && rep.email || '').toLowerCase();
    if (email.length > 120 || !/^[^\s@<>()",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(email)) return { ok: false, status: 400, error: 'That does not look like an email address.' };
    const lockKey = HK.recLock(id);
    let locked = false;
    for (let i = 0; i < 8 && !locked; i++) { locked = !!await kv.set(lockKey, '1', { nx: true, ex: 10 }); if (!locked) await new Promise(r => setTimeout(r, 150)); }
    if (!locked) return { ok: false, status: 409, error: 'Someone is saving this card right now. Try again in a moment.' };
    try {
        const rec = await getRecord(kv, id);
        if (!rec) return { ok: false, status: 409, error: 'This prospect is no longer in the call queue' };
        if (rec.booking || ['excluded', 'suppressed'].includes(rec.status)) return { ok: false, status: 409, error: 'This card is closed, so no email goes to it.' };
        let hold = null; try { const h = await kv.get('staffify:call-hold:' + id); hold = typeof h === 'string' ? JSON.parse(h) : h; } catch { hold = null; }
        const called = (rec.callHistory || []).some(h => String(h.caller || '').toLowerCase() === me) || (hold && ['calling', 'called'].includes(hold.kind) && String(hold.by || '').toLowerCase() === me);
        if (!called) return { ok: false, status: 409, error: 'Call them first: an address saved here is one they gave you on the call.' };
        let stop;
        try { stop = await (deps.isOptedOut || isOptedOut)({ email }); } catch { return { ok: false, status: 503, error: 'The do-not-contact list could not be read, so nothing was saved. Try again in a minute.' }; }
        if (stop) return { ok: false, status: 409, error: 'That address is on the do-not-contact list.' };
        const at = new Date().toISOString();
        const { emailSource, emailPerson, emailType, emailGrade, emailCheckedAt, ...c } = rec.contact || {};
        const contact = { ...c, email, candidateEmail: email, status: 'given_on_call', source: 'Given on the call to ' + (rep.name || me), checkedAt: at };
        await putRecord(kv, { ...rec, contact, updatedAt: at });
        await (deps.recordActivity || recordActivity)(kv, { email: me, kind: 'contact_email', page: '/dialer/', detail: rec.company && rec.company.name || id }).catch(() => {});
        return { ok: true, email };
    } finally { await kv.del(lockKey).catch(() => {}); }
}

export async function saveHiringOutcome(kv, { rep, body }, deps = {}) {
    const id = String(body.id || '');
    const outcome = body.action === 'suppress' ? 'suppress' : String(body.outcome || '');
    const lockKey = HK.recLock(id);
    let locked = false;
    for (let i = 0; i < 8 && !locked; i++) { locked = !!await kv.set(lockKey, '1', { nx: true, ex: 10 }); if (!locked) await new Promise(r => setTimeout(r, 150)); }
    if (!locked) return { ok: false, status: 409, error: 'Someone is saving this card right now. Your notes are still here; press save again.' };
    let rec, next, stopped = null;
    try {
        rec = await getRecord(kv, id);
        if (!rec) return { ok: false, status: 409, error: 'This prospect is no longer in the call queue' };
        try { next = applyOutcome(rec, { outcome, notes: body.notes, nextCallAt: body.nextCallAt, dialled: body.dialled }, String(rep.email || '').toLowerCase()); }
        catch (e) { return { ok: false, status: 409, error: e.message }; }
        // A stop is written to the global stop list FIRST (api/_optout.js, read by every send, text and call path): the
        // number they answered on, every number on the card, and their email. If that write fails nothing is saved and
        // the rep presses again; a closed card with no stop behind it could never be completed from the Hub.
        if (outcome === 'suppress') {
            const stop = await stopEverywhere(next, body, deps);
            if (!stop.ok) return { ok: false, status: 503, error: 'The do-not-contact list could not be written just now, so nothing was saved. Your notes are still here; press save again.' };
            stopped = stop;
        }
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
        const gjob = next.job && (next.job.source === 'google_jobs' || next.job.source === 'provided');
        await putBacklog(kv, { id, campaignId: next.campaignId, company: next.company, job: next.job, jobs: next.jobs, contact: next.contact, ...(next.listing ? { listing: next.listing } : {}), ...(next.lead ? { lead: next.lead } : {}), provenance: next.provenance, reason: 'wrong_number', detail: gjob ? 'A caller logged the listed number as wrong. The next run looks for another number on their website, if they have one.' : 'A caller logged the listed number as wrong. The next run looks for another number on their site.', missing: ['phone'], attempts: 0, state: 'open', firstSeenAt: new Date(now).toISOString(), lastTriedAt: null, nextTryAt: new Date(now).toISOString() });
    }
    if (outcome === 'suppress') {
        await markSuppressed(kv, next, rep.email).catch(() => {});
        out.optOut = stopped;
        const email = next.contact && (next.contact.email || next.contact.candidateEmail) || null;
        // The CRM, after the lock (HubSpot can be slow): marked do not contact by email, with their other address and mobile.
        out.crm = await (deps.markCrm || optOutEverywhere)({ email, phone: stopped && stopped.phone || null, reason: 'Not interested / stop on a call', source: 'hub-dialer-hiring' }).then(r => (r && r.crm) || null).catch(() => null);
        // The email worker (api/_outreach-stops.js): this person's Hiring now drip row and any other campaign's row for
        // the address stop, and the CRM marks them do not contact, on its next run. Drafts and sends are refused before
        // then, because the card is suppressed and the address is on the stop list.
        out.engineStop = await (deps.requestStop || requestStop)(kv, { email, hiringId: id, by: rep.email, why: 'Not interested / stop on a call' }).catch(() => ({ ok: false }));
    }
    return out;
}

const ten = n => String(n || '').replace(/\D/g, '').slice(-10);
// The numbers that are the person's own: the one they answered on, and the card's line when a lookup or the lead says it
// is theirs (a looked-up cell, a direct line). A company main line or a listing number never goes on the person's stop
// list unless they answered on it: colleagues answer it. The company itself is closed for discovery (markSuppressed).
const ownLine = rec => { const p = rec.phone || {}; return p.number && (p.source === 'vendor' || /\b(mobile|cell|direct)\b/i.test(String(p.lineType || p.type || ''))) ? p.number : null; };
const personNumbers = (rec, dialled) => [...new Set([dialled, ownLine(rec)].map(ten).filter(d => d.length === 10))];
/** The stop list for a card's person, a quick Redis write made under the card's lock: email and their numbers. */
async function stopEverywhere(rec, body, deps) {
    // Nothing tapped this time (a callback that rang in, a reload, a blocked card): the number of their last logged call.
    const lastDialled = [...(rec.callHistory || [])].reverse().map(h => h && h.dialled).find(Boolean) || null;
    const nums = personNumbers(rec, body.dialled || lastDialled);
    const email = rec.contact && (rec.contact.email || rec.contact.candidateEmail) || null;
    // No address and no number of theirs: the card still closes (and its company with it); there is no person to list.
    if (!nums.length && !email) return { ok: true, reason: 'nothing_to_stop', email: null, phone: null };
    const first = await (deps.optOut || optOut)({ phone: nums[0] ? body.dialled && ten(body.dialled) === nums[0] ? body.dialled : nums[0] : null, email, reason: 'Not interested / stop on a call', source: 'hub-dialer-hiring', text: String(body.notes || '').slice(0, 200) });
    if (!first || !first.ok) return first || { ok: false };
    for (const n of nums.slice(1)) await (deps.optOutNumber || optOut)({ phone: n, reason: 'Not interested / stop on a call', source: 'hub-dialer-hiring (card number)' }).catch(() => {});
    return { ...first, email, phone: nums[0] || null };
}

/** The card's company stays off future runs: its board, listing, number and domain are marked suppressed. */
async function markSuppressed(kv, rec, by) {
    const p = parseAts(rec.job && rec.job.url);
    const mark = JSON.stringify({ id: rec.id, verdict: 'suppressed', at: new Date().toISOString(), by });
    if (p) await kv.hset(HK.companies, { [boardKey(p)]: mark });
    if (rec.job && (rec.job.source === 'google_jobs' || rec.job.source === 'provided') && rec.company) await kv.hset(HK.companies, { [rec.company.board || companyKey(rec.company.name, rec.job.location)]: mark });
    if (rec.phone && rec.phone.number) await kv.hset(HK.companies, { [phoneKey(rec.phone.number)]: mark });
    if (rec.company && rec.company.domain) await kv.hset(HK.companies, { [domainKey(rec.company.domain)]: mark });
}

/**
 * The other direction: someone the email worker stopped (they replied "not interested", unsubscribed, or a person
 * excluded them in the email queue) leaves the call list as well. Their Hiring now card, found by its drip row's card
 * id or by the address on it, is suppressed with the reason; owner and history are kept. Returns the ids changed.
 */
export async function stopHiringCards(kv, { id = null, email = null, phone = null }, { why, by, now = Date.now() } = {}, deps = {}) {
    const e = String(email || '').trim().toLowerCase(), d = ten(phone);
    // By the card's id, the address on it, or the number it rings (a STOP text gives only the number).
    const ids = id ? [id] : e || d.length === 10 ? (await allRecords(kv)).filter(r => (e && r.contact && [r.contact.email, r.contact.candidateEmail].some(x => String(x || '').toLowerCase() === e)) || (d.length === 10 && r.phone && ten(r.phone.number) === d)).map(r => r.id) : [];
    const changed = [];
    for (const cardId of ids) {
        const lock = HK.recLock(cardId);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) continue;
        try {
            const rec = await getRecord(kv, cardId);
            if (!rec || rec.status === 'suppressed') continue;
            const at = new Date(now).toISOString();
            const next = { ...rec, status: 'suppressed', exclusion: { reason: why || 'Stopped in the email queue', at, by: by || null }, updatedAt: at };
            await putRecord(kv, next);
            await markSuppressed(kv, next, by || 'email worker').catch(() => {});
            // Their numbers too: someone who asked by email not to be contacted is not texted or called either.
            for (const n of personNumbers(next)) await (deps.optOutNumber || optOut)({ phone: n, reason: why || 'Stopped in the email queue', source: 'hiring-card-stop' }).catch(() => {});
            changed.push(cardId);
        } finally { await kv.del(lock).catch(() => {}); }
    }
    return changed;
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
    const j = rec.job || {}, c = rec.contact || {}, co = rec.company || {};
    // Never a toll-free line, not even as a backup, and no number while a card waits on a main line (Paul, 2026-10-28).
    const ph = { ...(rec.phone || {}), ...callerNumbers(rec) };
    const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'their website'; } };
    // A researched owner with no email yet ('named') is still the person to ask for.
    const named = c.name && ['verified', 'unconfirmed', 'named', 'given_on_call'].includes(c.status) ? c.name : null;
    // A looked-up line that is the person's own: they pick up, so the opener greets them by name (Paul, 2026-10-28,
    // "the folks I am hitting a gatekeeper each and every single time").
    const direct = ph.source === 'vendor' && !!ph.person;
    const askFor = named || (direct ? ph.person : `whoever is hiring the ${j.title}`);
    const greet = direct ? (named && c.firstName && String(ph.person).toLowerCase().includes(String(c.firstName).toLowerCase()) ? c.firstName : String(ph.person).split(/\s+/)[0]) : named ? c.firstName : '';
    const script = hiringCallScript({ caller, callerEmail, company: co.name, firstName: greet, direct, jobTitle: j.title, family: rec.family, offshore: j.restrictions && j.restrictions.offshore, city: j.city || null });
    const fromListing = ph.source === 'Google business listing';
    const checked = new Date(ph.checkedAt).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    const provided = ph.source === 'provided';
    const vendor = ph.source === 'vendor';
    const dial = ph.number ? { number: ph.number, label: vendor ? `${ph.person ? ph.person + '\'s ' : ''}${ph.lineType || 'number'}, from ${ph.vendor || 'a data vendor'}` : provided ? 'From ' + (ph.foundBy || 'our team') + '\'s research' : fromListing ? 'Main line from their Google business listing' : 'Published on their own website', detail: vendor ? `${ph.person ? ph.person + '\'s ' : 'A '}${ph.lineType || 'number'} at ${co.name} from a ${ph.vendor || 'data vendor'} lookup${ph.grade ? ' (grade ' + ph.grade + ')' : ''}${!ph.siteCheck ? '' : ph.siteCheck.result === 'confirmed' ? ', also on their website' : ', not published on their website'}; checked ${checked}. ${ph.foundBy && ph.foundBy !== ph.vendor ? ph.foundBy + ' found the lead. ' : ''}Ask for ${askFor}.` : provided ? `The number ${ph.foundBy || 'our team'} found for ${co.name}${ph.siteCheck && ph.siteCheck.result === 'confirmed' ? ', also on their website' : ''}, checked ${checked}. Ask for ${askFor}.` : fromListing ? `The main line on their Google business listing (${(co.identity && co.identity.listingName) || co.name}), checked ${checked}. It reaches the business, not a named person: ask for ${askFor}.` : `The company line from ${host(ph.sourceUrl)}, checked ${checked}. It reaches the company, not a named person: ask for ${askFor}.`, alternates: ph.alternates || [], sourceUrl: ph.sourceUrl || null } : null;
    const posted = j.postedAt ? new Date(j.postedAt).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }) : null;
    return { status: 200, body: {
        callable: hiringCallReady(rec), hiring: true, campaignId: rec.campaignId, callQueue: 'shared', callerName: caller,
        company: co.name, website: co.website, recipient: c.email || null,
        name: named, title: named ? c.role : null,
        identity: named ? { status: 'researched', source: c.source + (c.status === 'verified' ? ', email verified' : c.status === 'named' ? ', no email yet' : c.status === 'given_on_call' ? '' : ', email ' + c.status), checkedAt: c.checkedAt } : { status: 'unknown', reason: (c.status === 'lookup_failed' ? 'The contact lookup failed (' + (c.reason || 'error') + ').' : c.status === 'not_searched' ? 'Their Google listing names no website, so no contact search was run.' : 'Findymail found no named contact.') + ' Ask for ' + askFor + '.' },
        industry: { key: 'hiring', label: 'Hiring now', source: 'job post' },
        location: j.location || null, prospectTimezone: null,
        phone: allowed ? ph.number || null : null, dial: allowed ? dial : null,
        phoneEvidence: allowed ? null : { status: 'withheld', detail: shiftGate.message, checkedAt: null, sourceUrl: null },
        shiftGate,
        checkedAt: j.checkedAt,
        why: j.source === 'provided'
            ? `Hiring now: ${j.title}${j.city ? ' in ' + j.city : ''}${j.via ? ', on ' + j.via : ''}. Found by ${j.foundBy || 'our team'}${j.postedLabel ? ' (' + j.postedLabel.replace(/\.$/, '') + ')' : ''}. ${j.workplace === 'remote' ? 'Posted as remote.' : 'Posted as an in-office job: offer a remote person for the seat, do not call it a remote opening.'} Nothing has been emailed; this is the first touch.`
            : j.source === 'google_jobs'
            ? `Hiring now: ${j.title}${j.city ? ' in ' + j.city : ''}, listed on ${j.feed ? j.via || j.feed : 'Google Jobs' + (j.via ? ' via ' + j.via : '')}${posted ? ' around ' + posted : ''}. ${j.workplace === 'remote' ? 'Posted as remote.' : 'Posted as an in-office job: offer a remote person for the seat, do not call it a remote opening.'} A post can be filled any day; this one is under ${MAX_AGE_DAYS} days old. Nothing has been emailed; this is the first touch.`
            : `Hiring now: ${j.title}${posted ? ', posted ' + posted : ''}. Still open on their careers page when checked ${new Date(j.checkedAt).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET. Nothing has been emailed; this is the first touch.`,
        fact: [rec.brief && rec.brief.summary, rec.brief && rec.brief.need].filter(Boolean).join(' '),
        source: { url: j.url },
        job: { source: j.source || 'ats', city: j.city || null, via: j.via || null, feed: j.feed || null, title: j.title, url: j.url, postedAt: j.postedAt, ageDays: j.ageDays, checkedAt: j.checkedAt, location: j.location, workplace: j.workplace, restrictions: j.restrictions, more: (rec.jobs || []).slice(1).map(x => ({ title: x.title, url: x.url })) },
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
    const same = companyThread(rec, state && state.records);
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
