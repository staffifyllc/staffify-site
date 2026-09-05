// Residual ledger: what each rep is owed for VA hours, by fortnight, and whether it has been paid.
//
// Paul, 2026-09-04: residuals pay bi-weekly, first run 11 September 2026. He needs to see what is
// owed, what has been paid, and the amounts broken out by week.
//
// THE CHAIN: Hubstaff time entry -> Hubstaff project (= the client) -> that client's Closed Won deal
// -> the deal's owner -> the rep -> hours x that rep's residualPerHour.
//
// WHY THIS IS A SEPARATE ENDPOINT from commissions.js: this one walks day-level Hubstaff data across
// several months and buckets it, which is far more work than the commissions view needs on every
// load. Keeping them apart means a slow or dead Hubstaff cannot make the commissions page hang, and
// this can be cached on its own terms.
//
// GET  /api/residuals/                     -> the signed-in rep's own ledger
// GET  /api/residuals/?view=admin          -> every rep (admin only)
// GET  /api/residuals/?weeks=1             -> include the weekly breakdown
// POST /api/residuals/ {repEmail, periodIndex, paid, reference}  -> mark a period paid (admin only)

import { redis, currentRep, listReps, adminAuthorized, readBody } from './_auth.js';
import { hoursByClient } from './_hubstaff.js';
import { loadHubspotWon } from './commissions.js';
import { periodForWorkDate, periodByIndex, periodsBetween, weekKey, nextPayDate, PAY_ANCHOR, PERIOD_DAYS } from './_payperiods.js';

const PAID_KEY = 'residual:paid';            // `${repEmail}|${periodIndex}` -> {amount, paidAt, reference}
const MAP_KEY = 'residual:clientmap';        // hubstaff client name -> dealId, set by an admin
const RESIDUAL_MONTHS = Number(process.env.RESIDUAL_MONTHS || 6);
const LOOKBACK_DAYS = Number(process.env.RESIDUAL_LOOKBACK_DAYS || 120);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

// Same two-form matching the commissions view uses: deals are named "Vic Devore - Staffify VA" while
// the Hubstaff project is just "Vic Devore", so both the full string and the leading segment are
// indexed. Getting this wrong once matched 0 of 36 clients and would have paid nobody.
const forms = (v) => {
    const raw = String(v || '');
    return [raw, raw.split(/\s+[-|–—]\s+/)[0]];
};

