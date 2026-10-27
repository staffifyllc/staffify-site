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
import { shiftsOn, readCurrent } from './_shift.js';

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

/** When each measure began. A day before it is "not measured", never zero. */
export const ACTIVITY_SINCE = '2026-10-23';
export const SHIFT_SINCE = '2026-10-24';
export const ACTIVITY_RETAIN_DAYS = 120;
export const MEETING_CREDIT_DAYS = 30;
const daysBefore = (day, n) => etDay(new Date(Date.parse(day + 'T12:00:00Z') - n * 86400000));

/** Everything on the report, from already-read sources. Pure, so it is tested without a network. */
export function buildReport({ user, day, generatedAt, range, hub, quo, calendly, activity, shift, now = Date.parse(generatedAt) }) {
    const dayEntries = hub.ok ? hub.entries.filter(e => etDay(e.at) === day) : [];
    const quoCalls = quo.ok ? quo.calls.filter(c => etDay(c.at) === day) : [];
    const { dials, outcomes } = pairCalls(quoCalls, dayEntries);
    // For today's view, the day ends now: a callback due this evening is not overdue at noon.
    const end = Math.min(ms(range.to), now);

    const by = {}; for (const k of Object.keys(OUTCOME_LABEL)) by[k] = 0;
    for (const e of dayEntries) by[e.outcome] = (by[e.outcome] || 0) + 1;
    const tags = { 'Meeting booked': 0, Interested: 0, 'Referred me on': 0, 'Not a fit': 0 };
    for (const e of dayEntries) if (e.tag) tags[e.tag]++;

    const numbersDialled = new Set(quoCalls.map(c => c.number).filter(Boolean));
    const answered = quoCalls.filter(c => c.answered);
    const numbersWithOutcome = new Set(dials.filter(d => d.pairedWith).map(d => d.number));
    const numbersWithoutOutcome = [...numbersDialled].filter(n => !numbersWithOutcome.has(n));

    // Meetings: discovery calls booked that ET day by a prospect he logged a call with in the 30 days
    // before the booking. The rate is narrower, so its numerator is part of its denominator: bookings
    // that day by prospects he had a logged conversation with that day, over that day's conversations.
    const all = hub.ok ? hub.entries : [];
    const bookingsToday = calendly.ok ? calendly.bookings.filter(b => etDay(b.createdAt) === day) : [];
    const lastCallBefore = (email, t) => all.filter(e => norm(e.recipient) === norm(email) && ms(e.at) < t && ms(e.at) >= t - MEETING_CREDIT_DAYS * 86400000).sort((a, b) => ms(b.at) - ms(a.at))[0] || null;
    const credited = bookingsToday.map(b => ({ b, c: lastCallBefore(b.email, ms(b.createdAt)) })).filter(x => x.c)
        .map(({ b, c }) => ({ ...b, calledAt: c.at, company: c.company, sameDayConversation: dayEntries.some(e => e.outcome === 'connected' && norm(e.recipient) === norm(b.email) && ms(e.at) < ms(b.createdAt)) }));
    const conversedProspects = new Set(dayEntries.filter(e => e.outcome === 'connected').map(e => e.recordId));

    // Callbacks he agreed. Done: a later outcome on that card by anyone, or the card excluded, by the
    // end of the day. A callback rescheduled before it fell due is replaced by the new one; one
    // completed by setting another callback still counts as due and done.
    const cards = (hub.ok && hub.cards) || {};
    const historyOf = id => (cards[id] && cards[id].history) || all.filter(x => x.recordId === id);
    const resolved = e => historyOf(e.recordId).some(x => ms(x.at) > ms(e.at) && ms(x.at) <= end) || (cards[e.recordId] && cards[e.recordId].status === 'suppressed');
    const callbacks = all.filter(e => e.outcome === 'callback' && e.nextCallAt && ms(e.at) <= end)
        .filter(e => !all.some(x => x.recordId === e.recordId && x.outcome === 'callback' && ms(x.at) > ms(e.at) && ms(x.at) < ms(e.nextCallAt) && ms(x.at) <= end));
    const dueToday = callbacks.filter(e => etDay(e.nextCallAt) === day);
    const cbRows = callbacks.filter(e => etDay(e.nextCallAt) <= day).map(e => ({ recordId: e.recordId, company: e.company, setAt: e.at, dueAt: e.nextCallAt, done: resolved(e), dueToday: etDay(e.nextCallAt) === day }));

    // Opt-outs: the stop button writes the per-rep event log (since Hub activity began) and, since
    // this report, the card's call history too. Unknown on a day the event log did not exist.
    const actEvents = activity && !activity.notMeasured && Array.isArray(activity.events) ? activity.events : null;
    const optOuts = hub.ok && actEvents ? Math.max(by.suppress, actEvents.filter(x => x.kind === 'suppress').length) : null;

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
        optOuts,
        // Reconciliation between the two. Unknown when either side could not be read.
        numbersDialledWithoutOutcome: quoUnavailable || hubUnavailable ? null : numbersWithoutOutcome.length,
        dialsWithoutOutcome: quoUnavailable || hubUnavailable ? null : dials.filter(d => !d.pairedWith).length,
        outcomesWithoutQuoCall: quoUnavailable || hubUnavailable ? null : outcomes.filter(o => !o.pairedWith).length,
    };
    const meetings = { booked: calendly.ok && hub.ok ? credited.length : null, bookedTotalThatDay: calendly.ok ? bookingsToday.length : null };
    const cb = hub.ok ? { dueToday: dueToday.length, doneOfDueToday: dueToday.filter(resolved).length, overdueAtEndOfDay: cbRows.filter(r => !r.done && ms(r.dueAt) <= end).length } : { dueToday: null, doneOfDueToday: null, overdueAtEndOfDay: null };

    const rates = {
        pickedUp: quoUnavailable ? null : rate(answered.length, quoCalls.length, 'Line picked up, of verified dials. Includes voicemail and gatekeepers, so it is not a conversation rate.'),
        conversations: hubUnavailable ? null : rate(by.connected, dayEntries.length, 'Conversations, of outcomes logged in the Hub.'),
        meetings: meetings.booked === null || hubUnavailable ? null : rate(credited.filter(x => x.sameDayConversation).length, conversedProspects.size, "Prospects he had a logged conversation with that day who booked a discovery call that day, of the prospects he had a logged conversation with."),
    };

    const coverage = [];
    if (!quo.configured) coverage.push('Quo is not connected, so no call can be verified. Every number below is what he logged.');
    else if (quo.error) coverage.push('Quo could not be read for this day (' + quo.error + '). Verified calls are unavailable, not zero.');
    else if (!quo.seat) coverage.push('No Quo seat matches this login, so no call can be verified. Every number below is what he logged.');
    else coverage.push('Verified calls are the ones placed through Quo by ' + (quo.seat.email || 'his Quo user') + ". Calls from an iPhone's own dialer or any line outside Quo are not visible to the Hub and are not counted.");
    if (quo.ok && quo.complete === false) coverage.push('Quo returned more pages than were read; the verified counts may be low.');
    if (!hub.ok) coverage.push('The Hub call log could not be read (' + (hub.error || 'unavailable') + ').');
    if (!calendly.configured) coverage.push('Calendly is not connected, so meetings are unknown.');
    else if (!calendly.ok) coverage.push('Calendly could not be read (' + (calendly.error || 'unavailable') + '); meetings are unknown, not zero.');
    else coverage.push('Meetings are discovery-call bookings still active when the report ran, credited when the invitee is a prospect he logged a call with in the 30 days before booking. A moved booking is not a new one.');
    if (activity && activity.notMeasured) coverage.push(activity.reason);
    else if (!activity) coverage.push('Hub activity could not be read.');
    if (shift && shift.notMeasured) coverage.push(shift.reason);
    else if (!shift || shift.unavailable) coverage.push('Shift records could not be read.');
    if (optOuts === null && hub.ok) coverage.push('Opt-outs are unknown for this day: the per-rep event log that records the stop button began on Oct 23, 2026.');

    // "No recorded activity" is a statement about every source, so it is made only when each one was
    // read (or cannot see calls at all, which the coverage line says) and each one existed that day.
    const quoSilent = !quo.error && (!quo.configured || !quo.seat || (quo.ok && quoCalls.length === 0));
    const shiftSilent = !!shift && !shift.unavailable && !shift.notMeasured && !shift.shifts;
    const activitySilent = !!activity && !activity.notMeasured && !activity.measured;
    const noRecordedActivity = quoSilent && hub.ok && dayEntries.length === 0 && shiftSilent && activitySilent;
    const quoDial = d => ({ at: d.at, number: tail4(d.number), answered: d.answered, seconds: d.seconds, loggedAs: d.pairedWith ? (OUTCOME_LABEL[(outcomes.find(o => o.id === d.pairedWith) || {}).outcome] || null) : null });
    return {
        version: REPORT_VERSION, user, day, range, generatedAt, partialDay: now < ms(range.to),
        freshness: { hubLog: hub.readAt || null, hubStateUpdatedAt: hub.stateUpdatedAt || null, quo: quo.readAt || null, calendly: calendly.readAt || null, activity: activity && !activity.notMeasured ? generatedAt : null },
        sources: { quo: quo.ok ? 'read' : !quo.configured ? 'not connected' : quo.error ? 'unavailable' : !quo.seat ? 'no seat for this login' : 'unavailable', hubLog: hub.ok ? 'read' : 'unavailable', calendly: calendly.ok ? 'read' : !calendly.configured ? 'not connected' : 'unavailable' },
        noRecordedActivity,
        calls, meetings, callbacks: cb, rates, coverage,
        shift: !shift || shift.unavailable ? null : shift.notMeasured ? { notMeasured: true, reason: shift.reason } : { shifts: shift.shifts, clockedMinutes: shift.clockedMinutes, breakMinutes: shift.breakMinutes, needsReview: shift.needsReview, open: shift.open,
            list: (shift.list || []).map(s => ({ startedAt: s.startedAt, endedAt: s.correctedEndedAt || s.endedAt || null, corrected: !!s.correctedEndedAt, state: s.state, clockedMinutes: s.clockedMinutes, breakMinutes: s.breakMinutes, breaks: (s.breaks || []).map(b => ({ startedAt: b.startedAt, endedAt: b.endedAt })) })) },
        activity: !activity ? null : activity.notMeasured ? { notMeasured: true, reason: activity.reason } : { measured: activity.measured, activeMinutes: activity.activeMinutes, idleMinutes: activity.idleMinutes, elapsedMinutes: activity.elapsedMinutes, sessions: activity.sessions, firstSeen: activity.firstSeen, lastSeen: activity.lastSeen },
        evidence: {
            quoDials: dials.map(quoDial),
            hubOutcomes: outcomes.map(o => ({ at: o.at, company: o.company, outcome: OUTCOME_LABEL[o.outcome] || o.outcome, tag: o.tag, quoCall: !!o.pairedWith, recordId: o.recordId })),
            numbersDialledWithoutOutcome: quoUnavailable || hubUnavailable ? [] : numbersWithoutOutcome.map(tail4),
            meetings: credited.map(b => ({ bookedAt: b.createdAt, startsAt: b.startTime, company: b.company || null, event: b.eventName || null, calledFirstAt: b.calledAt, sameDayConversation: b.sameDayConversation })),
            callbacks: cbRows,
        },
        definitions: {
            verifiedAttempts: 'Outbound calls placed through Quo by his own Quo user that day. The only calls counted as verified.',
            uniqueNumbersCalled: 'Distinct numbers among those calls. Repeat attempts are the rest.',
            linePickedUp: 'Quo saw the line answered. A person, a gatekeeper or a voicemail greeting all answer a line.',
            loggedOutcomes: 'Outcomes he logged on a Hub card. Manual: a logged outcome is not proof a call was placed.',
            conversations: 'Logged as "Connected: you spoke with them".',
            optOuts: 'Prospects he excluded with the stop button that day.',
            numbersDialledWithoutOutcome: 'Numbers Quo shows he dialled with no outcome logged against them that day (a missing disposition).',
            outcomesWithoutQuoCall: 'Outcomes logged with no matching Quo call within 90 minutes: dialled outside Quo, a different number, or not dialled.',
            meetings: 'Discovery-call bookings made that day by an invitee he had logged a call with in the 30 days before. A booking-link click is not a meeting, and a moved booking is not a new one.',
            callbacks: 'Callbacks he agreed. Done means a later outcome was logged on that card, by anyone, or the card was excluded, by the end of the day.',
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
        lines.push(c.verifiedAttempts == null ? 'Verified calls (Quo): unknown.' : `Verified calls (Quo): ${c.verifiedAttempts} dials to ${c.uniqueNumbersCalled} numbers (${c.repeatAttempts} repeat). Line picked up ${c.linePickedUp} times, voicemail included; ${c.answered60sOrMore} answered calls ran 60 s or more. Talk time ${mins(Math.round((c.talkSeconds || 0) / 60))}.`);
        if (c.loggedOutcomes == null) lines.push('Logged in the Hub: unknown.');
        else {
            const b = c.byOutcome;
            lines.push(`Logged in the Hub: ${c.loggedOutcomes} outcomes on ${c.loggedProspects} prospects. Conversations ${b.connected} · voicemail ${b.voicemail} · no answer ${b.no_answer} · callback agreed ${b.callback} · not now ${b.timing} · bad number ${b.wrong_number} · opt-outs ${v(c.optOuts)}. Tagged interested ${c.interested}, not a fit ${c.tags['Not a fit']}.`);
        }
        if (c.numbersDialledWithoutOutcome != null) lines.push(`Not reconciled: ${c.numbersDialledWithoutOutcome} numbers dialled with no outcome logged; ${c.outcomesWithoutQuoCall} outcomes logged with no matching Quo call.`);
        lines.push(`Discovery calls booked by prospects he called: ${v(r.meetings.booked)}.`);
        lines.push(`Callbacks: ${v(r.callbacks.dueToday)} due, ${v(r.callbacks.doneOfDueToday)} done, ${v(r.callbacks.overdueAtEndOfDay)} overdue at end of day.`);
        const s = r.shift;
        lines.push(!s ? 'Shift: unknown.' : s.notMeasured ? 'Shift: not measured on this day.' : !s.shifts ? 'Shift: none declared.' : `Shift (declared): ${s.list.map(x => timeET(x.startedAt) + ' to ' + (x.endedAt ? timeET(x.endedAt) : x.state === 'open' ? 'still open' : 'never ended')).join(', ')}; ${mins(s.clockedMinutes)} clocked, ${mins(s.breakMinutes)} on breaks${s.needsReview ? '; ' + s.needsReview + ' needs review' : ''}.`);
        lines.push(!r.activity ? 'Hub activity: unknown.' : r.activity.notMeasured ? 'Hub activity: not measured on this day.' : r.activity.measured ? `Hub activity (estimate): ${mins(r.activity.activeMinutes)} active, ${mins(r.activity.idleMinutes)} idle.` : 'Hub activity: none recorded.');
    }
    const gap = r.coverage.find(x => /not visible|can be verified|could not be read|not connected|no quo seat/i.test(x));
    if (gap) lines.push('_' + gap + '_');
    if (link) lines.push(link);
    return lines.join('\n');
}

