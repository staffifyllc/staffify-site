// Declared shifts: a caller says "I am working" from the Hub, and the server keeps the time.
// ------------------------------------------------------------------
// Paul, 2026-10-24 (through Codex): "add an explicit Start shift button for Milton that starts his
// timer/log, and require an active shift before he can place calls through the Hub ... Separate
// declared shift time from observed Hub activity and payroll-approved hours; don't automatically
// turn this into payroll or silently deduct idle time while he's on a phone call."
//
// Three different things, kept apart on purpose:
//   declared shift   what the rep clocked: Start, Break, Resume, End, each a server timestamp
//                    tied to the signed-in identity. Clocked time is end minus start minus breaks.
//                    Hub idle time is never deducted: a rep on the phone is working.
//   observed         what the Hub measured (_hub-activity.js): an estimate that misses calls.
//   paid hours       Hubstaff. Nothing here is payroll.
//
// One shift at a time per person, across tabs and devices: the current shift lives under one key,
// created with SET NX behind a short lock. A shift open longer than MAX_OPEN_MS is treated as
// forgotten: it stops allowing calls, and it is kept with its real timestamps but flagged
// needs_review and left out of totals until an owner corrects the end time with a note. If the rep
// presses Start again, the forgotten shift is archived with NO end time rather than an invented one.
// A correction can only shorten a shift, never lengthen it, and it is kept next to the original.
//
// Storage: the current shift under one key; each finished or archived shift in a hash per person
// per ET day, keyed by shift id, so a retried End or a correction overwrites one field instead of
// rebuilding a list, and the same shift can never be stored twice. A read failure throws: an
// unreadable store is "unavailable", never "no shift" and never zero hours.
import { dayOf, norm } from './_hub-activity.js';

export const MAX_OPEN_MS = 12 * 3600000;
export const RETAIN_DAYS = 400;
export const K = {
    current: email => `shift:cur:${norm(email)}`,
    lock: email => `shift:lock:${norm(email)}`,
    log: (email, day) => `shift:log2:${norm(email)}:${day}`,
    days: email => `shift:days:${norm(email)}`,
};
const iso = t => new Date(t).toISOString();
const ms = s => Date.parse(s);

/** Who has to be on shift to call: everyone who is not a sales owner or the admin token. */
export const shiftRequired = (rep, ownerFor) => !!rep && norm(rep.email) !== 'admin' && !ownerFor(rep);

/** off | on | break | stale (open longer than MAX_OPEN_MS, no longer allows calls). */
export function stateOf(doc, now = Date.now()) {
    if (!doc || !doc.startedAt) return 'off';
    if (now - ms(doc.startedAt) >= MAX_OPEN_MS) return 'stale';
    const b = (doc.breaks || []).slice(-1)[0];
    return b && !b.endedAt ? 'break' : 'on';
}

export const GATE_TEXT = Object.freeze({
    off: 'Start your shift to call.',
    break: 'You are on a break. Resume your shift to call.',
    stale: 'This shift has been open for more than 12 hours. End it and start a fresh one to call.',
});
/** Whether a call may be placed from the Hub right now, and the one line that says why not. */
export function gate(doc, now = Date.now(), { required = true } = {}) {
    const state = stateOf(doc, now);
    const allowed = !required || state === 'on';
    return { required, state, allowed, reason: allowed ? null : state, message: allowed ? null : GATE_TEXT[state] };
}

