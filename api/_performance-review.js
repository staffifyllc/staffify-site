// Caller review: how one caller's calling went over a run of days, from the records that prove it.
import { poolPaused } from './_campaign-pause.js';
// ------------------------------------------------------------------
// Paul, 2026-10-27: "can we get some data on how miltons performance has been he really said the
// data isn't great", then "idk where we are getting the 'Picked up' data from but it doesn't appear
// to be correct", then "we need that view put into performance as a tab".
//
// Every day in the review IS that day's buildReport (api/_daily-report.js), cut from sources read
// once for the whole span, so the review and the daily report never disagree about a day. On top of
// the days it answers the questions that came up reading them:
//   who answered            the outcome the caller chose (never Quo's answered flag, which
//                           voicemail and phone menus also set); notes only feed a list to check
//   are the numbers bad     outcomes and notes that say so, per prospect and per campaign
//   is there enough to call callable cards nobody has dialled yet, by where the number came from
//   when he calls           each call at the prospect's local time, inferred from the area code
//   who he calls again      attempts per prospect and next-day callbacks
//   pace and logging        dials per clocked hour, Hub activity, dials with no outcome logged
// No quota, target or judgement is applied, and a source that could not be read stays unknown.
import { buildReport, dayRange, pairCalls, OUTCOME_LABEL } from './_daily-report.js';
import { etDay } from './_quo.js';
import { localClock } from './_area-time.js';
import { NAMES as CAMPAIGN_NAMES } from './_campaigns-model.js';
import { quietDay } from './_live-status.js';

export const REVIEW_VERSION = 1;
export const MAX_DAYS = 31;
const ms = s => Date.parse(s);
const norm = e => String(e || '').trim().toLowerCase();

// ---- who answered, and notes worth a second look ------------------------------------------------
// Three review rounds (2026-10-27) fed this file hundreds of real and invented caller notes. Every
// keyword rule for "who answered" misread common ones: Staffify sells assistants, so prospects talk
// about assistants; gatekeeper shorthand is endless; "LVM, spoke to him last week" is past tense.
// So the count never reads notes. A call reached a person when the OUTCOME the caller chose says so:
// Conversation, Callback agreed, Not now, or Not interested on a call Quo confirms (the stop button
// is also used for closed businesses, so an unconfirmed one is not counted). That is exact.
// Notes only feed a short "notes to check" list: a No answer or Voicemail whose note sounds like a
// person answered, or a Conversation whose note sounds like staff or a hang-up. A person reads them;
// they are never added to any figure, so a wrong guess costs a glance, not a wrong number.
const HOW = { connected: 'Conversation', callback: 'Callback agreed', gatekeeper: 'Gatekeeper', timing: 'Not now', suppress: 'Not interested' };

/** A person answered, by the outcome chosen. `verified`: a Quo dial was paired with it. */
export function answeredFrom(entry, { verified = false } = {}) {
    const o = entry && entry.outcome;
    // A gatekeeper is a person answering, just not the owner (until 2026-10-27 it was logged as Callback).
    if (o === 'connected' || o === 'callback' || o === 'gatekeeper' || o === 'timing') return { how: HOW[o] };
    if (o === 'suppress' && verified) return { how: HOW[o] };
    return null;
}

