// A booked call takes the lead off every list a person or the machine works from.
// ------------------------------------------------------------------
// Paul, 2026-10-28: "if someone books a discovery call it should remove that lead from the database".
//
// Removed means: never offered as a call again, never sent another automated email, never texted
// (api/send-text.js). Nothing is deleted (standing rule): the record stays with its history, owner and
// replies, marked with the booking, so reports and the campaign pages still count it. A cancelled
// meeting does not put anyone back on a cold list; a person decides that.
//
// Two ways in, so a booking is caught even if Calendly's webhook never arrives: the webhook the moment
// someone books (api/calendly-webhook.js), and a sweep of Calendly's own list of meetings
// (api/booked-leads.js, every 15 minutes), which also catches bookings made before this existed.
//
// Scope (PM, 2026-10-28, Paul's standing rule): Discovery calls only, by the event's name: Staffify
// Leads Discovery, Discovery, 30 Minute Discovery, Enterprise Discovery, Milton's Discovery call. The
// same test the daily report uses. A client follow-up, an interview or a strategy session is not one.
//
// Lasting: every booking is kept as an identity (the email, and the company's own domain). A lead
// that reaches a list after the booking is still caught: the email worker will not draft or send to
// it (api/outreach-worker.js), a Hiring now import will not make a card of it (api/_hiring-run.js),
// and every sweep marks any record that matches a stored identity.
//
// What matches a booking to a lead:
//   outreach queue   the invitee's email is the record's recipient, or the invitee's email domain is
//                    that agency's own website (agencyKey). A shared mailbox domain never matches alone.
//   Hiring now       the card's contact email, or the employer's own website domain.
import { HK as HIRE, allRecords, getRecord, putRecord, domainKey } from './_hiring-intent.js';
import { KEY } from './_outreach-queue.js';

export const LOG = 'staffify:booked:log';
export const EVENTS = 'staffify:booked:events';
export const IDENTITIES = 'staffify:booked:identities';
export const inScope = name => /\bdiscovery\b/i.test(String(name || ''));
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|pm|gmx|mail|zoho|yandex|comcast|att|verizon|sbcglobal|bellsouth|cox|charter)\.[a-z.]+$/i;
const CAS = `local raw=redis.call('GET',KEYS[1]); local rev=0; if raw then rev=cjson.decode(raw).revision or 0 end; if rev~=tonumber(ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1`;
const parse = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
const host = d => String(d || '').toLowerCase().replace(/^www\./, '');

/** The email and, when it is a company's own, the domain a booking is matched on. */
export function bookingKeys(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
    const d = e.split('@')[1];
    return { email: e, domain: FREE_MAIL.test(d) ? null : d };
}

/** Is this email or company domain one that booked a Discovery call? The stored note, or null. Throws if unreadable. */
export async function bookedIdentity(kv, { email, domain }) {
    const e = String(email || '').trim().toLowerCase(), d = host(domain);
    for (const f of [e && 'email:' + e, d && !FREE_MAIL.test(d) && 'domain:' + d].filter(Boolean)) {
        const v = parse(await kv.hget(IDENTITIES, f));
        if (v) return v;
    }
    return null;
}

/** Pure: mark the queue records this booking matches. Returns the ids it changed. */
export function markQueue(state, booking, { onlyUnmarked = false } = {}) {
    const k = bookingKeys(booking.email);
    if (!k || !state || !Array.isArray(state.records)) return [];
    const changed = [];
    for (const r of state.records) {
        if (onlyUnmarked && r.booking) continue;
        const byEmail = String(r.recipient || '').toLowerCase() === k.email;
        const byDomain = !!k.domain && host(r.agencyKey) === k.domain;
        if (!byEmail && !byDomain) continue;
        if (r.booking && r.booking.inviteeUri && r.booking.inviteeUri === booking.inviteeUri) continue;
        r.booking = { ...booking, matchedBy: byEmail ? 'email' : 'domain', previousStatus: r.status || null };
        r.callReady = false;
        changed.push(r.id);
    }
    return changed;
}

/** Does this Hiring now card belong to the booking? */
export function hiringMatches(rec, booking) {
    const k = bookingKeys(booking.email);
    if (!k || !rec) return false;
    const c = rec.contact || {};
    if ([c.email, c.candidateEmail].some(x => String(x || '').toLowerCase() === k.email)) return true;
    return !!k.domain && host(rec.company && rec.company.domain) === k.domain;
}
// Only cards still in play change status; one already excluded or stopped just carries the note.
const OPEN = new Set(['ready', 'number_research', 'research', 'conversation']);

/**
 * Take the booked lead off the lists. booking: { email, inviteeUri, eventUri, eventName, startTime, source }.
 * Throws if a store cannot be written, so the webhook asks Calendly to send it again.
 */
export async function removeBookedLead(kv, booking, now = Date.now()) {
    const at = new Date(now).toISOString();
    if (!inScope(booking.eventName)) return { queue: [], hiring: [], skipped: 'not a Discovery call' };
    const k = bookingKeys(booking.email);
    if (!k) return { queue: [], hiring: [], skipped: 'no usable email' };
    const note = { at, email: k.email, inviteeUri: booking.inviteeUri || null, eventUri: booking.eventUri || null, eventName: booking.eventName || null, startTime: booking.startTime || null, source: booking.source || 'calendly' };
    // The identity first, so a lead that appears later is still caught even if nothing matches today.
    await kv.hset(IDENTITIES, { ['email:' + k.email]: JSON.stringify(note), ...(k.domain ? { ['domain:' + k.domain]: JSON.stringify(note) } : {}) });
    // Hiring now's own company index too, card or no card: a research entry or a later post from this
    // employer is then 'in outreach' and never becomes a cold card (api/_hiring-run.js processPosting).
    if (k.domain) await kv.hset(HIRE.companies, { [domainKey(k.domain)]: JSON.stringify({ verdict: 'in_outreach', via: 'booked', at }) });
    return applyBookings(kv, [note], now);
}

