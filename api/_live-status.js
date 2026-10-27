// Is a caller working right now, and when were they not.
// ------------------------------------------------------------------
// Paul, 2026-10-27: "I need to know if Milton is active and working, and when he is not."
//
// Pure. The readers are api/activity.js (?live=1, right now) and the Caller review (by day). Three
// sources, none standing in for another:
//   shift     what the caller declared: Start, Break, Resume, End (api/_shift.js). Only time on a
//             running shift can be "quiet": a break or no shift is the caller's own declaration.
//   Hub       active minutes (a visible Hub tab with a click, key or scroll in the last five
//             minutes; api/_hub-activity.js).
//   Quo       calls placed through the caller's own Quo user, each counted from when it was placed
//             to when it ended (at least a minute), so a long call is never quiet.
// Quiet means 10 minutes or more on a running shift with none of these. It is an observation, not
// a judgement: a call from the phone's own dialer is invisible here. It is never deducted from the
// shift and never payroll (Paul, 2026-10-24).
import { minuteOf, dayOf } from './_hub-activity.js';

export const QUIET_MS = 10 * 60000;
const MIN = 60000;
const ms = s => { const n = Date.parse(s || ''); return Number.isFinite(n) ? n : null; };
const COUNTED = new Set(['closed', 'corrected', 'open']);

/** The instant an ET minute-of-day (0 to 1439) began on a given ET day, correct across daylight time. */
export function minuteInstant(day, m) {
    let start = null;
    for (const off of [4, 5]) { const t = Date.parse(day + 'T00:00:00Z') + off * 3600e3; if (dayOf(t) === day && dayOf(t - 1) !== day) { start = t; break; } }
    if (start === null) start = Date.parse(day + 'T05:00:00Z');
    const base = start + m * MIN;
    for (const adj of [0, -3600e3, 3600e3]) if (minuteOf(base + adj) === m && dayOf(base + adj) === day) return base + adj;
    return base;
}

/** Signs of work as [from, to] instants: each active Hub minute, and each Quo call from placed to ended. */
export function signals({ day, minutes = [], calls = [], now = Date.now() }) {
    const out = [];
    for (const m of new Set((minutes || []).map(Number).filter(Number.isFinite))) { const t = minuteInstant(day, m); out.push([t, t + MIN]); }
    for (const c of calls || []) {
        const at = ms(c.at); if (at === null) continue;
        const end = c.inProgress ? now : at + Math.max(MIN, (Number(c.seconds) || 0) * 1000);
        out.push([at, end]);
    }
    return out.sort((a, b) => a[0] - b[0]);
}

/** Time on a running shift: each counted shift from start to end (or now), less its breaks. */
export function shiftWindows(list, now = Date.now()) {
    const out = [];
    for (const s of list || []) {
        if (!s || !s.startedAt || (s.state && !COUNTED.has(s.state))) continue;
        const start = ms(s.startedAt);
        const end = Math.min(ms(s.correctedEndedAt) ?? ms(s.endedAt) ?? now, now);
        if (start === null || !(end > start)) continue;
        let cur = start;
        const breaks = (s.breaks || []).filter(b => b && b.startedAt).map(b => [ms(b.startedAt), ms(b.endedAt) ?? end]).sort((a, b) => a[0] - b[0]);
        for (const [bs, be] of breaks) { if (bs > cur) out.push([cur, Math.min(bs, end)]); cur = Math.max(cur, be); }
        if (end > cur) out.push([cur, end]);
    }
    return out.filter(([a, b]) => b > a);
}

const PROMPT_ANSWER = { idle_prompt_next: 'Went to the next call', idle_prompt_on_call: 'Said they were on a call', idle_prompt_break: 'Took a break' };

