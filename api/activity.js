// Hub activity: heartbeats in, honest summaries out.
// ------------------------------------------------------------------
// POST /api/activity/  {action:'heartbeat', page}              one a minute from a visible, used tab
// POST /api/activity/  {action:'event', kind, page}            page_view / leave and the idle prompt's; business
//                                                               events are recorded by the handlers
//                                                               that perform them (recordActivity)
// GET  /api/activity/?me=1&from=YYYY-MM-DD&to=YYYY-MM-DD        my own week
// GET  /api/activity/?user=<email>&from&to                      one rep (owner / admin only)
// GET  /api/activity/?users=1&from&to                           every rep's week (owner / admin only)
// GET  /api/activity/?live=1                                    every caller right now (owner / admin only)
// GET  /api/activity/?sessions=1[&user=<email>]                 sign-in sessions still valid in the
//                                                               store, with when they were created
//                                                               (owner / admin only)
//
// Identity is the server's: the signed-in rep, never a name posted by the page. Session tokens are
// never returned. A rep reads only their own; owners and admins read everyone's.
import { redis, requireAccess, SESSION_TTL } from './_auth.js';
import { financeAccess } from './_finance-access.js';
import { K, norm, dayOf, minuteOf, sessionize, sessionsOn, summarizeDay, daysBetween, EVENT_KINDS, CLIENT_KINDS, PROMPT_KINDS, MEASURED_TEXT, RETAIN_DAYS, HEARTBEAT_MS, IDLE_CUTOFF_MS, SESSION_GAP_MS } from './_hub-activity.js';
import { shiftsOn, liveCurrent, stateOf, DECLARED_TEXT, MAX_OPEN_MS } from './_shift.js';
import { quoConfigured, listUsers, listCalls, findSeat, etDayBounds, callLive } from './_quo.js';
import { loginAliases } from './_login-aliases.js';
import { reportPeople } from './_daily-report-run.js';
import { signals, liveStatus, quietDay, QUIET_MS } from './_live-status.js';

const canReadOthers = rep => !!rep && (rep.role === 'admin' || financeAccess(rep));
const readBody = req => { try { return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch { return {}; } };
const validDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// Declared shift time rides alongside the observed activity for the same day, and is never
// mixed into it: a shift is what the rep clocked, activity is what the Hub saw.
async function dayView(email, day, current) {
    const [minutes, raw, doc, shift] = await Promise.all([
        redis.smembers(K.minutes(email, day)).catch(() => []),
        redis.lrange(K.events(email, day), 0, 499).catch(() => []),
        redis.get(K.sessions(email)).catch(() => null),
        shiftsOn(redis, email, day, Date.now(), current).catch(() => ({ list: [], clockedMinutes: 0, breakMinutes: 0, needsReview: 0, open: 0, shifts: 0, unavailable: true })),
    ]);
    const events = (raw || []).map(x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } }).filter(Boolean)
        .map(e => ({ ...e, label: EVENT_KINDS[e.kind] || e.kind }));
    // The events ride along, oldest first, so the page's drilldown reads them. They were counted
    // but never returned before, which left the drilldown saying "No events recorded" on days that had plenty.
    return { ...summarizeDay({ day, minutes: minutes || [], sessions: sessionsOn(doc, day), events }), events: [...events].sort((a, b) => String(a.at).localeCompare(String(b.at))), shift };
}