// ---- transitions, pure -----------------------------------------------------------------------
export function start(doc, now, { page = null } = {}) {
    if (doc && doc.startedAt && stateOf(doc, now) !== 'stale') return { ok: false, error: 'already_on_shift', doc };
    const fresh = { id: 'sh-' + now.toString(36), startedAt: iso(now), day: dayOf(now), breaks: [], endedAt: null, status: 'open', startedOn: page };
    // A forgotten shift is archived as it was found: open, with no end time. Nobody invents one.
    const archived = doc && doc.startedAt ? { ...doc, endedAt: null, status: 'needs_review', flags: ['open_over_12h', 'never_ended'], archivedAt: iso(now) } : null;
    return { ok: true, doc: fresh, archived };
}
export function startBreak(doc, now) {
    const s = stateOf(doc, now);
    if (s === 'off') return { ok: false, error: 'not_on_shift' };
    if (s === 'break') return { ok: false, error: 'already_on_break', doc };
    if (s === 'stale') return { ok: false, error: 'shift_too_long', doc };
    return { ok: true, doc: { ...doc, breaks: [...(doc.breaks || []), { startedAt: iso(now), endedAt: null }] } };
}
export function resume(doc, now) {
    const s = stateOf(doc, now);
    if (s === 'off') return { ok: false, error: 'not_on_shift' };
    if (s !== 'break') return { ok: false, error: s === 'stale' ? 'shift_too_long' : 'not_on_break', doc };
    const breaks = (doc.breaks || []).map((b, i, a) => (i === a.length - 1 ? { ...b, endedAt: iso(now) } : b));
    return { ok: true, doc: { ...doc, breaks } };
}
export function end(doc, now) {
    if (!doc || !doc.startedAt) return { ok: false, error: 'not_on_shift' };
    const breaks = (doc.breaks || []).map(b => (b.endedAt ? b : { ...b, endedAt: iso(now) }));
    const tooLong = now - ms(doc.startedAt) >= MAX_OPEN_MS;
    return { ok: true, doc: { ...doc, breaks, endedAt: iso(now), status: tooLong ? 'needs_review' : 'closed', flags: tooLong ? ['open_over_12h'] : [] } };
}
/** A stale shift still in the current slot, archived by an owner: open, no end time, flagged. */
export function archiveStale(doc, now, by) {
    if (!doc || !doc.startedAt) return { ok: false, error: 'no_such_shift' };
    if (stateOf(doc, now) !== 'stale') return { ok: false, error: 'still_running' };
    return { ok: true, doc: { ...doc, endedAt: null, status: 'needs_review', flags: ['open_over_12h', 'never_ended'], archivedAt: iso(now), archivedBy: norm(by) } };
}
/** An owner shortens a shift that ran too long, with a note. The original stays on the record. */
export function correct(shift, { endedAt, note, by, at = Date.now() }) {
    if (!shift || !shift.startedAt) return { ok: false, error: 'no_such_shift' };
    if (!note || !String(note).trim()) return { ok: false, error: 'note_required' };
    const to = Date.parse(endedAt);
    if (!Number.isFinite(to)) return { ok: false, error: 'bad_time' };
    const ceiling = ms(shift.endedAt || shift.archivedAt || iso(at));
    if (to < ms(shift.startedAt)) return { ok: false, error: 'before_start' };
    if (to > ceiling) return { ok: false, error: 'cannot_lengthen' };
    // A shift that was never ended cannot be corrected past twelve hours: that is the most a shift
    // can run before it is flagged, so a correction cannot produce more than a shift could.
    if (!shift.endedAt && to - ms(shift.startedAt) > MAX_OPEN_MS) return { ok: false, error: 'cannot_lengthen' };
    const from = shift.correctedEndedAt || shift.endedAt || null;
    const entry = { by: norm(by), at: iso(at), field: 'endedAt', from, to: iso(to), note: String(note).trim().slice(0, 300) };
    return { ok: true, doc: { ...shift, correctedEndedAt: iso(to), status: 'corrected', corrections: [...(shift.corrections || []), entry] } };
}

// ---- durations and summaries, pure ----------------------------------------------------------
/** Elapsed, break and clocked minutes of one shift, as of `now` for an open one. */
export function minutesOf(shift, now = Date.now()) {
    // An archived shift that was never ended stops growing at the moment it was archived. It still
    // counts nothing (needs_review) until an owner sets its end; this only keeps the figure finite.
    const endAt = shift.correctedEndedAt || shift.endedAt || shift.archivedAt || iso(now);
    const endMs = ms(endAt), startMs = ms(shift.startedAt);
    const total = Math.max(0, endMs - startMs);
    let brk = 0;
    for (const b of shift.breaks || []) {
        const bs = ms(b.startedAt); if (!(bs < endMs)) continue;
        const be = Math.min(b.endedAt ? ms(b.endedAt) : endMs, endMs);
        brk += Math.max(0, be - bs);
    }
    return { elapsedMinutes: Math.round(total / 60000), breakMinutes: Math.round(brk / 60000), clockedMinutes: Math.round((total - brk) / 60000) };
}
/** closed | corrected | needs_review | open | open_too_long, from the record and the clock. */
export function stateLabel(shift, now = Date.now()) {
    if (shift.endedAt || shift.archivedAt) return shift.status === 'corrected' ? 'corrected' : shift.status === 'needs_review' ? 'needs_review' : 'closed';
    return stateOf(shift, now) === 'stale' ? 'open_too_long' : 'open';
}
const COUNTED = new Set(['closed', 'corrected', 'open']);
/** One day's shifts with totals. Open counts "so far"; needs_review and open_too_long count nothing. */
export function summarizeShifts(shifts, now = Date.now()) {
    const list = [...(shifts || [])].filter(s => s && s.startedAt).sort((a, b) => ms(a.startedAt) - ms(b.startedAt)).map(s => ({ ...s, state: stateLabel(s, now), ...minutesOf(s, now) }));
    const t = { clockedMinutes: 0, breakMinutes: 0, needsReview: 0, open: 0, shifts: list.length };
    for (const s of list) {
        if (COUNTED.has(s.state)) { t.clockedMinutes += s.clockedMinutes; t.breakMinutes += s.breakMinutes; if (s.state === 'open') t.open++; }
        else t.needsReview++;
    }
    return { list, ...t };
}

