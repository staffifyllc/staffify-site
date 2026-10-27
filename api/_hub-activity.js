// What a rep did in the Hub, measured honestly.
// ------------------------------------------------------------------
// Paul, 2026-10-23 (through Codex): "transparent in-Hub activity measurement ... separate observed
// active Hub time, idle time and elapsed session time, and label active time an estimate that
// misses phone calls / off-platform work. This is not payroll or proof of total work; Hubstaff
// remains the paid-hours source."
//
// Definitions, in one place so the page, the API and the tests agree:
//   active minute   a minute (ET) in which at least one heartbeat arrived. The browser sends one
//                   heartbeat a minute, only while the tab is visible and the person interacted
//                   (pointer, key, scroll, touch) within IDLE_CUTOFF_MS. Two tabs or two devices in
//                   the same minute count once: minutes are a set per person per day.
//   session         starts at the first heartbeat after a gap of SESSION_GAP_MS or more, and its
//                   lastSeen is the latest heartbeat or event. A session ends when the browser says
//                   so (leave) or when the next heartbeat arrives after the gap (timeout, ended at
//                   the last thing seen, not at the moment we noticed).
//   elapsed         session lastSeen minus start, summed over the day's sessions.
//   idle            elapsed minus active, never below zero. Time in the Hub with no interaction.
//   events          business actions recorded server-side by the handlers that performed them
//                   (a call outcome, a note saved, a task added or done, a text or overview sent)
//                   plus page views and leaves from the browser. Never keystrokes, never note text.
//
// Nothing here is retroactive: a day with no data reads "not measured", not zero.
export const HEARTBEAT_MS = 60000;
export const IDLE_CUTOFF_MS = 5 * 60000;
export const SESSION_GAP_MS = 30 * 60000;
export const RETAIN_DAYS = 120;
export const EVENT_KINDS = Object.freeze({
    page_view: 'Opened a page', leave: 'Left the Hub', call_outcome: 'Logged a call', note_saved: 'Saved call notes',
    task_added: 'Added a task', task_done: 'Completed a task', callback_set: 'Scheduled a callback', suppress: 'Excluded a prospect',
    text_sent: 'Sent a text', overview_sent: 'Sent the overview', instagram_flag: 'Flagged a datapoint',
    shift_start: 'Started a shift', shift_break: 'Took a break', shift_resume: 'Resumed the shift', shift_end: 'Ended the shift', shift_flagged: 'Shift flagged for review', shift_corrected: 'Shift end corrected by an owner',
    // The idle prompt (assets/js/hub-nudge.js): shown after 10 quiet minutes on a running shift, and the answer.
    idle_prompt: 'Prompted after 10 quiet minutes on shift', idle_prompt_next: 'Went to the next call from the prompt',
    idle_prompt_on_call: 'Answered the prompt: on a call', idle_prompt_break: 'Took a break from the prompt',
});
// The prompt's events record that it appeared and what was chosen. They are not presence: being
// prompted is the opposite of activity, so they never count a minute or extend a session.
export const PROMPT_KINDS = new Set(['idle_prompt', 'idle_prompt_next', 'idle_prompt_on_call', 'idle_prompt_break']);
export const CLIENT_KINDS = new Set(['page_view', 'leave', ...PROMPT_KINDS]);
export const MEANINGFUL = new Set(['call_outcome', 'note_saved', 'task_added', 'task_done', 'callback_set', 'suppress', 'text_sent', 'overview_sent', 'instagram_flag']);

const ET = 'America/New_York';
export const dayOf = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
export function minuteOf(t = Date.now()) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(t));
    const get = k => Number((p.find(x => x.type === k) || {}).value || 0);
    return (get('hour') % 24) * 60 + get('minute');
}
export const norm = e => String(e || '').trim().toLowerCase();
export const K = {
    minutes: (email, day) => `act:min:${norm(email)}:${day}`,
    events: (email, day) => `act:ev:${norm(email)}:${day}`,
    sessions: email => `act:sess:${norm(email)}`,
    days: email => `act:days:${norm(email)}`,
};

/** Advance the session document with a signal at `now`. Pure. */
export function sessionize(doc, now, { kind = 'heartbeat', page = null } = {}) {
    const d = doc && typeof doc === 'object' ? { current: doc.current || null, recent: Array.isArray(doc.recent) ? doc.recent : [] } : { current: null, recent: [] };
    const cur = d.current;
    const close = (s, endedAt, reason) => { d.recent = [{ ...s, endedAt, reason }, ...d.recent].slice(0, 60); d.current = null; };
    if (cur && now - Date.parse(cur.lastSeen) >= SESSION_GAP_MS) close(cur, cur.lastSeen, 'timeout');
    if (kind === 'leave') {
        if (d.current) { d.current.lastSeen = new Date(now).toISOString(); close(d.current, d.current.lastSeen, 'left'); }
        return { doc: d, started: false, ended: true };
    }
    // A tab that was hidden or closed sends a leave; with two tabs open, the other one carries on.
    // A signal inside the gap after a leave resumes that session instead of starting a new one, so
    // elapsed time is not cut into pieces by switching tabs.
    const last = d.recent[0];
    if (!d.current && last && last.reason === 'left' && now - Date.parse(last.lastSeen) < SESSION_GAP_MS) {
        d.recent = d.recent.slice(1);
        const { endedAt, reason, ...resumed } = last;
        d.current = { ...resumed, lastSeen: new Date(now).toISOString() };
        return { doc: d, started: false, ended: false, resumed: true };
    }
    if (!d.current) { d.current = { start: new Date(now).toISOString(), lastSeen: new Date(now).toISOString(), firstPage: page || null }; return { doc: d, started: true, ended: false }; }
    d.current.lastSeen = new Date(now).toISOString();
    return { doc: d, started: false, ended: false };
}

