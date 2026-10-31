// Who the nurture may never email. Asked when someone is enrolled, and again before every touch.
// ------------------------------------------------------------------
// The 2026-10-30 trace found two holes. The client check read fields the client guard never returns
// (isClient, match), so a real client logged "Not now" was enrolled, and a guard that could not answer
// passed as well. And nothing at send time looked at bookings, so a "Not now" lead who then booked a
// Discovery call still got the day 7, 14 and 21 emails until somebody clicked "Client".
//
// Every answer comes from a store the rest of the stack already reads. Nothing here is a new list.
//   client      clientCheck (api/_client-guard.js), by its real shape: only 'clear' passes
//   booked      bookedIdentity (api/_booked-leads.js) on the address and the company's own domain, and
//               the booking note the booked-leads sweep puts on the person's queue rows
//   stop list   the queue's own suppressions and row status (rowStop, api/_rep-email-gates.js), and every
//               number on file for them (knownNumbers) against the STOP list
//   opted out   the global do-not-contact list, which the cron reads strictly before any of this
//   CRM         HubSpot do not contact (crmDoNotContact), or a customer; after a rep's "Not now", also an
//               open deal or a conversation Paul or Madison owns (as crmStop and draftBlockReason stop on)
// A check that cannot run is a hold, never a pass: the enrolment is refused, or the touch stays unsent
// and the next run asks again.
import { bookingKeys, bookedIdentity } from './_booked-leads.js';
import { KEY as QUEUE_KEY } from './_outreach-queue.js';
import { rowStop, knownNumbers, crmDoNotContact } from './_rep-email-gates.js';

// enrolled_source of a rep's "Not now" (api/_nurture-enrol.js).
export const CALL_SOURCE = 'call-timing';

// What the rep reads after "Saved. Not added to the nurture: ...". Plain words, never a code.
export const SKIP_MESSAGES = {
    'no email': 'there is no email address for them',
    'already in nurture': 'they have already been added to it',
    'opted out': 'they asked not to be contacted',
    'booked': 'they have booked a call',
    'booking check unavailable': 'the booked-call list could not be checked just now',
    'existing client': 'already a client',
    'possible client': 'their company name matches a client, so check with Paul first',
    'client check unavailable': 'the client list could not be checked just now',
    'enrolment failed': 'it could not be saved just now',
};
export const skipped = (reason, detail) => ({ enrolled: false, reason, message: SKIP_MESSAGES[reason] || SKIP_MESSAGES['enrolment failed'], ...(detail ? { detail } : {}) });

const norm = e => String(e || '').trim().toLowerCase();
const site = d => norm(d).replace(/^www\./, '');
const last10 = p => String(p || '').replace(/\D/g, '').slice(-10);
const parse = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

/** The client guard's answer as a verdict. Only 'clear' passes; an answer the guard could not give is a hold. */
export function clientVerdict(c) {
    const status = c && c.status;
    if (status === 'clear') return null;
    if (status === 'client') return { verdict: 'stop', reason: 'existing client' };
    // A company-name match is a flag for a person, not a verdict (api/_client-guard.js). The drip waits for nobody.
    if (status === 'possible') return { verdict: 'stop', reason: 'possible client' };
    return { verdict: 'hold', reason: 'client check unavailable' };
}

/**
 * Every stored booking for this address or a company domain of theirs: the domains given (a queue row's
 * own site) and the address's own domain unless it is a shared mailbox. Throws if the list cannot be read.
 */
export async function bookingsFor(kv, email, domains = []) {
    const out = [];
    const byEmail = await bookedIdentity(kv, { email });
    if (byEmail) out.push(byEmail);
    const own = (bookingKeys(email) || {}).domain;
    for (const domain of [...new Set([...domains, own].map(site).filter(Boolean))]) {
        const note = await bookedIdentity(kv, { domain });
        if (note) out.push(note);
    }
    return out;
}

/**
 * Does this booking end their nurture? After a rep's "Not now", any booking does: they were not booked
 * when they were enrolled. The post-call nurture (Paul's "Not a fit", the backfill of booked calls)
 * exists because of a Discovery call, so there only a meeting after the enrolment counts. A booking
 * whose time cannot be read counts.
 */
export function bookingEnds(rec, note) {
    if (!note) return false;
    if (!rec || rec.enrolled_source === CALL_SOURCE) return true;
    const meeting = Date.parse(note.startTime || note.at || ''), enrolled = Number(rec.enrolled_at);
    if (!Number.isFinite(meeting) || !Number.isFinite(enrolled) || !enrolled) return true;
    return meeting > enrolled;
}

