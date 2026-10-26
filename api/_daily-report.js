// A caller's day, reported from the records that prove it.
// ------------------------------------------------------------------
// Paul, 2026-10-26 (through Codex): "I want a daily report of his calls made and his performance."
//
// Four sources, each named on the report, none standing in for another:
//   Quo        the phone system. Outbound calls placed by this person's own Quo user (actorId), so a
//              shared line's other users are never counted. A call is VERIFIED only here.
//   Hub log    the outcomes the rep logged on a card (callHistory). Manual. A logged outcome with no
//              Quo call behind it is shown as such, never counted as a verified attempt.
//   Calendly   discovery meetings, by when they were BOOKED (created_at), credited only when the
//              invitee is a prospect this rep logged a call with before the booking. A booking-link
//              click is not a meeting.
//   Hub        the declared shift (Start / Break / End) and the observed activity estimate.
//
// What is never proof of a call: a Call now click, a phone link, a saved note, any "action".
// Nothing here judges performance or sets a quota. Rates appear only with a stated, non-zero
// denominator. A source that could not be read is "unavailable", never zero.
import { KEY as QUEUE_KEY, visibleState } from './_outreach-queue.js';
import { quoConfigured, listUsers, listCalls, findSeat, counterparty, connected, talkSeconds, etDay, etDayBounds } from './_quo.js';
import { calendlyConfigured, whoAmI, pastEvents, invitees } from './_calendly.js';
import { loginAliases } from './_login-aliases.js';
import { K as ACT, sessionsOn, summarizeDay, EVENT_KINDS } from './_hub-activity.js';
import { shiftsOn } from './_shift.js';

export const REPORT_VERSION = 1;
export const TZ = 'America/New_York';
const norm = e => String(e || '').trim().toLowerCase();
export const RK = {
    snapshot: (email, day) => `report:daily:${norm(email)}:${day}`,
    delivery: (email, day) => `report:daily:delivery:${norm(email)}:${day}`,
    lease: (email, day) => `report:daily:lease:${norm(email)}:${day}`,
};
export const RETAIN_DAYS = 400;
export const last10 = p => String(p || '').replace(/\D/g, '').slice(-10);
/** Only the last four digits ever appear on the report: enough to match a call, no number to dial. */
export const tail4 = p => { const d = last10(p); return d.length === 10 ? '•••' + d.slice(-4) : null; };
const ms = s => Date.parse(s);
const iso = t => new Date(t).toISOString();

/** The ET calendar day before `now`. */
export function previousDay(now = Date.now()) { return etDay(new Date(Date.parse(etDay(new Date(now)) + 'T12:00:00Z') - 86400000)); }
/** The instants that bound an ET day, exactly, for display and filtering. */
export function dayRange(day) {
    // Midnight ET is 04:00 or 05:00 UTC depending on daylight time; the right one is the instant
    // that is in the day while the millisecond before it is not.
    const startOf = d => { for (const off of [4, 5]) { const t = Date.parse(d + 'T00:00:00Z') + off * 3600e3; if (etDay(new Date(t)) === d && etDay(new Date(t - 1)) !== d) return t; } return Date.parse(d + 'T05:00:00Z'); };
    const next = etDay(new Date(Date.parse(day + 'T12:00:00Z') + 86400000));
    return { from: iso(startOf(day)), to: iso(startOf(next) - 1), timezone: TZ };
}

export const OUTCOME_LABEL = { connected: 'Conversation', callback: 'Callback agreed', voicemail: 'Voicemail', no_answer: 'No answer', timing: 'Not now', wrong_number: 'Bad number', suppress: 'Opt-out' };
const TAG = n => (String(n || '').match(/^\[(Meeting booked|Interested|Referred me on|Not a fit)\]/) || [])[1] || null;

// ---- the pure part ----------------------------------------------------------------------------

/**
 * Pair each verified Quo dial with the outcome the rep logged for that number. A logged outcome
 * counts against a dial to one of the record's numbers made up to 90 minutes before it was logged
 * (or 5 minutes after, for a clock that runs ahead). Each dial and each outcome pairs at most once.
 */