// ---- reading the sources -----------------------------------------------------------------------

/**
 * The Hub call log for one person: every entry they logged, with the number dialled when the
 * dialer recorded it, then every number known for the card (the one on screen now, its alternates,
 * the vendor, website and evidence numbers, numbers since marked bad). Also each touched card's full
 * history from every caller and its status, for judging whether a callback was handled.
 */
export function hubEntriesFrom(records, emails, extraNumbers = {}) {
    const want = new Set(emails.map(norm));
    const out = [], cards = {};
    for (const r of records || []) {
        const cardNums = [r.callContact && r.callContact.phone, r.phone, ...((r.callContact && (r.callContact.phoneAlternates || r.callContact.alternates)) || []), ...(extraNumbers[r.id] || [])].map(last10).filter(n => n.length === 10);
        let touched = false;
        (r.callHistory || []).forEach((c, i) => {
            if (!c || !want.has(norm(c.caller)) || !c.at) return;
            touched = true;
            const dialled = last10(c.dialled);
            out.push({ id: r.id + '#' + i, recordId: r.id, company: r.company || r.recipient || null, recipient: r.recipient || null, campaignId: r.campaignId || null, at: c.at, outcome: c.outcome, tag: TAG(c.notes), notes: String(c.notes || '').slice(0, 600), nextCallAt: c.nextCallAt || null,
                numbers: [...new Set([...(dialled.length === 10 ? [dialled] : []), ...cardNums])], dialledRecorded: dialled.length === 10 });
        });
        if (touched) cards[r.id] = { status: r.status || null, history: (r.callHistory || []).filter(c => c && c.at).map(c => ({ at: c.at, outcome: c.outcome, caller: norm(c.caller) })) };
    }
    return { entries: out, cards };
}