/**
 * Before a nurture touch goes out: null to send it, or { verdict: 'stop' | 'hold', reason, detail? }.
 * A stop ends the nurture for them; a hold leaves the touch unsent for the next run.
 *   kv           the store (the queue, the booked identities, the dialer's number stores)
 *   optedOut     the STOP list as optedOutSet({ strict: true }) read it: { emails, numbers }
 *   contact      HubSpot by address (api/_outreach-crm.js); throws 'CRM contact missing' when there is none
 *   clientCheck  api/_client-guard.js
 *   queueState   reads the call queue; the cron passes one read shared by the whole run, the queue being megabytes
 */
export async function sendGate(email, rec, { kv, optedOut, contact, clientCheck, queueState = () => kv.get(QUEUE_KEY) }) {
    const addr = norm(email);
    const hold = (reason, detail) => ({ verdict: 'hold', reason, ...(detail ? { detail } : {}) });
    const stop = (reason, detail) => ({ verdict: 'stop', reason, ...(detail ? { detail } : {}) });
    if (!optedOut || !(optedOut.numbers instanceof Set) || !(optedOut.emails instanceof Set)) return hold('stop list unavailable');
    if (optedOut.emails.has(addr)) return stop('opted out');

    // The queue: its own suppressions (Not interested / stop), the status of each of their rows.
    let state;
    try { state = parse(await queueState()); } catch { return hold('queue unavailable'); }
    if (!state || !Array.isArray(state.records)) return hold('queue unavailable');
    if ((state.suppressions || []).map(norm).includes(addr)) return stop('stop list', 'Not interested / stop in the Hub');
    const rows = state.records.filter(r => norm(r.recipient) === addr);
    for (const r of rows) { const why = rowStop(r); if (why) return stop('stop list', why); }

    // A Discovery call booked by them or their company.
    let notes;
    try { notes = [...rows.map(r => r.booking).filter(Boolean), ...await bookingsFor(kv, addr, [rec && rec.domain, ...rows.map(r => r.agencyKey)])]; }
    catch { return hold('booking check unavailable'); }
    if (notes.some(n => bookingEnds(rec, n))) return stop('booked');

    // Every number on file for them, against the STOP list.
    let numbers;
    try { numbers = (await Promise.all((rows.length ? rows : [{ recipient: addr }]).map(r => knownNumbers(r, kv)))).flat(); }
    catch { return hold('stop list unavailable'); }
    if (numbers.some(n => optedOut.numbers.has(n))) return stop('opted out', 'a number on file replied STOP');

    // HubSpot: do not contact, a customer, or (after a "Not now") in a conversation. Nobody there by this
    // address is not a stop; the client guard still runs.
    let props = null;
    try { const c = await contact(addr); props = (c && c.properties) || null; }
    catch (e) { if (!/CRM contact missing/.test(String(e && e.message))) return hold('CRM unavailable'); }
    const dnc = crmDoNotContact(props);
    if (dnc) return stop('do not contact', dnc);
    if (props && props.lifecyclestage === 'customer') return stop('existing client', 'the CRM records them as a customer');
    if ([props && props.phone, props && props.mobilephone].map(last10).some(n => n.length === 10 && optedOut.numbers.has(n))) return stop('opted out', 'a number on file replied STOP');
    // After a rep's "Not now": an open deal, or a conversation Paul or Madison owns, is not a drip's to
    // interrupt. Every other automated email stops on these (crmStop, api/_rep-email-gates.js; draftBlockReason,
    // api/_outreach-crm.js). Not for the post-call nurture: it follows a Discovery call, and that contact can
    // still be an opportunity.
    const talking = rec && rec.enrolled_source === CALL_SOURCE && props && (
        props.lifecyclestage === 'opportunity' ? 'the CRM shows an open deal, which Paul handles'
        : props.rep_lifecycle_state === 'HUMAN_OWNED' ? 'Paul or Madison owns this conversation in the CRM'
        : props.rep_outreach_mode && props.rep_outreach_mode !== 'AUTOMATED' ? 'Paul is handling them himself (' + props.rep_outreach_mode + ')'
        : null);
    if (talking) return stop('in a conversation', talking);

    // The client guard, by the answer it actually gives.
    let client = null;
    try { client = await clientCheck({ email: addr, company: (rec && rec.company) || '' }); } catch { client = null; }
    const verdict = clientVerdict(client);
    if (verdict) return { ...verdict, ...(client && (client.reason || client.why) ? { detail: client.reason || client.why } : {}) };
    return null;
}