/** Mark every record, queue and Hiring now, that matches one of these bookings. */
export async function applyBookings(kv, notes, now = Date.now(), { onlyUnmarked = false } = {}) {
    const at = new Date(now).toISOString();
    if (!notes.length) return { queue: [], hiring: [] };
    // The queue: one compare-and-set write of the whole state, retried if another writer got there first.
    let queue = [];
    for (let i = 0; i < 6; i++) {
        const state = parse(await kv.get(KEY));
        if (!state) break;
        const ids = [...new Set(notes.flatMap(n => markQueue(state, n, { onlyUnmarked })))];
        if (!ids.length) break;
        const next = { ...state, revision: (state.revision || 0) + 1, updatedAt: at };
        if (Number(await kv.eval(CAS, [KEY], [String(state.revision || 0), JSON.stringify(next)])) === 1) { queue = ids; break; }
        if (i === 5) throw Error('The call queue kept changing; try again');
    }
    // Hiring now: each card under its own lock, everything else on it kept.
    const hiring = [];
    for (const rec of (await allRecords(kv)).filter(r => !(onlyUnmarked && r.booking) && notes.some(n => hiringMatches(r, n)))) {
        const note = notes.find(n => hiringMatches(rec, n));
        const lock = HIRE.recLock(rec.id);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) throw Error('A caller is saving that card; try again');
        try {
            const fresh = await getRecord(kv, rec.id);
            if (!fresh || (onlyUnmarked && fresh.booking) || (fresh.booking && fresh.booking.inviteeUri && fresh.booking.inviteeUri === note.inviteeUri)) continue;
            await putRecord(kv, { ...fresh, booking: { ...note, previousStatus: fresh.status }, ...(OPEN.has(fresh.status) ? { status: 'booked' } : {}), updatedAt: at });
            // A later post from the same employer is not a new cold card.
            if (fresh.company && fresh.company.domain) await kv.hset(HIRE.companies, { [domainKey(fresh.company.domain)]: JSON.stringify({ id: fresh.id, verdict: 'in_outreach', via: 'booked', at }) });
            hiring.push(fresh.id);
        } finally { await kv.del(lock).catch(() => {}); }
    }
    if (queue.length || hiring.length) {
        await kv.lpush(LOG, JSON.stringify({ at, emails: notes.map(n => n.email).slice(0, 20), events: [...new Set(notes.map(n => n.eventName))], queue, hiring, reapplied: onlyUnmarked }));
        await kv.ltrim(LOG, 0, 199);
    }
    return { queue, hiring };
}

/** Every stored booking, applied again to anything that reached a list after it. */
export async function reapplyBookings(kv, now = Date.now()) {
    const all = (await kv.hgetall(IDENTITIES)) || {};
    const notes = [...new Map(Object.entries(all).filter(([f]) => f.startsWith('email:')).map(([, v]) => parse(v)).filter(Boolean).map(n => [n.email, n])).values()];
    return applyBookings(kv, notes, now, { onlyUnmarked: true });
}

/**
 * The backstop: Calendly's own list of meetings (booked in the last 30 days, or ahead), each
 * meeting's invitees taken off the lists once. A read that fails throws: never "no bookings".
 * deps: { whoAmI, events({ since, until, organization }), invitees(eventUri) }
 */
export async function sweepBookings(kv, deps, { now = Date.now(), maxEvents = 40 } = {}) {
    const me = await deps.whoAmI();
    const { items } = await deps.events({ since: new Date(now - 30 * 864e5).toISOString(), until: new Date(now + 120 * 864e5).toISOString(), organization: me.organization });
    const seen = (await kv.hgetall(EVENTS)) || {};
    const todo = (items || []).filter(e => e && e.uri && !seen[e.uri]).slice(0, maxEvents);
    const out = { events: (items || []).length, discovery: (items || []).filter(e => inScope(e && e.name)).length, checked: 0, removed: 0, leads: [] };
    for (const ev of todo) {
        // Not a Discovery call: noted as looked at, never read further.
        if (!inScope(ev.name)) { await kv.hset(EVENTS, { [ev.uri]: JSON.stringify({ at: new Date(now).toISOString(), skipped: 'not a Discovery call', name: ev.name || null }) }); continue; }
        const people = await deps.invitees(ev.uri);
        for (const p of people) {
            if (p.status && p.status !== 'active') continue;
            const r = await removeBookedLead(kv, { email: p.email, inviteeUri: p.uri || null, eventUri: ev.uri, eventName: ev.name || null, startTime: ev.start_time || null, source: 'calendly sweep' }, now);
            if (r.queue.length || r.hiring.length) { out.removed++; out.leads.push({ email: p.email, queue: r.queue.length, hiring: r.hiring.length }); }
        }
        await kv.hset(EVENTS, { [ev.uri]: JSON.stringify({ at: new Date(now).toISOString(), invitees: people.length, name: ev.name || null }) });
        out.checked++;
    }
    const again = await reapplyBookings(kv, now);
    out.reapplied = { queue: again.queue.length, hiring: again.hiring.length };
    return out;
}