/** Every number we hold for a set of cards, from the stores the dialer's number ladder reads. */
async function numbersFor(redis, records) {
    const out = {};
    const rows = (records || []).filter(r => r && r.recipient);
    for (let i = 0; i < rows.length; i += 50) {
        const chunk = rows.slice(i, i + 50);
        const keys = chunk.flatMap(r => { const e = String(r.recipient).toLowerCase(); return ['staffify:call-phone-evidence:' + r.recipient, 'staffify:call-phone-vendor:' + e, 'staffify:call-site-phone:' + e, 'staffify:bad-numbers:' + e]; });
        const vals = await redis.mget(...keys);
        chunk.forEach((r, j) => {
            const [ev, vendor, site, bad] = vals.slice(j * 4, j * 4 + 4);
            out[r.id] = [ev && ev.phone, vendor && vendor.phone, ...((vendor && vendor.alternates) || []), site && site.phone, ...((site && site.alternates) || []), ...((bad && bad.numbers) || [])].filter(Boolean);
        });
    }
    return out;
}

/** Every ET calendar day from `from` to `to`, inclusive. */
export function daysBetween(from, to) {
    const out = [];
    for (let t = Date.parse(from + 'T12:00:00Z'); out.length < 400; t += 86400000) { const d = etDay(new Date(t)); if (d > to) break; out.push(d); }
    return out;
}

