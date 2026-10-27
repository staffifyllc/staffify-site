// Caller review, for the Performance page. Owners read anyone's; a caller reads their own; nobody else.
// ------------------------------------------------------------------
// GET /api/performance-review/?user=<email>&from=YYYY-MM-DD&to=YYYY-MM-DD
//   Defaults: the caller asking (owners must name one), the last 14 ET days ending today.
//   At most 31 days. Built live from Quo, the Hub call log, Calendly, shifts and Hub activity, the
//   same sources as the daily report (api/_performance-review.js says what each figure means).
// Who has a review: GET /api/daily-report/?people=1 (owners only), the same list as the daily report.
import { redis, requireAccess, getRep } from './_auth.js';
import { financeAccess } from './_finance-access.js';
import { loginAliases } from './_login-aliases.js';
import { etDay } from './_quo.js';
import { gatherRange, daysBetween } from './_daily-report.js';
import { decorator } from './_daily-report-run.js';
import { buildReview, leadSupply, MAX_DAYS } from './_performance-review.js';

export const config = { maxDuration: 60 };
const isDay = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const isOwner = rep => !!rep && (rep.role === 'admin' || financeAccess(rep));
const back = (day, n) => etDay(new Date(Date.parse(day + 'T12:00:00Z') - n * 86400000));

export default async function handler(req, res, { deps } = {}) {
    res.setHeader('Cache-Control', 'private, no-store');
    let rep = null;
    try { rep = await requireAccess(req); } catch { return res.status(503).json({ error: 'Your sign-in could not be checked just now.' }); }
    if (!rep) return res.status(401).json({ error: 'Sign in to your Staffify account.' });
    const q = req.query || {};
    const me = String(rep.email || '').toLowerCase();
    const target = String(q.user || me).toLowerCase();
    if (!isOwner(rep) && !loginAliases(me).includes(target)) return res.status(403).json({ error: 'You can read your own review only.' });
    if (target === 'admin') return res.status(400).json({ error: 'Ask for ?user=<email>.' });
    const today = etDay(new Date());
    const to = isDay(q.to) ? q.to : today;
    const from = isDay(q.from) ? q.from : back(to, 13);
    if (from > to) return res.status(400).json({ error: 'The start date is after the end date.' });
    if (to > today) return res.status(400).json({ error: 'That day has not started.' });
    if (daysBetween(from, to).length > MAX_DAYS) return res.status(400).json({ error: 'Pick ' + MAX_DAYS + ' days or fewer.' });
    const person = await getRep(target).catch(() => null);
    if (!person) return res.status(404).json({ error: 'No Hub account for ' + target + '.' });
    try {
        const now = Date.now();
        const src = await gatherRange({ redis, rep: person, from, to, now, decorate: decorator(redis), deps, keepRecords: true });
        const emails = loginAliases(String(person.email).toLowerCase());
        const review = buildReview(src, { generatedAt: new Date(now).toISOString(), now, emails });
        // A CRM read that failed leaves CRM-only numbers out of the count, so the count is a floor; say so.
        const crmIncomplete = !!(src.hub.records && src.hub.records.some(r => r.callContact && r.callContact.phoneStatus === 'unavailable'));
        review.supply = src.hub.ok && src.hub.records ? { asOf: src.hub.readAt, crmIncomplete, ...leadSupply(src.hub.records, emails) } : null;
        return res.status(200).json({ review });
    } catch (e) {
        return res.status(503).json({ error: 'The review could not be built: ' + String((e && e.message) || e).slice(0, 160) });
    }
}