const STAFFISH = /\b(assistant|asst|gatekeeper|gk|receptionist|front desk|secretary|office (?:manager|mgr)|ea|admin|chief of staff|answering service|wife|husband)\b/i;
const PERSONISH = /\bh(?:ung|ang|anged|angs)[\s-]?up\b|\bhu\b|\b(?:answered|picked up|spoke|talked|said|stated|told|asked)\b|\bline went dead\b/i;
const MACHINE_ONLY = /^(?:\[[^\]]*\]\s*)?(?:lvm|vm|left (?:a )?(?:vm|voicemail|message)|na|no answer|nvm\w*|rang out|texted[^.]*|they never answer\w*|too late to call|the vm is not set up)[.!\s]*$/i;
const NOBODY = /\b(?:never|nobody|no one|didn'?t|did not)\b[^.]{0,20}?\b(?:answer(?:ed)?|pick(?:ed)? up)\b/i;

/** For the "notes to check" list only: what a note may say that the outcome does not. */
export function noteHint(entry) {
    const o = entry && entry.outcome, note = String((entry && entry.notes) || '').replace(/\s+/g, ' ').trim();
    if (!note || MACHINE_ONLY.test(note)) return null;
    if (o === 'no_answer' || o === 'voicemail') {
        if (NOBODY.test(note)) return null;
        if (STAFFISH.test(note) || PERSONISH.test(note)) return 'Logged as ' + (o === 'voicemail' ? 'voicemail' : 'no answer') + ', but the note may describe a person answering.';
        return null;
    }
    if (o === 'connected') {
        if (/\bh(?:ung|ang|anged|angs)[\s-]?up\b|\bhu\b/i.test(note)) return 'Logged as a conversation, but the note mentions a hang-up.';
        if (STAFFISH.test(note)) return 'Logged as a conversation, but the note may describe staff rather than the prospect.';
    }
    return null;
}

const BAD = /\b(wrong number|not in service|out of service|no longer in service|invalid number|not a working number|fax (?:line|number|tone)|(?:number|line|phone)(?: is| was)? disconnected|disconnected (?:number|line))\b/i;
const NO_NUMBER = /\bno (?:phone |good |working )?number\b/i;
const GENERAL_LINE = /\b(general (?:number|line)|business (?:number|line)|main (?:number|line)|company (?:number|line)|switchboard|phone tree|automated (?:line|system|menu)|press \d)\b/i;
const NO_CONNECT = /\b(won'?t dial|wont dial|can'?t dial|cant dial|could not dial|did not go through|didn'?t go through|wouldn'?t go through|call failed)\b/i;

/** What the outcome or the note says is wrong with the number, or null. */
export function numberIssue(entry) {
    if (!entry) return null;
    if (entry.outcome === 'wrong_number') return 'Wrong or dead number';
    const note = String(entry.notes || '');
    if (BAD.test(note)) return 'Wrong or dead number';
    if (NO_NUMBER.test(note)) return 'No number';
    if (GENERAL_LINE.test(note)) return 'General business line';
    if (NO_CONNECT.test(note)) return 'Call would not go through';
    return null;
}

/** A note as shown: no dialable number in it, and short. Dates (10/27/2026, 10-28-2026) and money ranges ($1,500, 1500-2000) stay readable. */
const NUMBER_RUN = /(?<![\d$])\+?\(?\d(?:[\s.()\/\-­‐-―−﹣－]{0,3}\d){6,14}(?!\d)/g;
const DATE_LIKE = /^\d{1,2}\s?[-\/.]\s?\d{1,2}\s?[-\/.]\s?\d{2,4}$/;
const RANGE_LIKE = /^\d{4,6}\s?[-–]\s?\d{4,6}$/;
export function cleanNote(s) {
    return String(s || '').replace(/\s+/g, ' ').replace(NUMBER_RUN, m => (DATE_LIKE.test(m) || RANGE_LIKE.test(m) ? m : '[number]')).trim().slice(0, 240);
}

export const campaignName = id => (id && CAMPAIGN_NAMES[id] && CAMPAIGN_NAMES[id].name) || (id ? String(id) : 'No campaign');

// ---- the clock --------------------------------------------------------------------------------
export const BUCKETS = [
    ['before9', 'Before 9 AM'], ['morning', '9 AM to noon'], ['afternoon', 'Noon to 5 PM'],
    ['five', '5 to 6 PM'], ['evening', 'After 6 PM'], ['unknown', 'Time zone unknown'],
];
export function bucketOf(clock) {
    if (!clock) return 'unknown';
    const m = clock.hour * 60 + clock.minute;
    return m < 540 ? 'before9' : m < 720 ? 'morning' : m < 1020 ? 'afternoon' : m < 1080 ? 'five' : 'evening';
}
const etHour = iso => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date(iso))) % 24;
const hourLabel = h => (h % 12 || 12) + (h < 12 ? ' AM' : ' PM');

