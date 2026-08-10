// Rep commissions, reconciled from real QuickBooks payments.
//
// GET  /api/commissions/                -> the logged-in rep's own commissions
// GET  /api/commissions/?view=admin     -> (admin) every paying client + attribution + rep list, to assign
// POST /api/commissions/ {customerId, rep, dealType, amount, note}  -> (admin) set/clear a client's attribution
//
// The money is verified (a client only shows once QBO says they paid). Attribution (which rep) and the
// commissionable deal amount are confirmed by an admin; QBO prefills the amount from the client's first payment.
// Commission = amount * rate, where rate = dealType: va -> the rep's rate (default 35), website -> 30, ai -> 10.
// Residuals, the 40%-past-5th accelerator, and the $200 retention bonus are phase 2 (they need placement hours).

import { currentRep, adminAuthorized, listReps, readBody, redis } from './_auth.js';
import { qboConnected, qboQuery } from './_qbo.js';

const DEALS_KEY = 'commission:deals';
const DEAL_TYPES = ['va', 'website', 'ai'];

function repRate(rep) {
    const n = Number(rep && rep.rate);
    return (n > 0 && n < 100) ? n : 35;
}
function rateFor(dealType, rep) {
    if (dealType === 'website') return 30;
    if (dealType === 'ai') return 10;
    return repRate(rep); // 'va' (default)
}
function round(n) { return Math.round(Number(n) || 0); }

// Pull all-time payments (earliest first, so a client's first payment = onboarding) and customer emails.
async function loadQbo() {
    if (!(await qboConnected())) return { connected: false };
    let payments = [];
    try {
        const j = await qboQuery("SELECT * FROM Payment ORDERBY TxnDate ASC MAXRESULTS 1000");
        payments = (j && j.QueryResponse && j.QueryResponse.Payment) || [];
    } catch (e) {
        return { connected: true, error: String((e && e.message) || e).slice(0, 200) };
    }
    let customers = [];
    try {
        const j = await qboQuery("SELECT Id, DisplayName, PrimaryEmailAddr FROM Customer MAXRESULTS 1000");
        customers = (j && j.QueryResponse && j.QueryResponse.Customer) || [];
    } catch (e) { customers = []; }

    const nameById = {}, emailById = {};
    customers.forEach(c => {
        nameById[c.Id] = c.DisplayName || '';
        emailById[c.Id] = ((c.PrimaryEmailAddr && c.PrimaryEmailAddr.Address) || '').toLowerCase();
    });

    const byCust = {};
    payments.forEach(p => {
        const id = p.CustomerRef && p.CustomerRef.value;
        if (!id) return;
        const amt = Number(p.TotalAmt) || 0;
        const date = (p.TxnDate || '').toString();
        let c = byCust[id];
        if (!c) c = byCust[id] = { id, name: (p.CustomerRef && p.CustomerRef.name) || nameById[id] || '', email: emailById[id] || '', total: 0, count: 0, first: 0, firstDate: '', lastDate: '' };
        c.total += amt; c.count++;
        if (!c.firstDate) { c.first = amt; c.firstDate = date; }   // earliest, since ASC
        if (!c.lastDate || date > c.lastDate) c.lastDate = date;
    });
    return { connected: true, byCust, truncated: payments.length >= 1000 };
}

async function loadDeals() {
    const h = (await redis.hgetall(DEALS_KEY)) || {};
    const out = {};
    for (const k of Object.keys(h)) {
        let v = h[k];
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
        if (v) out[k] = v;
    }
    return out;
}