async function weekView(email, from, to) {
    // undefined when unreadable: each day then tries again and reports itself unavailable, never zero.
    const current = await liveCurrent(redis, email).catch(() => undefined);
    const days = [];
    for (const day of daysBetween(from, to)) days.push(await dayView(email, day, current));
    const totals = days.reduce((t, d) => ({ activeMinutes: t.activeMinutes + d.activeMinutes, elapsedMinutes: t.elapsedMinutes + d.elapsedMinutes, idleMinutes: t.idleMinutes + d.idleMinutes, meaningful: t.meaningful + d.meaningful, sessions: t.sessions + d.sessions, measuredDays: t.measuredDays + (d.measured ? 1 : 0),
        clockedMinutes: t.clockedMinutes + d.shift.clockedMinutes, breakMinutes: t.breakMinutes + d.shift.breakMinutes, shifts: t.shifts + d.shift.shifts, shiftsNeedingReview: t.shiftsNeedingReview + d.shift.needsReview, shiftsOpen: t.shiftsOpen + d.shift.open, shiftDaysUnavailable: t.shiftDaysUnavailable + (d.shift.unavailable ? 1 : 0) }),
        { activeMinutes: 0, elapsedMinutes: 0, idleMinutes: 0, meaningful: 0, sessions: 0, measuredDays: 0, clockedMinutes: 0, breakMinutes: 0, shifts: 0, shiftsNeedingReview: 0, shiftsOpen: 0, shiftDaysUnavailable: 0 });
    // A forgotten shift (open past twelve hours) that started outside this range; say so. A healthy
    // running shift outside the range is not news and is not mentioned.
    const openElsewhere = current && stateOf(current) === 'stale' && !days.some(d => d.day === current.day) ? { startedAt: current.startedAt, day: current.day, id: current.id } : null;
    return { email, from, to, days, totals, openShiftOutsideRange: openElsewhere };
}

/** Sign-in sessions still in the store. The key carries no timestamp, but its TTL is set once at
 *  creation and never refreshed, so created = now - (SESSION_TTL - ttl). Genuine, for sessions
 *  that have not expired; anything older than thirty days is gone and is reported as unavailable. */
