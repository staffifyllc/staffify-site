// The daily caller report, for the Hub. Owners read anyone's; a rep reads their own; nobody else.
// ------------------------------------------------------------------
// GET /api/daily-report/?user=<email>&date=YYYY-MM-DD[&live=1]
//   The stored snapshot for that day when there is one (what was delivered), otherwise built live
//   from the sources. live=1 rebuilds without storing. Today is allowed and is marked "so far".
// GET /api/daily-report/?people=1    who has a report (owners only)
import { redis, requireAccess } from './_auth.js';
import { financeAccess } from './_finance-access.js';
import { loginAliases } from './_login-aliases.js';
import { etDay } from './_quo.js';
import { previousDay } from './_daily-report.js';
import { reportPeople, liveReport, stored, destination } from './_daily-report-run.js';
import { getRep } from './_auth.js';

export const config = { maxDuration: 60 };
const isDay = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const isOwner = rep => !!rep && (rep.role === 'admin' || financeAccess(rep));

/** The next scheduled delivery, in UTC: the first of 12:05 / 13:05 / 14:05 that is at or after 8 AM Eastern. */
export function nextRun(now = Date.now()) {
    for (let d = 0; d < 3; d++) for (const h of [12, 13, 14]) {
        const base = new Date(now); base.setUTCHours(h, 5, 0, 0); const t = base.getTime() + d * 86400000;
        if (t <= now) continue;
        const hr = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date(t))) % 24;
        if (hr >= 8) return new Date(t).toISOString();
    }
    return null;
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    let rep = null;
    try { rep = await requireAccess(req); } catch { return res.status(503).json({ error: 'Your sign-in could not be checked just now.' }); }
    if (!rep) return res.status(401).json({ error: 'Sign in to your Staffify account.' });
    const q = req.query || {};
    const owner = isOwner(rep);
    if (q.people) {
        if (!owner) return res.status(403).json({ error: 'Owners only' });
        return res.status(200).json({ people: (await reportPeople()).map(p => ({ email: p.email, name: p.name || p.email })) });
    }
    const me = String(rep.email || '').toLowerCase();
    const target = String(q.user || me).toLowerCase();
    if (!owner && !loginAliases(me).includes(target)) return res.status(403).json({ error: 'You can read your own report only.' });
    if (target === 'admin') return res.status(400).json({ error: 'Ask for ?user=<email>.' });
    const person = await getRep(target).catch(() => null);
    if (!person) return res.status(404).json({ error: 'No Hub account for ' + target });
    const today = etDay(new Date());
    const day = isDay(q.date) ? q.date : previousDay();
    if (day > today) return res.status(400).json({ error: 'That day has not started.' });
    const schedule = { deliversAt: '8:05 AM Eastern, for the complete previous day', nextRunAt: nextRun(), destination: destination() ? 'Private Slack destination set' : 'No private Slack destination set yet; the report is kept here' };
    try {
        const { snapshot, delivery } = await stored(redis, person.email, day);
        if (snapshot && !q.live) return res.status(200).json({ report: snapshot, stored: true, delivery, partialDay: false, schedule });
        const report = await liveReport({ redis, rep: person, day });
        return res.status(200).json({ report, stored: false, delivery, partialDay: day === today, schedule });
    } catch (e) {
        return res.status(503).json({ error: 'The report could not be built: ' + String((e && e.message) || e).slice(0, 160) });
    }
}