const rate = (num, den) => (den > 0 ? { num, den, pct: Math.round((num / den) * 1000) / 10 } : { num, den, pct: null });
const sum = (rows, f) => { let n = 0; for (const r of rows) { const v = f(r); if (v === null || v === undefined) return null; n += v; } return n; };

// ---- leads still to call ----------------------------------------------------------------------
const DIALABLE = ['business_listed', 'available', 'vendor_direct', 'site_main', 'crm_unconfirmed'];
export const SOURCE_LABEL = {
    business_listed: 'Published on their own website',
    site_main: 'Main line from their website',
    vendor_direct: 'Direct dial from a data vendor',
    crm_unconfirmed: 'CRM number, not found on their website',
    available: 'CRM number, website not checked yet',
};
/** Callable cards nobody has dialled or claimed, as the dialer would offer them, and his own due follow-ups. */
export function leadSupply(records, emails) {
    const mine = new Set((emails || []).map(norm));
    const callable = r => r && r.callReady && r.callContact && r.callContact.phone && DIALABLE.includes(r.callContact.phoneStatus);
    // Paused campaigns (real estate media, 2026-10-27) are nobody's next call, so they are not supply.
    const fresh = (records || []).filter(r => callable(r) && !r.callOwner && !poolPaused(r) && !(r.callHistory || []).some(c => c && c.at));
    const count = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
    return {
        neverDialled: fresh.length,
        bySource: count(fresh, r => r.callContact.phoneStatus).map(([status, n]) => ({ status, label: SOURCE_LABEL[status] || status, n })),
        byCampaign: count(fresh, r => r.campaignId || null).map(([id, n]) => ({ campaignId: id, name: campaignName(id), n })),
        hisFollowUpsDue: (records || []).filter(r => callable(r) && r.callOwner && mine.has(norm(r.callOwner)) && !poolPaused(r)).length,
        hisPausedFollowUps: (records || []).filter(r => callable(r) && r.callOwner && mine.has(norm(r.callOwner)) && poolPaused(r)).length,
        pausedNotOffered: (records || []).filter(r => callable(r) && !r.callOwner && poolPaused(r) && !(r.callHistory || []).some(c => c && c.at)).length,
    };
}

// ---- the review -------------------------------------------------------------------------------
/**
 * The review, from sources already read by gatherRange. Pure, so it is tested without a network.
 * `src` is gatherRange's result; `records` (optional) is the decorated queue for leadSupply.
 */