export const DECLARED_TEXT = [
    'Declared shift time is what you clocked with Start, Break, Resume and End. Each press is a server timestamp on your own sign-in; nothing is backdated and nothing is guessed. Clocked time is end minus start minus breaks. Hub idle time is never deducted from a shift: a call is work the Hub cannot see.',
    'A shift left open for more than 12 hours is flagged for review and counts nothing until an owner sets its end time, with a note. A correction can only shorten a shift and is kept next to the original.',
    'Declared shift time, observed Hub activity and paid hours are three different numbers. Hubstaff remains the source for paid hours.',
    'The shift gate covers calls started from the Hub: off shift, the Hub does not show a prospect\u2019s number and its phone links do not open. A call dialled straight from a phone app is outside what the Hub can see or stop.',
];

/**
 * A copy of a response with every phone-number field emptied, for a caller off shift on a page that
 * renders numbers as links (the Founder pilot list, for one). Field names, not values, so nothing
 * that merely looks like a number is touched. Pure.
 */
export const PHONE_KEYS = new Set(['phone', 'mobilephone', 'mobilePhone', 'crmPhone', 'phoneNumber', 'directDial', 'alternates']);
export function withholdPhones(x) {
    return JSON.parse(JSON.stringify(x === undefined ? null : x, (k, v) => (PHONE_KEYS.has(k) && v ? (Array.isArray(v) ? [] : null) : v)));
}

// ---- store helpers ---------------------------------------------------------------------------
const parse = x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } };
/** The current shift doc, or null. Throws when the store cannot be read. */
export async function readCurrent(redis, email) { return (await redis.get(K.current(email))) || null; }
/** One logged shift by id, or null. Throws when the store cannot be read. */
export async function getLogged(redis, email, day, id) { return parse(await redis.hget(K.log(email, day), id)) || null; }
/**
 * The current shift, unless it is a ghost: a shift already written to the log as ended or archived
 * whose current slot was not cleared (the clear failed after the log write). A ghost is cleared here
 * and reads as no shift, so it can neither allow calls nor be ended twice.
 */
export async function liveCurrent(redis, email) {
    const cur = await readCurrent(redis, email);
    if (!cur || !cur.id || !cur.day) return cur;
    const logged = await getLogged(redis, email, cur.day, cur.id);
    if (logged && (logged.endedAt || logged.archivedAt)) { await redis.del(K.current(email)).catch(() => {}); return null; }
    return cur;
}
/** The shifts that started on an ET day, including the current one if it started that day. Throws on a read failure. */
export async function shiftsOn(redis, email, day, now = Date.now(), current) {
    const raw = (await redis.hgetall(K.log(email, day))) || {};
    const list = Object.values(raw).map(parse).filter(s => s && s.startedAt);
    const cur = current === undefined ? await readCurrent(redis, email) : current;
    if (cur && cur.day === day && !list.some(s => s.id === cur.id)) list.push(cur);
    return summarizeShifts(list, now);
}
/** Write one finished, archived or corrected shift under its id. Idempotent. */
export async function putLogged(redis, email, shift) {
    await redis.hset(K.log(email, shift.day), { [shift.id]: JSON.stringify(shift) });
    await redis.expire(K.log(email, shift.day), RETAIN_DAYS * 86400);
    await redis.sadd(K.days(email), shift.day);
}