async function liveSessions(filterEmail) {
    const out = [];
    let cursor = '0', guard = 0;
    do {
        const r = await redis.scan(cursor, { match: 'sess:*', count: 200 });
        cursor = String(r[0]); const keys = r[1] || [];
        for (const k of keys) {
            const [email, ttl] = await Promise.all([redis.get(k).catch(() => null), redis.ttl(k).catch(() => -1)]);
            if (!email) continue;
            if (filterEmail && norm(email) !== filterEmail) continue;
            const createdAt = ttl > 0 ? new Date(Date.now() - (SESSION_TTL - ttl) * 1000).toISOString() : null;
            out.push({ email: norm(email), createdAt, expiresAt: ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null });
        }
    } while (cursor !== '0' && ++guard < 50);
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Right now, for every caller: working, on a call, quiet for N minutes, on break or off shift, and
 * today's quiet stretches on shift. Quo is read once a minute per caller at most (cached), so a page
 * left open polling does not hammer it. A Quo read that fails says so; quiet is then unknown, never a figure.
 */
async function quoToday(email, day) {
    const key = 'staffify:live-quo:' + email;
    const held = await redis.get(key).catch(() => null);
    if (held && held.day === day && Date.now() - Date.parse(held.readAt) < 60000) return held;
    let out;
    if (!quoConfigured()) out = { quo: 'not connected', calls: [] };
    else {
        try {
            const seat = findSeat(await listUsers(), loginAliases(email));
            if (!seat) out = { quo: 'no seat', calls: [] };
            else {
                const b = etDayBounds(day);
                // Both directions: dials, and calls this person answered (a prospect calling back is work too).
                const { items } = await listCalls({ actorId: seat.actorId, from: b.from, to: b.to });
                const mine = (items || []).filter(c => (c.direction === 'outgoing' && (!c.initiatedBy || c.initiatedBy === seat.actorId)) || (c.direction === 'incoming' && c.answeredBy === seat.actorId));
                out = { quo: 'read', calls: mine.map(c => ({ at: c.createdAt, seconds: Number(c.duration) || 0, inProgress: callLive(c), direction: c.direction })) };
            }
        } catch { out = { quo: 'unavailable', calls: [] }; }
    }
    out = { ...out, day, readAt: new Date().toISOString() };
    if (out.quo === 'read') await redis.set(key, out, { ex: 120 }).catch(() => {});
    return out;
}
async function liveFor(person, now) {
    const email = norm(person.email), day = dayOf(now);
    const current = await liveCurrent(redis, email).catch(() => undefined);
    // A shift started before midnight Eastern: its first day's minutes and calls count too.
    const earlier = current && current.day && current.day < day ? current.day : null;
    const [minutes, raw, shift, q, minutesBefore, qBefore] = await Promise.all([
        redis.smembers(K.minutes(email, day)).catch(() => null),
        redis.lrange(K.events(email, day), 0, 499).catch(() => null),
        shiftsOn(redis, email, day, now, current).catch(() => null),
        quoToday(email, day),
        earlier ? redis.smembers(K.minutes(email, earlier)).catch(() => []) : [],
        earlier ? quoToday(email, earlier) : { quo: 'read', calls: [] },
    ]);
    const events = (raw || []).map(x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } }).filter(Boolean);
    const unreadable = current === undefined || minutes === null || raw === null || shift === null;
    const sig = [...signals({ day, minutes: minutes || [], calls: q.calls, now }), ...(earlier ? signals({ day: earlier, minutes: minutesBefore || [], calls: qBefore.calls, now }) : [])].sort((a, b) => a[0] - b[0]);
    const state = current === undefined ? 'unknown' : stateOf(current, now);
    const quoRead = q.quo === 'read' && (!earlier || qBefore.quo === 'read');
    let status = unreadable ? { key: 'unknown', label: 'Unknown', detail: 'The shift or Hub activity could not be read just now.' }
        : liveStatus({ state, current, sig, events, callInProgress: q.calls.some(c => c.inProgress) || (earlier ? qBefore.calls.some(c => c.inProgress) : false), quo: q.quo, now });
    // Quo unread: no calls can be seen, so a quiet Hub is not proof of a quiet caller. Say what is known.
    if (!quoRead && status.key === 'quiet') status = { ...status, key: 'unseen', label: 'No Hub activity for ' + status.quietMinutes + ' min', detail: q.quo === 'no seat' ? 'No Quo seat for this login, so calls cannot be seen.' : 'Quo could not be read, so a call may be going on.', prompt: status.prompt };
    const hubMinutes = (minutes || []).map(Number).filter(Number.isFinite);
    const lastCall = q.calls.map(c => c.at).filter(Boolean).sort().slice(-1)[0] || null;
    const lastEvent = events.filter(e => e.kind && !e.kind.startsWith('idle_prompt') && e.kind !== 'leave').map(e => e.at).sort().slice(-1)[0] || null;
    const hubRead = minutes !== null && raw !== null;
    return {
        email, name: person.name || email, status, hubRead,
        lastHubAt: !hubRead ? null : hubMinutes.length ? new Date(Math.max(...hubMinutes.map(m => signals({ day, minutes: [m] })[0][1]))).toISOString() : lastEvent,
        lastCallAt: lastCall, quo: q.quo, quoReadAt: q.readAt,
        // Today's quiet needs all three sources; without Quo it is unknown, never a figure.
        today: unreadable || !quoRead ? null : { day, ...quietDay({ day, minutes: minutes || [], calls: q.calls, shiftList: shift.list, events, now }) },
    };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    const rep = await requireAccess(req);
    if (!rep) return res.status(401).json({ error: 'Sign in to your Staffify account' });
    const me = norm(rep.email);
    const q = req.query || {};

    if (req.method === 'GET' && q.live) {
        if (!canReadOthers(rep)) return res.status(403).json({ error: 'Owners only' });
        const now = Date.now();
        try {
            const people = await reportPeople();
            const out = [];
            for (const p of people) out.push(await liveFor(p, now));
            return res.status(200).json({ generatedAt: new Date(now).toISOString(), quietAfterMinutes: QUIET_MS / 60000, people: out,
                note: 'Working means a Hub click, key or scroll, or a Quo call, in the last 10 minutes of a running shift. A call from the phone\u2019s own dialer is not visible here. Observed, never payroll: Hubstaff is the source for paid hours.' });
        } catch (e) { return res.status(503).json({ error: 'Live status could not be read: ' + String((e && e.message) || e).slice(0, 120) }); }
    }

    if (req.method === 'POST') {
        if (me === 'admin') return res.status(403).json({ error: 'An admin token is not a person; nothing is recorded for it.' });
        const b = readBody(req);
        const page = String(b.page || '').slice(0, 120) || null;
        const now = Date.now(), day = dayOf(now);
        try {
            if (b.action === 'heartbeat') {
                await redis.sadd(K.minutes(me, day), minuteOf(now));
                await redis.expire(K.minutes(me, day), RETAIN_DAYS * 86400);
                await redis.sadd(K.days(me), day);
                const doc = await redis.get(K.sessions(me)).catch(() => null);
                const s = sessionize(doc, now, { kind: 'heartbeat', page });
                await redis.set(K.sessions(me), s.doc);
                return res.status(200).json({ ok: true, sessionStarted: s.started, minute: minuteOf(now), day });
            }
            if (b.action === 'event') {
                const kind = String(b.kind || '');
                if (!CLIENT_KINDS.has(kind)) return res.status(400).json({ error: 'That event is not accepted from the browser.' });
                await redis.lpush(K.events(me, day), JSON.stringify({ at: new Date(now).toISOString(), kind, page, detail: null }));
                await redis.ltrim(K.events(me, day), 0, 499);
                await redis.expire(K.events(me, day), RETAIN_DAYS * 86400);
                await redis.sadd(K.days(me), day);
                // Being prompted is not presence: no minute, no session.
                if (PROMPT_KINDS.has(kind)) return res.status(200).json({ ok: true });
                const doc = await redis.get(K.sessions(me)).catch(() => null);
                const s = sessionize(doc, now, { kind: kind === 'leave' ? 'leave' : 'heartbeat', page });
                await redis.set(K.sessions(me), s.doc);
                if (kind === 'page_view') { await redis.sadd(K.minutes(me, day), minuteOf(now)); await redis.expire(K.minutes(me, day), RETAIN_DAYS * 86400); }
                return res.status(200).json({ ok: true, ended: s.ended });
            }
            return res.status(400).json({ error: 'Unknown action' });
        } catch (e) {
            return res.status(503).json({ error: 'Not recorded: ' + String((e && e.message) || e).slice(0, 120) });
        }
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const today = dayOf();
    const from = validDay(q.from) ? q.from : daysBetween(new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10), today)[0];
    const to = validDay(q.to) ? q.to : today;
    if (daysBetween(from, to).length === 0 || daysBetween(from, to).length > 31) return res.status(400).json({ error: 'from must be on or before to, within 31 days' });
    const definitions = { heartbeatMs: HEARTBEAT_MS, idleCutoffMs: IDLE_CUTOFF_MS, sessionGapMs: SESSION_GAP_MS, retainDays: RETAIN_DAYS, measured: MEASURED_TEXT, declared: DECLARED_TEXT, maxOpenMs: MAX_OPEN_MS, timezone: 'America/New_York' };

    try {
        if (q.me) {
            if (me === 'admin') return res.status(400).json({ error: 'An admin token has no activity of its own. Use ?user=.' });
            return res.status(200).json({ ...(await weekView(me, from, to)), definitions });
        }
        if (q.sessions) {
            if (!canReadOthers(rep)) return res.status(403).json({ error: 'Owners and admins only' });
            const filter = q.user ? norm(q.user) : null;
            return res.status(200).json({ sessions: await liveSessions(filter), note: 'Only sessions still valid in the store (30-day life). Created time is derived from the remaining life; older sign-ins are not retained and are unavailable, not zero.', definitions });
        }
        if (q.user) {
            const target = norm(q.user);
            if (target !== me && !canReadOthers(rep)) return res.status(403).json({ error: 'You can read your own activity only' });
            return res.status(200).json({ ...(await weekView(target, from, to)), definitions });
        }
        if (q.users) {
            if (!canReadOthers(rep)) return res.status(403).json({ error: 'Owners and admins only' });
            const emails = (await redis.smembers('reps').catch(() => [])) || [];
            const users = [];
            for (const e of emails.map(norm).sort()) { const w = await weekView(e, from, to); users.push({ email: e, totals: w.totals, openShiftOutsideRange: w.openShiftOutsideRange, days: w.days.map(d => ({ day: d.day, measured: d.measured, activeMinutes: d.activeMinutes, elapsedMinutes: d.elapsedMinutes, idleMinutes: d.idleMinutes, meaningful: d.meaningful, clockedMinutes: d.shift.clockedMinutes, shiftsNeedingReview: d.shift.needsReview, shiftsOpen: d.shift.open })) }); }
            return res.status(200).json({ from, to, users, definitions });
        }
        return res.status(400).json({ error: 'Ask for ?me=1, ?user=<email>, ?users=1 or ?sessions=1' });
    } catch (e) {
        return res.status(503).json({ error: 'Activity could not be read: ' + String((e && e.message) || e).slice(0, 120) });
    }
}