export function pairCalls(quoCalls, hubEntries) {
    const dials = [...quoCalls].sort((a, b) => ms(a.at) - ms(b.at)).map(c => ({ ...c, pairedWith: null }));
    const outcomes = [...hubEntries].sort((a, b) => ms(a.at) - ms(b.at)).map(e => ({ ...e, pairedWith: null }));
    for (const o of outcomes) {
        const nums = new Set(o.numbers || []);
        const t = ms(o.at);
        const cands = dials.filter(d => !d.pairedWith && nums.has(d.number) && ms(d.at) <= t + 5 * 60000 && ms(d.at) >= t - 90 * 60000);
        const d = cands.sort((a, b) => Math.abs(t - ms(a.at)) - Math.abs(t - ms(b.at)))[0];
        if (d) { d.pairedWith = o.id; o.pairedWith = d.id; }
    }
    return { dials, outcomes };
}

const rate = (num, den, label) => (den > 0 ? { num, den, pct: Math.round((num / den) * 1000) / 10, label } : { num, den, pct: null, label, note: 'Not shown: the denominator is zero.' });

/** Everything on the report, from already-read sources. Pure, so it is tested without a network. */
export function buildReport({ user, day, generatedAt, range, hub, quo, calendly, activity, shift }) {
    const dayEntries = hub.ok ? hub.entries.filter(e => etDay(e.at) === day) : [];
    const quoCalls = quo.ok ? quo.calls.filter(c => etDay(c.at) === day) : [];
    const { dials, outcomes } = pairCalls(quoCalls, dayEntries);

    const by = {}; for (const k of Object.keys(OUTCOME_LABEL)) by[k] = 0;
    for (const e of dayEntries) by[e.outcome] = (by[e.outcome] || 0) + 1;
    const tags = { 'Meeting booked': 0, Interested: 0, 'Referred me on': 0, 'Not a fit': 0 };
    for (const e of dayEntries) if (e.tag) tags[e.tag]++;

    const numbersDialled = new Set(quoCalls.map(c => c.number).filter(Boolean));
    const answered = quoCalls.filter(c => c.answered);
    const numbersWithOutcome = new Set(dials.filter(d => d.pairedWith).map(d => d.number));
    const numbersWithoutOutcome = [...numbersDialled].filter(n => !numbersWithOutcome.has(n));

    // Meetings: booked that ET day, by a prospect this rep logged a call with before the booking.
    const firstCallByEmail = new Map();
    for (const e of hub.ok ? hub.entries : []) { const k = norm(e.recipient); if (k && (!firstCallByEmail.has(k) || ms(e.at) < ms(firstCallByEmail.get(k).at))) firstCallByEmail.set(k, e); }
    const bookingsToday = calendly.ok ? calendly.bookings.filter(b => etDay(b.createdAt) === day) : [];
    const credited = bookingsToday.filter(b => { const c = firstCallByEmail.get(norm(b.email)); return c && ms(c.at) < ms(b.createdAt); })
        .map(b => ({ ...b, calledAt: firstCallByEmail.get(norm(b.email)).at, company: firstCallByEmail.get(norm(b.email)).company }));

    // Callbacks this rep agreed: due that day, done (a later outcome on the card by the end of the
    // day), and overdue at the end of the day (due before it ended, nothing logged since).
    const end = ms(range.to);
    const all = hub.ok ? hub.entries : [];
    const later = (e) => all.some(x => x.recordId === e.recordId && ms(x.at) > ms(e.at) && ms(x.at) <= end);
    const callbacks = all.filter(e => e.outcome === 'callback' && e.nextCallAt && ms(e.at) <= end)
        // Only the most recent callback per card matters: an earlier one superseded by a later
        // outcome is not still owed.
        .filter(e => !all.some(x => x.recordId === e.recordId && x.outcome === 'callback' && ms(x.at) > ms(e.at) && ms(x.at) <= end));
    const dueToday = callbacks.filter(e => etDay(e.nextCallAt) === day);
    const cbRows = callbacks.filter(e => etDay(e.nextCallAt) <= day).map(e => ({ recordId: e.recordId, company: e.company, setAt: e.at, dueAt: e.nextCallAt, done: later(e), dueToday: etDay(e.nextCallAt) === day }));

    const quoUnavailable = !quo.ok;
    const hubUnavailable = !hub.ok;
    const calls = {
        verifiedAttempts: quoUnavailable ? null : quoCalls.length,
        uniqueNumbersCalled: quoUnavailable ? null : numbersDialled.size,
        repeatAttempts: quoUnavailable ? null : quoCalls.length - numbersDialled.size,
        linePickedUp: quoUnavailable ? null : answered.length,
        answered60sOrMore: quoUnavailable ? null : answered.filter(c => c.seconds >= 60).length,
        talkSeconds: quoUnavailable ? null : quoCalls.reduce((n, c) => n + c.seconds, 0),
        loggedOutcomes: hubUnavailable ? null : dayEntries.length,
        loggedProspects: hubUnavailable ? null : new Set(dayEntries.map(e => e.recordId)).size,
        byOutcome: hubUnavailable ? null : by,
        tags: hubUnavailable ? null : tags,
        conversations: hubUnavailable ? null : by.connected,
        noAnswerOrVoicemail: hubUnavailable ? null : by.no_answer + by.voicemail,
        badNumbers: hubUnavailable ? null : by.wrong_number,
        interested: hubUnavailable ? null : tags.Interested + tags['Meeting booked'],
        notInterested: hubUnavailable ? null : by.timing + tags['Not a fit'],
        optOuts: hubUnavailable ? null : by.suppress,
        // Reconciliation between the two. Unknown when either side could not be read.
        numbersDialledWithoutOutcome: quoUnavailable || hubUnavailable ? null : numbersWithoutOutcome.length,
        dialsWithoutOutcome: quoUnavailable || hubUnavailable ? null : dials.filter(d => !d.pairedWith).length,
        outcomesWithoutQuoCall: quoUnavailable || hubUnavailable ? null : outcomes.filter(o => !o.pairedWith).length,
    };
    const meetings = { booked: calendly.ok && hub.ok ? credited.length : null, bookedTotalThatDay: calendly.ok ? bookingsToday.length : null };
    const cb = hub.ok ? { dueToday: dueToday.length, doneOfDueToday: dueToday.filter(later).length, overdueAtEndOfDay: cbRows.filter(r => !r.done && ms(r.dueAt) <= end).length } : { dueToday: null, doneOfDueToday: null, overdueAtEndOfDay: null };

    const rates = {
        pickedUp: quoUnavailable ? null : rate(answered.length, quoCalls.length, 'Line picked up, of verified dials. Includes voicemail and gatekeepers, so it is not a conversation rate.'),
        conversations: hubUnavailable ? null : rate(by.connected, dayEntries.length, 'Conversations, of outcomes logged in the Hub.'),
        meetings: meetings.booked === null || hubUnavailable ? null : rate(meetings.booked, by.connected, 'Meetings booked that day by prospects he had called, of that day’s logged conversations.'),
    };

    const coverage = [];
    if (!quo.configured) coverage.push('Quo is not connected, so no call can be verified. Every number below is what he logged.');
    else if (!quo.seat) coverage.push('No Quo seat matches this login, so no call can be verified. Every number below is what he logged.');
    else if (!quo.ok) coverage.push('Quo could not be read for this day (' + (quo.error || 'unavailable') + '). Verified calls are unavailable, not zero.');
    else coverage.push('Verified calls are the ones placed through Quo by ' + (quo.seat.email || 'his Quo user') + '. Calls from an iPhone’s own dialer or any line outside Quo are not visible to the Hub and are not counted.');
    if (quo.ok && quo.complete === false) coverage.push('Quo returned more pages than were read; the verified counts may be low.');
    if (!hub.ok) coverage.push('The Hub call log could not be read (' + (hub.error || 'unavailable') + ').');
    if (!calendly.configured) coverage.push('Calendly is not connected, so meetings are unknown.');
    else if (!calendly.ok) coverage.push('Calendly could not be read (' + (calendly.error || 'unavailable') + '); meetings are unknown, not zero.');
    else coverage.push('Meetings count only bookings still active when the report ran, credited when the invitee is a prospect he logged a call with before booking.');
    if (!activity) coverage.push('Hub activity could not be read.');
    if (!shift || shift.unavailable) coverage.push('Shift records could not be read.');

    // "No recorded activity" is a statement about every source, so it is made only when each one was
    // read (or cannot see calls at all, which the coverage line says). An unreadable source makes it unknown.
    const quoSilent = !quo.configured || !quo.seat || (quo.ok && quoCalls.length === 0);
    const noRecordedActivity = quoSilent && hub.ok && dayEntries.length === 0 && !!shift && !shift.unavailable && !shift.shifts && !!activity && !activity.measured;
    const quoDial = d => ({ at: d.at, number: tail4(d.number), answered: d.answered, seconds: d.seconds, loggedAs: d.pairedWith ? (OUTCOME_LABEL[(outcomes.find(o => o.id === d.pairedWith) || {}).outcome] || null) : null });
    return {
        version: REPORT_VERSION, user, day, range, generatedAt,
        freshness: { hubLog: hub.readAt || null, hubStateUpdatedAt: hub.stateUpdatedAt || null, quo: quo.readAt || null, calendly: calendly.readAt || null, activity: activity ? generatedAt : null },
        sources: { quo: quo.ok ? 'read' : !quo.configured ? 'not connected' : !quo.seat ? 'no seat for this login' : 'unavailable', hubLog: hub.ok ? 'read' : 'unavailable', calendly: calendly.ok ? 'read' : !calendly.configured ? 'not connected' : 'unavailable' },
        noRecordedActivity,
        calls, meetings, callbacks: cb, rates, coverage,
        shift: shift && !shift.unavailable ? { shifts: shift.shifts, clockedMinutes: shift.clockedMinutes, breakMinutes: shift.breakMinutes, needsReview: shift.needsReview, open: shift.open,
            list: (shift.list || []).map(s => ({ startedAt: s.startedAt, endedAt: s.correctedEndedAt || s.endedAt || null, corrected: !!s.correctedEndedAt, state: s.state, clockedMinutes: s.clockedMinutes, breakMinutes: s.breakMinutes, breaks: (s.breaks || []).map(b => ({ startedAt: b.startedAt, endedAt: b.endedAt })) })) } : null,
        activity: activity ? { measured: activity.measured, activeMinutes: activity.activeMinutes, idleMinutes: activity.idleMinutes, elapsedMinutes: activity.elapsedMinutes, sessions: activity.sessions, firstSeen: activity.firstSeen, lastSeen: activity.lastSeen } : null,
        evidence: {
            quoDials: dials.map(quoDial),
            hubOutcomes: outcomes.map(o => ({ at: o.at, company: o.company, outcome: OUTCOME_LABEL[o.outcome] || o.outcome, tag: o.tag, quoCall: !!o.pairedWith, recordId: o.recordId })),
            numbersDialledWithoutOutcome: quoUnavailable || hubUnavailable ? [] : numbersWithoutOutcome.map(tail4),
            meetings: credited.map(b => ({ bookedAt: b.createdAt, startsAt: b.startTime, company: b.company || null, event: b.eventName || null, calledFirstAt: b.calledAt })),
            callbacks: cbRows,
        },
        definitions: {
            verifiedAttempts: 'Outbound calls placed through Quo by his own Quo user that day. The only calls counted as verified.',
            uniqueNumbersCalled: 'Distinct numbers among those calls. Repeat attempts are the rest.',
            linePickedUp: 'Quo saw the line answered. A person, a gatekeeper or a voicemail greeting all answer a line.',
            loggedOutcomes: 'Outcomes he logged on a Hub card. Manual: a logged outcome is not proof a call was placed.',
            conversations: 'Logged as "Connected: you spoke with them".',
            numbersDialledWithoutOutcome: 'Numbers Quo shows he dialled with no outcome logged against them that day (a missing disposition).',
            outcomesWithoutQuoCall: 'Outcomes logged with no matching Quo call within 90 minutes: dialled outside Quo, a different number, or not dialled.',
            meetings: 'Calendly bookings made that day by an invitee he had logged a call with before the booking. A booking-link click is not a meeting.',
            callbacks: 'Callbacks he agreed. Done means a later outcome was logged on that card by the end of the day.',
            shift: 'Declared with Start, Break and End. Hub idle time is never subtracted.',
            activity: 'An estimate of time with a Hub tab open and in use. It cannot see phone calls.',
        },
    };
}

