// The daily caller report, on Vercel's schedule, independent of anyone's computer.
// ------------------------------------------------------------------
// Scheduled at 12:05, 13:05 and 14:05 UTC. 8:05 AM Eastern is 12:05 UTC in daylight time and 13:05
// UTC in standard time; a run before 8 AM Eastern does nothing, so the first run at or after 8:05
// generates the report for the complete previous Eastern day and the later runs are retries that
// post nothing once delivery is confirmed (see _daily-report-run.js).
//
// GET /api/cron-daily-report/                      the scheduled run (CRON_SECRET bearer from Vercel)
// GET /api/cron-daily-report/?day=YYYY-MM-DD       a given complete day, on demand (admin token)
// GET /api/cron-daily-report/?status=1             the last run, read-only
import { redis, adminAuthorized } from './_auth.js';
import { etDay } from './_quo.js';
import { previousDay } from './_daily-report.js';
import { reportPeople, runOne } from './_daily-report-run.js';

const LAST = 'report:daily:last-run';
const hourET = now => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date(now))) % 24;

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!adminAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
    const q = req.query || {};
    if (q.status) return res.status(200).json({ lastRun: (await redis.get(LAST).catch(() => null)) || null });
    const now = Date.now();
    const explicit = /^\d{4}-\d{2}-\d{2}$/.test(String(q.day || '')) ? String(q.day) : null;
    const day = explicit || previousDay(now);
    if (!explicit && hourET(now) < 8) {
        await redis.set(LAST, { at: new Date(now).toISOString(), day, skipped: 'before 8 AM Eastern' }, { ex: 30 * 86400 }).catch(() => {});
        return res.status(200).json({ skipped: 'before 8 AM Eastern', day });
    }
    if (day >= etDay(new Date(now))) return res.status(400).json({ error: 'Only a complete Eastern day can be reported; ' + day + ' has not ended.' });
    let people = [];
    try { people = await reportPeople(); }
    catch (e) { return res.status(503).json({ error: 'The rep list could not be read: ' + String((e && e.message) || e).slice(0, 120) }); }
    if (q.user) people = people.filter(p => p.email.toLowerCase() === String(q.user).toLowerCase());
    const results = [];
    for (const rep of people) {
        try { results.push(await runOne({ redis, rep, day, now })); }
        catch (e) { results.push({ email: rep.email, day, status: 'error', error: String((e && e.message) || e).slice(0, 160) }); }
    }
    const run = { at: new Date(now).toISOString(), day, people: people.map(p => p.email), results };
    await redis.set(LAST, run, { ex: 30 * 86400 }).catch(() => {});
    return res.status(200).json(run);
}