// Best-effort email -> rep-email index, from won leads and closed hot leads. Bounded so it stays fast.
async function autoMatchIndex() {
    const idx = {};
    try {
        const ids = (await redis.zrange('leads:by_date', 0, 300, { rev: true })) || [];
        for (const id of ids) {
            const l = await redis.hgetall(id);
            if (l && l.status === 'won' && l.owner && l.email) {
                const e = String(l.email).toLowerCase();
                if (!idx[e]) idx[e] = l.owner;
            }
        }
    } catch (e) { /* ignore */ }
    try {
        const ids = (await redis.zrange('hotleads', 0, 199, { rev: true })) || [];
        for (const id of ids) {
            const h = await redis.hgetall(id);
            if (h && h.closedBy && h.email) {
                const e = String(h.email).toLowerCase();
                if (!idx[e]) idx[e] = h.closedBy;
            }
        }
    } catch (e) { /* ignore */ }
    return idx;
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const who = await currentRep(req).catch(() => null);
    const isAdmin = (who && who.role === 'admin') || adminAuthorized(req);

    // ---- POST: admin assigns / clears a client's attribution ----
    if (req.method === 'POST') {
        if (!isAdmin) return res.status(403).json({ error: 'admin_only' });
        const b = readBody(req);
        const customerId = (b.customerId || '').toString();
        if (!customerId) return res.status(400).json({ error: 'bad_customer' });
        const rep = (b.rep || '').toString().trim().toLowerCase();
        if (!rep) { // clear attribution
            await redis.hdel(DEALS_KEY, customerId);
            return res.status(200).json({ ok: true, cleared: customerId });
        }
        const dealType = DEAL_TYPES.includes((b.dealType || '').toString()) ? b.dealType : 'va';
        const amount = Math.max(0, Number(b.amount) || 0);
        const note = (b.note || '').toString().slice(0, 200);
        const rec = { rep, dealType, amount, note, assignedBy: (who && who.email) || 'admin', at: Date.now() };
        await redis.hset(DEALS_KEY, { [customerId]: JSON.stringify(rec) });
        return res.status(200).json({ ok: true, saved: customerId, deal: rec });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    // Cheap connectivity probe (boolean only, no QBO API call, no data). Used to show a "connect" prompt.
    if (req.query.probe === '1') return res.status(200).json({ connected: await qboConnected() });

    // Everything below hits QBO and returns money data, so require a logged-in rep or admin first.
    if (!who && !isAdmin) return res.status(401).json({ error: 'login_required' });

    const qbo = await loadQbo();
    if (!qbo.connected) return res.status(200).json({ connected: false, message: 'QuickBooks is not connected yet.' });
    if (qbo.error) return res.status(200).json({ connected: true, error: qbo.error, deals: [], totals: {} });

    const deals = await loadDeals();
    const byCust = qbo.byCust || {};

    // ---- Admin view: every paying client, its attribution, and a suggested rep ----
    if (req.query.view === 'admin') {
        if (!isAdmin) return res.status(403).json({ error: 'admin_only' });
        const auto = await autoMatchIndex();
        const reps = (await listReps()).map(r => ({ email: r.email, name: r.name || r.email, rate: repRate(r) }));
        const clients = Object.values(byCust)
            .sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''))
            .map(c => {
                const deal = deals[c.id] || null;
                return {
                    id: c.id, name: c.name, email: c.email,
                    totalPaid: round(c.total), firstPayment: round(c.first), firstDate: c.firstDate, lastDate: c.lastDate, payments: c.count,
                    deal: deal ? { rep: deal.rep, dealType: deal.dealType, amount: round(deal.amount || c.first), note: deal.note || '' } : null,
                    suggestedRep: (!deal && c.email && auto[c.email]) ? auto[c.email] : '',
                };
            });
        const assigned = clients.filter(c => c.deal).length;
        return res.status(200).json({
            connected: true, view: 'admin', truncated: !!qbo.truncated,
            counts: { clients: clients.length, assigned, unassigned: clients.length - assigned },
            reps, clients,
        });
    }

    // ---- Rep view: the logged-in rep's own commissions ----
    if (!who || !who.email) return res.status(401).json({ error: 'login_required' });
    const meEmail = who.email.toLowerCase();
    const lines = [];
    let paidCount = 0, paidCommission = 0, pendingCount = 0, pendingCommission = 0;

    for (const custId of Object.keys(deals)) {
        const deal = deals[custId];
        if (!deal || (deal.rep || '').toLowerCase() !== meEmail) continue;
        const c = byCust[custId];
        const amount = round(deal.amount || (c ? c.first : 0));
        const rate = rateFor(deal.dealType, who);
        const commission = round(amount * rate / 100);
        const paid = !!c; // client has at least one QBO payment
        const line = {
            client: (c && c.name) || deal.note || 'Client',
            dealType: deal.dealType || 'va',
            amount, rate, commission,
            paid, paidDate: c ? c.firstDate : '', lastPaidDate: c ? c.lastDate : '',
        };
        lines.push(line);
        if (paid) { paidCount++; paidCommission += commission; }
        else { pendingCount++; pendingCommission += commission; }
    }

    lines.sort((a, b) => (b.paidDate || '').localeCompare(a.paidDate || ''));

    return res.status(200).json({
        connected: true, view: 'rep',
        rep: { name: who.name || who.email, email: who.email, rate: repRate(who) },
        totals: {
            lifetimeCommission: round(paidCommission),
            paidCount, pendingCount,
            pendingCommission: round(pendingCommission),
        },
        deals: lines,
    });
}