export function buildReview(src, { generatedAt = new Date().toISOString(), now = Date.parse(generatedAt), emails = [src.user.email] } = {}) {
    const { hub, calendly } = src;
    // A Quo read that stopped before the end of its pages could be missing any day in the span, so
    // the whole review treats Quo as unread rather than showing a low count as if it were exact.
    const quo = src.quo.ok && src.quo.complete === false ? { ...src.quo, ok: false, error: 'Quo had more calls in these dates than could be read' } : src.quo;
    const reports = src.days.map(day => buildReport({ user: src.user, day, generatedAt, range: dayRange(day), hub, quo, calendly, activity: src.activityByDay[day], shift: src.shiftByDay[day], now }));
    const quoOk = !!quo.ok, hubOk = !!hub.ok;
    const span = { from: dayRange(src.from).from, to: dayRange(src.to).to };
    const inSpan = iso => { const d = etDay(iso); return d >= src.from && d <= src.to; };
    const entries = hubOk ? hub.entries.filter(e => inSpan(e.at)) : [];
    const calls = quoOk ? quo.calls.filter(c => inSpan(c.at)) : [];
    // Pair across the whole span so a call just before midnight still finds its outcome.
    const { dials, outcomes } = pairCalls(calls, entries);
    const dialById = new Map(dials.map(d => [d.id, d]));

    // Each logged outcome, read once.
    const read = outcomes.map(e => {
        const dial = e.pairedWith ? dialById.get(e.pairedWith) : null;
        const when = dial ? dial.at : e.at;
        const number = (dial && dial.number) || (e.numbers && e.numbers[0]) || null;
        const clock = number ? localClock(when, number) : null;
        return { e, day: etDay(e.at), when, clock, bucket: bucketOf(clock), reached: answeredFrom(e, { verified: !!dial }), hint: noteHint(e), issue: numberIssue(e), verified: !!dial };
    }).sort((a, b) => ms(a.when) - ms(b.when));

    // Day by day. A day with nothing on any source is listed as quiet rather than as a row of zeros.
    const reachedOn = day => read.filter(x => x.day === day && x.reached);
    const rows = reports.map(r => {
        const reached = reachedOn(r.day);
        const dayCalls = calls.filter(c => etDay(c.at) === r.day).sort((a, b) => ms(a.at) - ms(b.at));
        const clocked = r.shift && !r.shift.notMeasured ? r.shift.clockedMinutes : null;
        // Quiet on shift: 10 minutes or more of a running shift with no Hub minute and no Quo call.
        // Needs all three sources for the day; otherwise unknown.
        const act = src.activityByDay[r.day];
        const quiet = quoOk && r.shift && !r.shift.notMeasured && !r.shift.unavailable && act && !act.notMeasured && Array.isArray(act.minuteList)
            && quo.inbound !== null
            ? quietDay({ day: r.day, minutes: act.minuteList, calls: [...dayCalls, ...(quo.inbound || []).filter(c => etDay(c.at) === r.day)].map(c => ({ at: c.at, seconds: c.seconds })), shiftList: r.shift.list || [], events: act.events || [], now, until: ms(dayRange(r.day).to) + 1 }) : null;
        const active = r.activity && !r.activity.notMeasured ? r.activity.activeMinutes : null;
        return {
            day: r.day, partial: r.partialDay,
            dials: r.calls.verifiedAttempts, numbers: r.calls.uniqueNumbersCalled, talkSeconds: r.calls.talkSeconds,
            outcomes: r.calls.loggedOutcomes, prospects: r.calls.loggedProspects, byOutcome: r.calls.byOutcome,
            reached: hubOk ? reached.length : null,
            meetings: r.meetings.booked,
            clockedMinutes: clocked, shiftMeasured: !!(r.shift && !r.shift.notMeasured && !r.shift.unavailable), shiftUnavailable: !r.shift || !!r.shift.unavailable,
            activeMinutes: active, activityMeasured: !!(r.activity && !r.activity.notMeasured), activityUnavailable: r.activity === null || r.activity === undefined,
            dialsPerClockedHour: clocked >= 30 && r.calls.verifiedAttempts !== null ? Math.round((r.calls.verifiedAttempts / (clocked / 60)) * 10) / 10 : null,
            firstDial: dayCalls.length ? dayCalls[0].at : null, lastDial: dayCalls.length ? dayCalls[dayCalls.length - 1].at : null,
            dialSpanMinutes: dayCalls.length > 1 ? Math.round((ms(dayCalls[dayCalls.length - 1].at) - ms(dayCalls[0].at)) / 60000) : null,
            dialsWithoutOutcome: r.calls.dialsWithoutOutcome, outcomesWithoutQuoCall: r.calls.outcomesWithoutQuoCall,
            notesToCheck: hubOk ? read.filter(x => x.day === r.day && x.hint).length : null,
            onShiftMinutes: quiet ? quiet.onShiftMinutes : null, quietMinutes: quiet ? quiet.quietMinutes : null, quietStretches: quiet ? quiet.stretches : null,
            // Quiet only when every source was read and had nothing: an unread source keeps the row, so its unknowns show.
            quiet: !(r.meetings.booked > 0) && (r.noRecordedActivity || (quoOk && hubOk && r.calls.verifiedAttempts === 0 && r.calls.loggedOutcomes === 0 && !!r.shift && !r.shift.unavailable && !!r.activity && !(clocked > 0) && !(active > 0))),
        };
    });
    const worked = rows.filter(r => !r.quiet);
    const quietDays = rows.filter(r => r.quiet).map(r => r.day);

    const reachedAll = read.filter(x => x.reached);
    const dialsTotal = quoOk ? calls.length : null;
    const totals = {
        daysWorked: worked.filter(r => r.dials > 0 || r.outcomes > 0 || r.clockedMinutes > 0 || r.activeMinutes > 0 || r.meetings > 0).length,
        dials: dialsTotal,
        numbers: quoOk ? new Set(calls.map(c => c.number).filter(Boolean)).size : null,
        talkSeconds: quoOk ? calls.reduce((n, c) => n + (c.seconds || 0), 0) : null,
        outcomes: hubOk ? entries.length : null,
        prospects: hubOk ? new Set(entries.map(e => e.recordId)).size : null,
        reached: hubOk ? reachedAll.length : null,
        reachedByHow: hubOk ? Object.values(HOW).map(how => ({ how, n: reachedAll.filter(x => x.reached.how === how).length })).filter(x => x.n) : null,
        meetings: sum(rows, r => r.meetings),
        clockedMinutes: rows.some(r => !r.quiet && r.shiftUnavailable) ? null : rows.some(r => r.shiftMeasured) ? rows.reduce((n, r) => n + (r.clockedMinutes || 0), 0) : null,
        activeMinutes: rows.some(r => !r.quiet && r.activityUnavailable) ? null : rows.some(r => r.activityMeasured) ? rows.reduce((n, r) => n + (r.activeMinutes || 0), 0) : null,
        dialsWithoutOutcome: sum(rows, r => r.dialsWithoutOutcome),
        outcomesWithoutQuoCall: sum(rows, r => r.outcomesWithoutQuoCall),
        notesToCheck: hubOk ? read.filter(x => x.hint).length : null,
    };
    const byOutcome = {}; for (const k of Object.keys(OUTCOME_LABEL)) byOutcome[k] = 0;
    for (const e of entries) byOutcome[e.outcome] = (byOutcome[e.outcome] || 0) + 1;
    totals.byOutcome = hubOk ? byOutcome : null;
    // Of the Quo dials, how many reached a person. Only answers paired with a Quo dial count, so the
    // rate can never pass 100%; answers on outcomes with no Quo call are counted beside it.
    totals.reachedPerDial = hubOk && quoOk ? rate(reachedAll.filter(x => x.verified).length, calls.length) : null;
    totals.reachedWithoutQuoCall = hubOk && quoOk ? reachedAll.filter(x => !x.verified).length : null;

    // Who answered, call by call.
    const reachedList = reachedAll.map(x => ({ at: x.when, day: x.day, company: x.e.company, campaign: campaignName(x.e.campaignId), how: x.reached.how, note: cleanNote(x.e.notes), verified: x.verified }));

    // Numbers: per prospect, anything the outcomes or notes say is wrong with the number.
    const perProspect = new Map();
    for (const x of read) {
        const p = perProspect.get(x.e.recordId) || { recordId: x.e.recordId, company: x.e.company, campaignId: x.e.campaignId || null, attempts: 0, outcomes: [], reached: false, issues: new Set(), notes: [], lastAt: null };
        p.attempts++; p.outcomes.push(OUTCOME_LABEL[x.e.outcome] || x.e.outcome); if (x.reached) p.reached = true;
        if (x.issue) { p.issues.add(x.issue); if (x.e.notes) p.notes.push(cleanNote(x.e.notes)); }
        p.lastAt = x.when; perProspect.set(x.e.recordId, p);
    }
    const prospects = [...perProspect.values()];
    const flagged = prospects.filter(p => p.issues.size);
    const byIssue = {}; for (const p of flagged) for (const i of p.issues) byIssue[i] = (byIssue[i] || 0) + 1;

    const segMap = new Map();
    for (const x of read) {
        const id = x.e.campaignId || null;
        const s = segMap.get(id) || { campaignId: id, name: campaignName(id), prospects: new Set(), outcomes: 0, reached: 0, voicemail: 0, noAnswer: 0, flagged: new Set() };
        s.prospects.add(x.e.recordId); s.outcomes++;
        if (x.reached) s.reached++;
        if (x.e.outcome === 'voicemail') s.voicemail++; if (x.e.outcome === 'no_answer') s.noAnswer++;
        if (x.issue) s.flagged.add(x.e.recordId);
        segMap.set(id, s);
    }
    const segments = [...segMap.values()].map(s => ({ ...s, prospects: s.prospects.size, flagged: s.flagged.size })).sort((a, b) => b.outcomes - a.outcomes);

    // When: the prospect's local time for each logged call, and the Eastern hour of each Quo dial.
    const buckets = BUCKETS.map(([key, label]) => { const xs = read.filter(x => x.bucket === key); return { key, label, outcomes: xs.length, reached: xs.filter(x => x.reached).length }; });
    const hours = new Map(); for (const c of calls) { const h = etHour(c.at); hours.set(h, (hours.get(h) || 0) + 1); }
    const etHours = [...hours].sort((a, b) => a[0] - b[0]).map(([hour, n]) => ({ hour, label: hourLabel(hour) + ' Eastern', dials: n }));

    // Calling the same people again.
    const dist = [['Once', p => p.attempts === 1], ['Twice', p => p.attempts === 2], ['Three times', p => p.attempts === 3], ['Four or more', p => p.attempts >= 4]].map(([label, f]) => ({ label, prospects: prospects.filter(f).length }));
    const retryable = read.filter(x => (x.e.outcome === 'no_answer' || x.e.outcome === 'voicemail') && x.e.nextCallAt);
    const nextDay = retryable.filter(x => ms(x.e.nextCallAt) - ms(x.e.at) <= 36 * 3600000);
    const mostCalled = prospects.filter(p => p.attempts >= 2).sort((a, b) => b.attempts - a.attempts || ms(b.lastAt) - ms(a.lastAt)).slice(0, 12)
        .map(p => ({ company: p.company, campaign: campaignName(p.campaignId), attempts: p.attempts, outcomes: p.outcomes, reached: p.reached, lastAt: p.lastAt }));

    const coverage = [];
    const r0 = reports[0];
    if (r0) coverage.push(...r0.coverage.filter(c => /Quo|Hub call log|Calendly/.test(c) && !/this day|that day/.test(c)).map(c => c.replace(/\bhe logged\b/g, 'this caller logged')));
    if (src.quo.ok && src.quo.complete === false) coverage.push('Quo had more calls in these dates than could be read, so dials are unknown. Pick fewer days.');
    coverage.push("Who answered comes from the outcome chosen on each call, not from Quo: Quo marks a call answered when voicemail or a phone menu picks up. Notes are never counted; ones that may disagree with their outcome are listed to check.");
    coverage.push("Local times come from each number's area code, which is where the number was issued. A mobile number can travel.");
    const notMeasuredShift = rows.filter(r => !r.quiet && !r.shiftMeasured && !r.shiftUnavailable && (r.dials > 0 || r.outcomes > 0)).map(r => r.day);
    const shiftUnread = rows.filter(r => !r.quiet && r.shiftUnavailable).length, activityUnread = rows.filter(r => !r.quiet && r.activityUnavailable).length;
    if (shiftUnread) coverage.push('Shift records could not be read on ' + shiftUnread + (shiftUnread === 1 ? ' day' : ' days') + ', so the shift total is unknown.');
    if (activityUnread) coverage.push('Hub activity could not be read on ' + activityUnread + (activityUnread === 1 ? ' day' : ' days') + ', so the activity total is unknown.');
    if (notMeasuredShift.length) coverage.push('Shifts were not recorded on ' + notMeasuredShift.length + (notMeasuredShift.length === 1 ? ' day' : ' days') + ' with calls (declared shifts began Oct 24, 2026), so pace per clocked hour is blank there.');
    if (totals.meetings === null) coverage.push('Meetings are unknown for at least one day, because Calendly or the Hub log could not be read.');

    return {
        version: REVIEW_VERSION, user: src.user, from: src.from, to: src.to, span, generatedAt,
        partial: now < ms(span.to),
        sources: { quo: quoOk ? 'read' : !quo.configured ? 'not connected' : quo.error ? 'unavailable' : !quo.seat ? 'no seat for this login' : 'unavailable', hubLog: hubOk ? 'read' : 'unavailable', calendly: calendly.ok ? 'read' : !calendly.configured ? 'not connected' : 'unavailable' },
        freshness: { hubLog: hub.readAt || null, quo: quo.readAt || null, calendly: calendly.readAt || null },
        coverage,
        totals,
        days: worked, quietDays,
        reached: { list: reachedList },
        numbers: { prospects: hubOk ? prospects.length : null, flagged: hubOk ? flagged.length : null, byIssue: Object.entries(byIssue).map(([issue, n]) => ({ issue, n })).sort((a, b) => b.n - a.n),
            list: flagged.map(p => ({ company: p.company, campaign: campaignName(p.campaignId), issues: [...p.issues], note: p.notes[0] || null })) },
        segments,
        timing: { buckets: hubOk ? buckets : null, etHours, knownZone: hubOk ? read.filter(x => x.clock).length : null },
        repeats: hubOk ? { prospects: prospects.length, distribution: dist, nextDay: rate(nextDay.length, retryable.length), mostCalled } : null,
        quiet: worked.some(r => r.quietStretches) ? {
            onShiftMinutes: worked.reduce((n, r) => n + (r.onShiftMinutes || 0), 0), quietMinutes: worked.reduce((n, r) => n + (r.quietMinutes || 0), 0),
            daysMeasured: worked.filter(r => r.quietStretches).length, daysUnknown: worked.filter(r => !r.quietStretches && r.shiftMeasured).length,
            list: worked.flatMap(r => (r.quietStretches || []).map(x => ({ day: r.day, ...x }))),
        } : null,
        notesToCheck: hubOk ? read.filter(x => x.hint).map(x => ({ at: x.when, company: x.e.company, logged: OUTCOME_LABEL[x.e.outcome] || x.e.outcome, hint: x.hint, note: cleanNote(x.e.notes) })) : null,
        supply: null,
        definitions: {
            dials: "Outbound calls placed through Quo by this caller's own Quo user. The only calls counted as verified.",
            outcomes: 'What was logged on each card in the Hub. Manual.',
            reached: 'A call logged as Conversation, Callback agreed or Not now, or Not interested on a call Quo confirms. Who it was (owner or staff) is in the note.',
            notesToCheck: 'A No answer or Voicemail whose note may describe a person answering, or a Conversation whose note may describe staff or a hang-up. Read from the words of the note, so some are false alarms; never counted in any figure.',
            numbers: 'A Wrong number outcome, or a note saying the number is dead, missing, a general business line, or would not connect.',
            local: "The prospect's clock when the call was made, from the dialled number's area code, or the card's number when no Quo call matched.",
            nextDay: 'No answer and voicemail outcomes whose next call was set for 36 hours or less later.',
            supply: 'Cards ready to call with a number, that nobody has called or claimed. Right now, not for the dates above.',
            quiet: "10 minutes or more of a running, declared shift with no Hub click, key or scroll and no Quo call. Breaks are not counted. A call from the phone's own dialer is invisible here. Never deducted from the shift and never payroll.",
        },
    };
}