/**
 * Read every source for one person and one ET day. Each read is isolated: one failing makes that
 * section unavailable and leaves the rest. `deps` exists so tests can stand in for the network.
 */
export async function gather({ redis, rep, day, now = Date.now(), decorate, deps = {} }) {
    const src = await gatherRange({ redis, rep, from: day, to: day, now, decorate, deps });
    return { user: src.user, day, range: dayRange(day), hub: src.hub, quo: src.quo, calendly: src.calendly, activity: src.activityByDay[day], shift: src.shiftByDay[day], now };
}

/**
 * The same sources for a run of ET days, each read once for the whole run: the queue, Quo and
 * Calendly over the span, Hub activity and shifts per day. buildReport then cuts out one day at a
 * time, so a day in a range reads exactly as that day's own report. `keepRecords` also hands back
 * the decorated queue, for questions about the cards rather than the calls (leads still to call).
 */
export async function gatherRange({ redis, rep, from, to, now = Date.now(), decorate, deps = {}, keepRecords = false }) {
    const email = norm(rep.email);
    const emails = loginAliases(email);
    const days = daysBetween(from, to);
    const span = { from: dayRange(from).from, to: dayRange(to).to };
    const inSpan = d => d >= from && d <= to;
    const at = () => new Date().toISOString();

    const hub = { ok: false };
    try {
        const state = await redis.get(QUEUE_KEY);
        if (!state) throw Error('the queue store answered with nothing');
        let view = visibleState(state, 'all');
        if (decorate) { try { view = await decorate(view); } catch { /* numbers fall back to what the record holds */ } }
        const mine = view.records.filter(r => (r.callHistory || []).some(c => c && emails.includes(norm(c.caller))));
        let extra = {};
        try { extra = await numbersFor(redis, mine); } catch { extra = {}; }
        const { entries, cards } = hubEntriesFrom(view.records, emails, extra);
        Object.assign(hub, { ok: true, entries, cards, readAt: at(), stateUpdatedAt: state.queueUpdatedAt || state.updatedAt || null }, keepRecords ? { records: view.records } : {});
    } catch (e) { hub.error = String((e && e.message) || e).slice(0, 120); }

    const q = { configured: (deps.quoConfigured || quoConfigured)(), ok: false, seat: null };
    if (q.configured) {
        try {
            const users = await (deps.listUsers || listUsers)();
            q.seat = findSeat(users, emails);
            if (q.seat) {
                const { items, complete } = await (deps.listCalls || listCalls)({ actorId: q.seat.actorId, direction: 'outgoing', from: etDayBounds(from).from, to: etDayBounds(to).to });
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
            // Bookings MADE in the span can be for any later date, so the window runs forward from it.
            const { items, complete } = await (deps.pastEvents || pastEvents)({ since: span.from, until: new Date(ms(span.to) + 120 * 86400000).toISOString(), ...scope, maxPages: 10 });
            if (complete === false) throw Error('more Calendly events than were read');
            const bookings = [];
            for (const ev of items || []) {
                if (!inSpan(etDay(ev.created_at)) || !/discovery/i.test(String(ev.name || ''))) continue;
                // A failed invitee read makes meetings unknown for the span, never a silent zero.
                const people = await (deps.invitees || invitees)(ev.uri);
                for (const p of people) if (p.email && (!p.status || p.status === 'active') && !p.oldInvitee) bookings.push({ email: p.email, createdAt: ev.created_at, startTime: ev.start_time, eventName: ev.name || null });
            }
            Object.assign(cal, { ok: true, bookings, readAt: at() });
        } catch (e) { cal.error = String((e && e.message) || e).slice(0, 120); }
    }

    const activityByDay = {};
    const oldest = daysBefore(etDay(new Date(now)), ACTIVITY_RETAIN_DAYS);
    let sessionsDoc; let sessionsRead = false;
    for (const day of days) {
        if (day < ACTIVITY_SINCE) { activityByDay[day] = { notMeasured: true, reason: 'Hub activity was not measured before Oct 23, 2026.' }; continue; }
        if (day < oldest) { activityByDay[day] = { notMeasured: true, reason: 'Hub activity is kept for 120 days; this day is older.' }; continue; }
        try {
            const [minutes, raw, doc] = await Promise.all([redis.smembers(ACT.minutes(email, day)), redis.lrange(ACT.events(email, day), 0, 499), sessionsRead ? sessionsDoc : redis.get(ACT.sessions(email))]);
            sessionsDoc = doc; sessionsRead = true;
            const events = (raw || []).map(x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } }).filter(Boolean);
            activityByDay[day] = { ...summarizeDay({ day, minutes: minutes || [], sessions: sessionsOn(doc, day), events }), events };
        } catch { activityByDay[day] = null; }
    }

    const shiftByDay = {};
    // One read of the running shift serves every day; on a failure each day reads it for itself.
    let current;
    if (days.length > 1) { try { current = await readCurrent(redis, email); } catch { current = undefined; } }
    for (const day of days) {
        if (day < SHIFT_SINCE) { shiftByDay[day] = { notMeasured: true, reason: 'Shifts were not declared in the Hub before Oct 24, 2026.' }; continue; }
        try { shiftByDay[day] = await shiftsOn(redis, email, day, now, current); } catch { shiftByDay[day] = { unavailable: true }; }
    }

    return { user: { email, name: rep.name || email }, from, to, days, span, hub, quo: q, calendly: cal, activityByDay, shiftByDay, now };
}