/** Every stretch of QUIET_MS or more on a running shift with no sign of work, and any idle prompt in it. */
export function quietStretches({ windows, signals: sig, events = [], now = Date.now(), minMs = QUIET_MS }) {
    const out = [];
    const prompts = (events || []).filter(e => e && e.at && e.kind && e.kind.startsWith('idle_prompt')).map(e => ({ at: ms(e.at), kind: e.kind })).filter(e => e.at !== null).sort((a, b) => a.at - b.at);
    const gap = (from, to, open) => {
        const shown = prompts.find(p => p.kind === 'idle_prompt' && p.at >= from && p.at <= to + MIN);
        const answer = shown ? prompts.find(p => p.kind !== 'idle_prompt' && p.at >= shown.at && p.at <= to + 5 * MIN) : null;
        return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), minutes: Math.floor((to - from) / MIN), open, prompted: !!shown, promptedAt: shown ? new Date(shown.at).toISOString() : null, answer: answer ? PROMPT_ANSWER[answer.kind] : shown ? 'No answer' : null };
    };
    for (const [ws, we] of windows || []) {
        let cursor = ws;
        for (const [a, b] of (sig || []).filter(([a, b]) => b > ws && a < we)) {
            if (a - cursor >= minMs) out.push(gap(cursor, a, false));
            cursor = Math.max(cursor, b);
        }
        if (we - cursor >= minMs) out.push(gap(cursor, we, we >= now - MIN));
    }
    return out;
}

/**
 * Right now, for one caller. `state` is the shift's ('off', 'on', 'break', 'stale'); `current` the
 * running shift; `sig` from signals(); `quo` says whether Quo could be read.
 */
export function liveStatus({ state, current, sig = [], events = [], callInProgress = false, quo = 'read', now = Date.now() }) {
    const lastWork = Math.max(0, ...sig.map(s => s[1]));
    const base = { lastWorkAt: lastWork ? new Date(Math.min(lastWork, now)).toISOString() : null, quo };
    if (state === 'off' || !current) return { ...base, key: 'off', label: 'Off shift' };
    if (state === 'stale') return { ...base, key: 'stale', label: 'Shift left open', detail: 'Started over 12 hours ago and never ended.' };
    const breaks = current.breaks || [];
    const open = breaks.slice(-1)[0];
    if (state === 'break') return { ...base, key: 'break', label: 'On break', since: open ? open.startedAt : null };
    if (callInProgress) return { ...base, key: 'call', label: 'On a call', since: null };
    const onSince = Math.max(ms(current.startedAt) || 0, ...breaks.filter(b => b.endedAt).map(b => ms(b.endedAt) || 0));
    const last = Math.max(onSince, Math.min(lastWork, now));
    const quiet = Math.max(0, now - last);
    const prompts = (events || []).filter(e => e && e.kind && e.kind.startsWith('idle_prompt') && ms(e.at) >= last).sort((a, b) => ms(a.at) - ms(b.at));
    const shown = prompts.filter(p => p.kind === 'idle_prompt').slice(-1)[0];
    const answered = shown && prompts.some(p => p.kind !== 'idle_prompt' && ms(p.at) >= ms(shown.at));
    if (quiet < QUIET_MS) return { ...base, key: 'working', label: 'Working', since: new Date(last).toISOString(), quietMinutes: Math.floor(quiet / MIN) };
    return { ...base, key: 'quiet', label: 'Quiet for ' + Math.floor(quiet / MIN) + ' min', since: new Date(last).toISOString(), quietMinutes: Math.floor(quiet / MIN),
        prompt: shown ? { at: shown.at, answered: !!answered } : null };
}

/** One caller's day: time on shift, quiet stretches, and the total quiet. */
export function quietDay({ day, minutes, calls, shiftList, events, now = Date.now() }) {
    const sig = signals({ day, minutes, calls, now });
    const windows = shiftWindows(shiftList, now);
    const stretches = quietStretches({ windows, signals: sig, events, now });
    return { onShiftMinutes: Math.floor(windows.reduce((n, [a, b]) => n + (b - a), 0) / MIN), quietMinutes: stretches.reduce((n, s) => n + s.minutes, 0), stretches };
}