/** Sessions that touch a given ET day, clipped to it. */
export function sessionsOn(doc, day) {
    const all = [...(doc && doc.recent ? doc.recent : []), ...(doc && doc.current ? [{ ...doc.current, open: true }] : [])];
    return all.filter(s => s && s.start && (dayOf(Date.parse(s.start)) === day || dayOf(Date.parse(s.lastSeen || s.start)) === day))
        .map(s => ({ start: s.start, lastSeen: s.lastSeen || s.start, endedAt: s.endedAt || null, reason: s.open ? 'open' : s.reason || 'timeout', firstPage: s.firstPage || null }))
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** One day for one person. Pure. */
export function summarizeDay({ day, minutes = [], sessions = [], events = [] }) {
    const active = new Set(minutes.map(Number).filter(n => Number.isFinite(n))).size;
    const elapsed = sessions.reduce((a, s) => a + Math.max(0, Math.round((Date.parse(s.lastSeen) - Date.parse(s.start)) / 60000)), 0);
    const counts = {};
    for (const e of events) if (e && e.kind) counts[e.kind] = (counts[e.kind] || 0) + 1;
    const meaningful = events.filter(e => e && MEANINGFUL.has(e.kind));
    const sorted = [...events].filter(e => e && e.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const measured = minutes.length > 0 || sessions.length > 0 || events.length > 0;
    return { day, measured, activeMinutes: active, elapsedMinutes: elapsed, idleMinutes: Math.max(0, elapsed - active),
        sessions: sessions.length, sessionList: sessions, counts, meaningful: meaningful.length,
        firstSeen: sorted.length ? sorted[0].at : (sessions[0] ? sessions[0].start : null),
        lastSeen: sorted.length ? sorted[sorted.length - 1].at : (sessions.length ? sessions[sessions.length - 1].lastSeen : null) };
}

/** The ET days from `from` to `to` inclusive (YYYY-MM-DD strings). */
export function daysBetween(from, to) {
    const out = []; let t = Date.parse(from + 'T12:00:00Z'); const end = Date.parse(to + 'T12:00:00Z');
    while (t <= end && out.length < 62) { out.push(new Date(t).toISOString().slice(0, 10)); t += 86400000; }
    return out;
}

/** What the page tells a rep is measured. One source for the UI and the docs. */
export const MEASURED_TEXT = [
    'Active Hub time is an estimate. A minute counts as active when a Hub tab was visible and you interacted with it (click, key, scroll, touch) within the last five minutes. Two tabs or two devices in the same minute count once.',
    'Idle time is time in a session with no interaction. Elapsed time is from the first sign of a session to the last; a session ends after thirty quiet minutes. Closing or hiding a tab ends it only if nothing follows within those thirty minutes, so switching tabs does not cut it up.',
    'Recorded actions are the ones the Hub itself performed for you: a call outcome, notes saved, a task added or done, a callback scheduled, a text or overview sent, a page opened. The content of notes is never recorded. Nothing outside the Hub is seen: phone calls, email, other sites.',
    'This is not payroll and not proof of total work. Hubstaff remains the source for paid hours.',
];

/**
 * Record a business event for a rep, from the handler that did the thing. Never throws, never
 * blocks the caller: a failed write loses one line of history, not the action.
 */
export async function recordActivity(redis, { email, kind, page = null, detail = null, at = Date.now(), presence = true }) {
    const e = norm(email);
    if (!e || e === 'admin' || !EVENT_KINDS[kind]) return false;
    const day = dayOf(at);
    try {
        await redis.lpush(K.events(e, day), JSON.stringify({ at: new Date(at).toISOString(), kind, page, detail: detail ? String(detail).slice(0, 160) : null }));
        await redis.ltrim(K.events(e, day), 0, 499);
        await redis.expire(K.events(e, day), RETAIN_DAYS * 86400);
        await redis.sadd(K.days(e), day);
        // A business action is also a sign of presence: it counts the minute and keeps the session alive.
        // Not when someone else did it on this person's record (an owner's correction).
        if (!presence) return true;
        await redis.sadd(K.minutes(e, day), minuteOf(at));
        await redis.expire(K.minutes(e, day), RETAIN_DAYS * 86400);
        const doc = await redis.get(K.sessions(e)).catch(() => null);
        await redis.set(K.sessions(e), sessionize(doc, at, { kind: 'heartbeat', page }).doc);
        return true;
    } catch { return false; }
}