function residualWindow(closeDate) {
    if (!closeDate) return null;
    const from = new Date(closeDate + 'T00:00:00Z');
    if (isNaN(from)) return null;
    const to = new Date(from);
    to.setUTCMonth(to.getUTCMonth() + RESIDUAL_MONTHS);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const who = await currentRep(req).catch(() => null);
    const isAdmin = (who && who.role === 'admin') || adminAuthorized(req);

    // ---- POST: an admin records that a period has been paid ----
    if (req.method === 'POST') {
        if (!isAdmin) return res.status(403).json({ error: 'admin_only' });
        const b = readBody(req);
        const repEmail = String(b.repEmail || '').toLowerCase();
        const periodIndex = Number(b.periodIndex);
        if (!repEmail || !Number.isFinite(periodIndex)) return res.status(400).json({ error: 'repEmail and periodIndex required' });
        const field = `${repEmail}|${periodIndex}`;
        if (b.paid === false) {
            await redis.hdel(PAID_KEY, field);
            return res.status(200).json({ ok: true, cleared: field });
        }
        const rec = {
            amount: money(b.amount),
            paidAt: b.paidAt || new Date().toISOString().slice(0, 10),
            reference: String(b.reference || '').slice(0, 120),
            by: (who && who.email) || 'admin',
        };
        await redis.hset(PAID_KEY, { [field]: JSON.stringify(rec) });
        return res.status(200).json({ ok: true, saved: field, record: rec });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
    if (!who && !isAdmin) return res.status(401).json({ error: 'login_required' });

    const wantAdmin = req.query.view === 'admin';
    if (wantAdmin && !isAdmin) return res.status(403).json({ error: 'admin_only' });

    const stop = today();
    const start = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);

    const [reps, paidRaw] = await Promise.all([
        listReps().catch(() => []),
        // hgetall RESOLVES to null when the hash does not exist, so .catch() never fires.
        // Coalesce, or the first read on a fresh install throws on a null lookup.
        redis.hgetall(PAID_KEY).then(v => v || {}).catch(() => ({})),
    ]);
    const ownerIdToRep = {};
    reps.forEach(r => {
        const id = String(r.hubspotOwnerId || '').trim();
        if (id) ownerIdToRep[id] = { email: (r.email || '').toLowerCase(), name: r.name || r.email };
    });
    const repByEmail = {};
    reps.forEach(r => {
        const e = (r.email || '').toLowerCase();
        if (e) repByEmail[e] = { email: e, name: r.name || e, perHour: (r.residualPerHour != null && r.residualPerHour !== '') ? Number(r.residualPerHour) : null };
    });

    const [hs, manualMap] = await Promise.all([
        loadHubspotWon(ownerIdToRep).catch(() => ({ deals: [] })),
        redis.hgetall(MAP_KEY).then(v => v || {}).catch(() => ({})),
    ]);
    const hours = await hoursByClient({ start, stop }).catch(e => ({ connected: false, error: String(e).slice(0, 120), clients: [] }));
    if (!hours.connected) {
        return res.status(200).json({
            connected: false, error: hours.error, hint: hours.hint,
            message: 'Hubstaff is not returning hours, so nothing can be attributed. No amount here would be trustworthy.',
        });
    }

    const deals = hs.deals || [];
    const byName = {};
    deals.forEach(d => {
        [d.company, d.client, d.name].filter(Boolean).forEach(n => {
            forms(n).forEach(f => { const k = norm(f); if (k && k.length > 2 && !byName[k]) byName[k] = d; });
        });
    });

    // ---- attribute every DAY of hours to a rep, a fortnight and a week ----
    const ledger = {};   // repEmail -> {periods:{i:{hours,amount}}, weeks:{k:{hours,amount}}, clients:{}}
    const unmatched = [];
    const outOfWindow = { clients: 0, hours: 0 };

    for (const c of hours.clients) {
        const forced = manualMap[c.name] || manualMap[norm(c.name)];
        const deal = forced
            ? deals.find(d => String(d.dealId) === String(forced))
            : (forms(c.name).map(f => byName[norm(f)]).find(Boolean) || null);
        if (!deal) { unmatched.push({ client: c.name, hours: c.hours, vaCount: c.vaCount }); continue; }

        const repEmail = (deal.ownerEmail || '').toLowerCase();
        const rep = repByEmail[repEmail];
        const perHour = rep && rep.perHour != null ? rep.perHour : 0;
        const win = residualWindow(deal.closeDate);

        const L = ledger[repEmail] || (ledger[repEmail] = {
            repEmail, name: (rep && rep.name) || repEmail || 'unattributed',
            perHour, periods: {}, weeks: {}, clients: {},
            note: !repEmail ? 'deal has no owner, so no rep to pay'
                : !rep ? 'deal owner is not a registered rep'
                : rep.perHour == null ? 'rep has no residualPerHour on file'
                : '',
        });

        for (const [day, secs] of Object.entries(c.byDay || {})) {
            // Hours outside the six-month residual window are real but earn nothing, and they are
            // counted separately rather than dropped, so the totals can always be reconciled.
            if (win && (day < win.from || day >= win.to)) { outOfWindow.hours += secs / 3600; continue; }
            const h = secs / 3600;
            const amt = h * perHour;
            const p = periodForWorkDate(day);
            const pk = p.index;
            const P = L.periods[pk] || (L.periods[pk] = { index: pk, payDate: p.payDate, start: p.start, end: p.end, hours: 0, amount: 0 });
            P.hours += h; P.amount += amt;
            const wk = weekKey(day);
            const W = L.weeks[wk] || (L.weeks[wk] = { week: wk, hours: 0, amount: 0 });
            W.hours += h; W.amount += amt;
            const C = L.clients[c.name] || (L.clients[c.name] = { client: c.name, dealId: deal.dealId, hours: 0, amount: 0 });
            C.hours += h; C.amount += amt;
        }
        if (win && Object.keys(c.byDay || {}).every(d => d < win.from || d >= win.to)) outOfWindow.clients++;
    }

    const paid = {};
    Object.entries(paidRaw || {}).forEach(([k, v]) => {
        try { paid[k] = typeof v === 'string' ? JSON.parse(v) : v; } catch { /* skip a corrupt row rather than 500 */ }
    });

    const nextRun = nextPayDate(stop);
    const shape = (L) => {
        const periods = Object.values(L.periods)
            .sort((a, b) => a.index - b.index)
            .map(p => {
                const rec = paid[`${L.repEmail}|${p.index}`] || null;
                // A period is only payable once its work is finished. The one in progress is shown
                // as accruing, so nobody pays a fortnight that is still running.
                const status = rec ? 'paid' : (p.payDate <= stop ? 'owed' : 'accruing');
                return { ...p, hours: Math.round(p.hours * 10) / 10, amount: money(p.amount), status, paidRecord: rec };
            });
        const owed = money(periods.filter(p => p.status === 'owed').reduce((a, p) => a + p.amount, 0));
        const accruing = money(periods.filter(p => p.status === 'accruing').reduce((a, p) => a + p.amount, 0));
        const paidToDate = money(periods.filter(p => p.status === 'paid').reduce((a, p) => a + p.amount, 0));
        return {
            repEmail: L.repEmail, name: L.name, perHour: L.perHour, note: L.note,
            owed, accruing, paidToDate,
            totalHours: Math.round(Object.values(L.periods).reduce((a, p) => a + p.hours, 0) * 10) / 10,
            periods,
            weeks: Object.values(L.weeks).sort((a, b) => a.week.localeCompare(b.week))
                .map(w => ({ ...w, hours: Math.round(w.hours * 10) / 10, amount: money(w.amount) })),
            clients: Object.values(L.clients).sort((a, b) => b.hours - a.hours)
                .map(c => ({ ...c, hours: Math.round(c.hours * 10) / 10, amount: money(c.amount) })),
        };
    };

    const all = Object.values(ledger).map(shape).sort((a, b) => b.owed - a.owed || b.totalHours - a.totalHours);
    const meta = {
        connected: true, schedule: { anchor: PAY_ANCHOR, everyDays: PERIOD_DAYS, nextPayDate: nextRun.payDate, nextCovers: { start: nextRun.start, end: nextRun.end } },
        range: { start, stop }, residualMonths: RESIDUAL_MONTHS,
        upcomingPeriods: periodsBetween(start, stop).slice(-6),
        outOfWindow: { clients: outOfWindow.clients, hours: Math.round(outOfWindow.hours * 10) / 10 },
    };

    if (wantAdmin) {
        return res.status(200).json({
            ...meta, view: 'admin', reps: all, unmatched,
            totals: {
                owed: money(all.reduce((a, r) => a + r.owed, 0)),
                accruing: money(all.reduce((a, r) => a + r.accruing, 0)),
                paidToDate: money(all.reduce((a, r) => a + r.paidToDate, 0)),
            },
        });
    }

    const meEmail = (who && who.email || '').toLowerCase();
    const mine = all.find(r => r.repEmail === meEmail) || {
        repEmail: meEmail, name: (who && who.name) || meEmail,
        perHour: (repByEmail[meEmail] && repByEmail[meEmail].perHour) ?? null,
        owed: 0, accruing: 0, paidToDate: 0, totalHours: 0, periods: [], weeks: [], clients: [],
        note: 'No VA hours attributed to you yet.',
    };
    return res.status(200).json({ ...meta, view: 'rep', me: mine });
}