const mins = n => (n == null ? 'unknown' : n >= 60 ? Math.floor(n / 60) + 'h ' + (n % 60) + 'm' : n + 'm');
const v = n => (n == null ? 'unknown' : String(n));
const timeET = s => new Date(s).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

/** The one Slack message. Plain, short, no judgement, unknowns said as unknown. */
export function slackText(r, { link } = {}) {
    const d = new Date(r.day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const c = r.calls, lines = [];
    lines.push(`*${r.user.name || r.user.email} · calls and shift · ${d} (ET)*`);
    if (r.noRecordedActivity) lines.push('No recorded activity: no Quo calls, no logged outcomes, no shift and no Hub use that day.');
    else {
        lines.push(c.verifiedAttempts == null ? 'Verified calls (Quo): unavailable.' : `Verified calls (Quo): ${c.verifiedAttempts} dials to ${c.uniqueNumbersCalled} numbers (${c.repeatAttempts} repeat). Line picked up ${c.linePickedUp} times, voicemail included; ${c.answered60sOrMore} answered calls ran 60 s or more. Talk time ${mins(Math.round((c.talkSeconds || 0) / 60))}.`);
        if (c.loggedOutcomes == null) lines.push('Logged in the Hub: unavailable.');
        else {
            const b = c.byOutcome;
            lines.push(`Logged in the Hub: ${c.loggedOutcomes} outcomes on ${c.loggedProspects} prospects. Conversations ${b.connected} · voicemail ${b.voicemail} · no answer ${b.no_answer} · callback agreed ${b.callback} · not now ${b.timing} · bad number ${b.wrong_number} · opt-out ${b.suppress}. Tagged interested ${c.interested}, not a fit ${c.tags['Not a fit']}.`);
        }
        if (c.numbersDialledWithoutOutcome != null) lines.push(`Not reconciled: ${c.numbersDialledWithoutOutcome} numbers dialled with no outcome logged; ${c.outcomesWithoutQuoCall} outcomes logged with no matching Quo call.`);
        lines.push(`Meetings booked by prospects he called: ${v(r.meetings.booked)}.`);
        lines.push(`Callbacks: ${v(r.callbacks.dueToday)} due, ${v(r.callbacks.doneOfDueToday)} done, ${v(r.callbacks.overdueAtEndOfDay)} overdue at end of day.`);
        const s = r.shift;
        lines.push(!s ? 'Shift: unavailable.' : !s.shifts ? 'Shift: none declared.' : `Shift (declared): ${s.list.map(x => timeET(x.startedAt) + ' to ' + (x.endedAt ? timeET(x.endedAt) : x.state === 'open' ? 'still open' : 'never ended')).join(', ')}; ${mins(s.clockedMinutes)} clocked, ${mins(s.breakMinutes)} on breaks${s.needsReview ? '; ' + s.needsReview + ' needs review' : ''}.`);
        lines.push(!r.activity ? 'Hub activity: unavailable.' : r.activity.measured ? `Hub activity (estimate): ${mins(r.activity.activeMinutes)} active, ${mins(r.activity.idleMinutes)} idle.` : 'Hub activity: none recorded.');
    }
    const gap = r.coverage.find(x => /not visible|cannot be verified|unavailable/i.test(x));
    if (gap) lines.push('_' + gap + '_');
    if (link) lines.push(link);
    return lines.join('\n');
}

// ---- reading the sources -----------------------------------------------------------------------

/** The Hub call log for one person, every entry they logged, with the numbers on each card. */
export function hubEntriesFrom(records, emails) {
    const want = new Set(emails.map(norm));
    const out = [];
    for (const r of records || []) {
        const nums = [r.callContact && r.callContact.phone, r.phone, ...((r.callContact && r.callContact.alternates) || [])].map(last10).filter(n => n.length === 10);
        (r.callHistory || []).forEach((c, i) => {
            if (!c || !want.has(norm(c.caller)) || !c.at) return;
            out.push({ id: r.id + '#' + i, recordId: r.id, company: r.company || r.recipient || null, recipient: r.recipient || null, at: c.at, outcome: c.outcome, tag: TAG(c.notes), nextCallAt: c.nextCallAt || null, numbers: [...new Set(nums)] });
        });
    }
    return out;
}

/**
 * Read every source for one person and one ET day. Each read is isolated: one failing makes that
 * section unavailable and leaves the rest. `deps` exists so tests can stand in for the network.
 */
export async function gather({ redis, rep, day, now = Date.now(), decorate, deps = {} }) {
    const email = norm(rep.email);
    const emails = loginAliases(email);
    const range = dayRange(day);
    const at = () => new Date().toISOString();

    const hub = { ok: false };
    try {
        const state = await redis.get(QUEUE_KEY);
        if (!state) throw Error('the queue store answered with nothing');
        let view = visibleState(state, 'all');
        if (decorate) { try { view = await decorate(view); } catch { /* numbers fall back to what the record holds */ } }
        Object.assign(hub, { ok: true, entries: hubEntriesFrom(view.records, emails), readAt: at(), stateUpdatedAt: state.queueUpdatedAt || state.updatedAt || null });
    } catch (e) { hub.error = String((e && e.message) || e).slice(0, 120); }

    const q = { configured: (deps.quoConfigured || quoConfigured)(), ok: false, seat: null };
    if (q.configured) {
        try {
            const users = await (deps.listUsers || listUsers)();
            q.seat = findSeat(users, emails);
            if (q.seat) {
                const b = etDayBounds(day);
                const { items, complete } = await (deps.listCalls || listCalls)({ actorId: q.seat.actorId, direction: 'outgoing', from: b.from, to: b.to });
                const placed = (items || []).filter(c => c.direction === 'outgoing' && (!c.initiatedBy || c.initiatedBy === q.seat.actorId));
                Object.assign(q, { ok: true, complete, readAt: at(), calls: placed.map(c => ({ id: c.id, at: c.createdAt, number: last10(counterparty(c)), answered: connected(c), seconds: talkSeconds(c) })) });
            }
        } catch (e) { q.error = String((e && e.message) || e).slice(0, 120); }
    }

    const cal = { configured: (deps.calendlyConfigured || calendlyConfigured)(), ok: false };
    if (cal.configured) {
        try {
            const me = await (deps.whoAmI || whoAmI)();
            const scope = me && me.organization ? { organization: me.organization } : me && me.uri ? { user: me.uri } : null;
            if (!scope) throw Error('no Calendly scope');
            // Bookings MADE that day can be for any later date, so the window runs forward from it.
            const { items } = await (deps.pastEvents || pastEvents)({ since: range.from, until: new Date(ms(range.to) + 120 * 86400000).toISOString(), ...scope, maxPages: 10 });
            const bookings = [];
            for (const ev of items || []) {
                if (etDay(ev.created_at) !== day) continue;
                let people = []; try { people = await (deps.invitees || invitees)(ev.uri); } catch { continue; }
                for (const p of people) if (p.email) bookings.push({ email: p.email, createdAt: ev.created_at, startTime: ev.start_time, eventName: ev.name || null });
            }
            Object.assign(cal, { ok: true, bookings, readAt: at() });
        } catch (e) { cal.error = String((e && e.message) || e).slice(0, 120); }
    }

    let activity = null;
    try {
        const [minutes, raw, doc] = await Promise.all([redis.smembers(ACT.minutes(email, day)), redis.lrange(ACT.events(email, day), 0, 499), redis.get(ACT.sessions(email))]);
        const events = (raw || []).map(x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } }).filter(Boolean);
        activity = summarizeDay({ day, minutes: minutes || [], sessions: sessionsOn(doc, day), events });
    } catch { activity = null; }

    let shift = null;
    try { shift = await shiftsOn(redis, email, day, now); } catch { shift = { unavailable: true }; }

    return { user: { email, name: rep.name || email }, day, range, hub, quo: q, calendly: cal, activity, shift };
}
