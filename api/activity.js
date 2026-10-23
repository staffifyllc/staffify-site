// Hub activity: heartbeats in, honest summaries out.
// ------------------------------------------------------------------
// POST /api/activity/  {action:'heartbeat', page}              one a minute from a visible, used tab
// POST /api/activity/  {action:'event', kind, page}            page_view / leave only; business
//                                                               events are recorded by the handlers
//                                                               that perform them (recordActivity)
// GET  /api/activity/?me=1&from=YYYY-MM-DD&to=YYYY-MM-DD        my own week
// GET  /api/activity/?user=<email>&from&to                      one rep (owner / admin only)
// GET  /api/activity/?users=1&from&to                           every rep's week (owner / admin only)
// GET  /api/activity/?sessions=1[&user=<email>]                 sign-in sessions still valid in the
//                                                               store, with when they were created
//                                                               (owner / admin only)
//
// Identity is the server's: the signed-in rep, never a name posted by the page. Session tokens are
// never returned. A rep reads only their own; owners and admins read everyone's.
import { redis, requireAccess, SESSION_TTL } from './_auth.js';
import { financeAccess } from './_finance-access.js';
import { K, norm, dayOf, minuteOf, sessionize, sessionsOn, summarizeDay, daysBetween, EVENT_KINDS, CLIENT_KINDS, MEASURED_TEXT, RETAIN_DAYS, HEARTBEAT_MS, IDLE_CUTOFF_MS, SESSION_GAP_MS } from './_hub-activity.js';

const canReadOthers = rep => !!rep && (rep.role === 'admin' || financeAccess(rep));
const readBody = req => { try { return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch { return {}; } };
const validDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

async function dayView(email, day) {
    const [minutes, raw, doc] = await Promise.all([
        redis.smembers(K.minutes(email, day)).catch(() => []),
        redis.lrange(K.events(email, day), 0, 499).catch(() => []),
        redis.get(K.sessions(email)).catch(() => null),
    ]);
    const events = (raw || []).map(x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } }).filter(Boolean)
        .map(e => ({ ...e, label: EVENT_KINDS[e.kind] || e.kind }));
    return summarizeDay({ day, minutes: minutes || [], sessions: sessionsOn(doc, day), events });
}

async function weekView(email, from, to) {
    const days = [];
    for (const day of daysBetween(from, to)) days.push(await dayView(email, day));
    const totals = days.reduce((t, d) => ({ activeMinutes: t.activeMinutes + d.activeMinutes, elapsedMinutes: t.elapsedMinutes + d.elapsedMinutes, idleMinutes: t.idleMinutes + d.idleMinutes, meaningful: t.meaningful + d.meaningful, sessions: t.sessions + d.sessions, measuredDays: t.measuredDays + (d.measured ? 1 : 0) }), { activeMinutes: 0, elapsedMinutes: 0, idleMinutes: 0, meaningful: 0, sessions: 0, measuredDays: 0 });
    return { email, from, to, days, totals };
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

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    const rep = await requireAccess(req);
    if (!rep) return res.status(401).json({ error: 'Sign in to your Staffify account' });
    const me = norm(rep.email);
    const q = req.query || {};

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
                if (!CLIENT_KINDS.has(kind)) return res.status(400).json({ error: 'Only page_view and leave are accepted from the browser' });
                await redis.lpush(K.events(me, day), JSON.stringify({ at: new Date(now).toISOString(), kind, page, detail: null }));
                await redis.ltrim(K.events(me, day), 0, 499);
                await redis.expire(K.events(me, day), RETAIN_DAYS * 86400);
                await redis.sadd(K.days(me), day);
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
    const definitions = { heartbeatMs: HEARTBEAT_MS, idleCutoffMs: IDLE_CUTOFF_MS, sessionGapMs: SESSION_GAP_MS, retainDays: RETAIN_DAYS, measured: MEASURED_TEXT, timezone: 'America/New_York' };

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
            for (const e of emails.map(norm).sort()) { const w = await weekView(e, from, to); users.push({ email: e, totals: w.totals, days: w.days.map(d => ({ day: d.day, measured: d.measured, activeMinutes: d.activeMinutes, elapsedMinutes: d.elapsedMinutes, idleMinutes: d.idleMinutes, meaningful: d.meaningful })) }); }
            return res.status(200).json({ from, to, users, definitions });
        }
        return res.status(400).json({ error: 'Ask for ?me=1, ?user=<email>, ?users=1 or ?sessions=1' });
    } catch (e) {
        return res.status(503).json({ error: 'Activity could not be read: ' + String((e && e.message) || e).slice(0, 120) });
    }
}
