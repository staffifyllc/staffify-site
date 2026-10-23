// How many calls a rep actually made, from Quo.
// ------------------------------------------------------------------
// Paul, 2026-10-21: "can we tap into Quo's API to see how many calls Milton makes".
//
// Quo is the renamed OpenPhone, so the key we already hold works. What did not work is the route
// the rest of the code uses: legacy GET /v1/calls requires a phoneNumberId AND a single
// participant, one conversation at a time, so it can never total a person's day. This uses the
// 2026-03-30 GET /calls with actorId and a createdAt range. See api/_quo.js.
//
// GET /api/quo-activity/                  -> today in ET, for whoever is signed in
// GET /api/quo-activity/?days=7           -> the last 7 ET days
// GET /api/quo-activity/?from=&to=        -> an explicit ET date range
// GET /api/quo-activity/?rep=<email>      -> somebody else (Paul and Madison only)
// GET /api/quo-activity/?team=1           -> every seat (Paul and Madison only)
// GET /api/quo-activity/?seats=1          -> who has a Quo seat at all (Paul and Madison only)
//
// This is read-only. It places no calls and changes nothing in Quo.
import { requireAccess, redis } from './_auth.js';
import { financeAccess } from './_finance-access.js';
import { loginAliases } from './_caller-plan.js';
import { quoConfigured, listUsers, listCalls, findSeat, tally, etDay, etDayBounds } from './_quo.js';

const DAY = 86400000;
const todayET = () => etDay(new Date());
const shiftET = (day, back) => etDay(new Date(Date.parse(day + 'T12:00:00Z') - back * DAY));
const isDay = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

/** The ET window to report on, from the query, bounded so one request cannot sweep a year. */
function windowFrom(query) {
    const to = isDay(query.to) ? query.to : todayET();
    if (isDay(query.from)) {
        const from = query.from > to ? to : query.from;
        // 31 days is the ceiling: beyond that this is a reporting job, not a page load.
        const earliest = shiftET(to, 30);
        return { from: from < earliest ? earliest : from, to, clamped: from < earliest };
    }
    const days = Math.max(1, Math.min(31, Number(query.days) || 1));
    return { from: shiftET(to, days - 1), to, clamped: false };
}

async function activityFor({ seat, from, to }) {
    const bounds = { from: etDayBounds(from).from, to: etDayBounds(to).to };
    const { items, complete } = await listCalls({ actorId: seat.actorId, from: bounds.from, to: bounds.to });
    // Quo's range is in UTC instants; the window the rep means is in ET calendar days, so the edges
    // are trimmed here rather than left a few hours wide.
    const inWindow = items.filter(c => { const d = etDay(c.createdAt); return d && d >= from && d <= to; });
    return {
        rep: { name: seat.name, email: seat.email, actorId: seat.actorId, matchedOn: seat.matchedOn },
        ...tally(inWindow, { actorId: seat.actorId }),
        truncated: !complete,
    };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const rep = await requireAccess(req).catch(() => null);
    if (!rep || !rep.email) return res.status(401).json({ error: 'Sign in to your Staffify account' });
    if (!quoConfigured()) return res.status(503).json({ error: 'No Quo API key is set on this project (QUO_API_KEY or OPENPHONE_API_KEY)' });

    // Call counts are performance data. A rep reads their own; Paul and Madison read anyone's.
    const canSeeEveryone = rep.role === 'admin' || financeAccess(rep);
    const q = req.query || {};
    const { from, to, clamped } = windowFrom(q);

    const cacheKey = 'staffify:quo-activity:' + [rep.email, from, to, q.team ? 'team' : '', q.rep || '', q.seats ? 'seats' : ''].join('|');
    if (!q.fresh) {
        const held = await redis.get(cacheKey).catch(() => null);
        if (held && held.builtAt && Date.now() - Date.parse(held.builtAt) < 60000) return res.status(200).json({ ...held, cached: true });
    }
    const send = async (code, body) => { if (code === 200) await redis.set(cacheKey, { ...body, builtAt: new Date().toISOString() }, { ex: 300 }).catch(() => {}); return res.status(code).json(body); };
    try {
        const users = await listUsers();

        if (q.seats) {
            if (!canSeeEveryone) return res.status(403).json({ error: 'Seat list is private' });
            return res.status(200).json({ seats: users, count: users.length });
        }

        // Who is being asked about.
        let wanted;
        if (q.team) {
            if (!canSeeEveryone) return res.status(403).json({ error: 'Team activity is private' });
            wanted = users.map(u => ({ ...u, matchedOn: u.email }));
        } else if (q.rep) {
            if (!canSeeEveryone) return res.status(403).json({ error: 'You can only read your own call activity' });
            const seat = findSeat(users, loginAliases(q.rep));
            if (!seat) return res.status(404).json({ error: `No Quo seat is registered for ${String(q.rep).slice(0, 80)}`, seatsChecked: users.length });
            wanted = [seat];
        } else {
            const seat = findSeat(users, loginAliases(rep.email));
            if (!seat) return res.status(404).json({ error: 'Your Staffify address does not match a Quo seat, so no calls can be attributed to you. Ask Paul to check the email on your Quo user.', seatsChecked: users.length });
            wanted = [seat];
        }

        const reps = [];
        for (const seat of wanted) reps.push(await activityFor({ seat, from, to }));
        const total = reps.reduce((n, r) => n + r.dials, 0);

        return send(200, {
            window: { from, to, timezone: 'America/New_York', days: Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1, ...(clamped ? { clamped: 'Range capped at 31 days' } : {}) },
            reps: reps.sort((a, b) => b.dials - a.dials),
            totalDials: total,
            source: 'Quo API 2026-03-30 GET /calls',
            // Dialling from a desk phone, a personal mobile or anything outside the Quo app leaves
            // no record here, so this is a floor on activity rather than the whole of it.
            caveat: 'Counts calls placed through Quo. A call made outside the Quo app is not in Quo and is not counted here.',
        });
    } catch (e) {
        // Never a zero. A failed read says so, because "0 calls" about a person is an accusation.
        const status = e?.status === 401 || e?.status === 403 ? 502 : 503;
        return res.status(status).json({
            error: 'Quo could not be read, so no call count is being reported.',
            detail: String((e && e.message) || e).slice(0, 200),
            reported: null,
        });
    }
}
