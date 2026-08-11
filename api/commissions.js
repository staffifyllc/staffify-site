// Rep commissions, driven by Paul's trigger:
//   1) ATTRIBUTION: a deal is Closed Won in HubSpot -> the HubSpot deal OWNER is the rep.
//   2) EARNED: the client's QuickBooks invoice is marked PAID (Balance == 0) AND real money was received
//      (a Payment exists) -> commission is payable. Closed Won alone never pays; the money must land first.
// So each Closed Won deal is PENDING until its invoice is paid, then PAYABLE, then (admin marks) PAID OUT.
//
// GET  /api/commissions/                -> the logged-in rep's own commissions
// GET  /api/commissions/?view=admin     -> (admin) every Closed Won deal, its owner->rep, matched invoice + status
// POST /api/commissions/ {dealId, rep, dealType, amount, customerId, paidOut, clear}  -> (admin) override one deal
//
// Commission = base * rate, where rate = dealType: va -> the rep's rate (default 35), website -> 30, ai -> 10.
// base = the paid invoice amount once paid, else the HubSpot deal amount as an estimate (admin can pin it, incl 0).

import { currentRep, adminAuthorized, listReps, readBody, redis } from './_auth.js';
import { qboConnected, qboQuery } from './_qbo.js';

const OVERRIDE_KEY = 'commission:overrides';
const OWNER_KEY = 'commission:owners'; // dealId -> the owner AT THE TIME IT WAS FIRST SEEN CLOSED WON
const DEAL_TYPES = ['va', 'website', 'ai'];
const HS = 'https://api.hubapi.com';
const MAX_DEAL_PAGES = 10; // 100/page -> up to 1000 Closed Won deals

function repRate(rep) { const n = Number(rep && rep.rate); return (n > 0 && n < 100) ? n : 35; }
function rateFor(dealType, rate) { if (dealType === 'website') return 30; if (dealType === 'ai') return 10; return rate; }
function round(n) { return Math.round(Number(n) || 0); }
function norm(s) { return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Resolve a deal's primary associated object id -> a property, via v4 batch associations + v3 batch read.
async function batchAssocProp(headers, dealIds, toType, prop) {
    const out = {};
    if (!dealIds.length) return out;
    try {
        const assoc = await fetch(`${HS}/crm/v4/associations/deals/${toType}/batch/read`, { method: 'POST', headers, body: JSON.stringify({ inputs: dealIds.map(id => ({ id })) }) });
        if (!assoc.ok) return out;
        const aj = await assoc.json();
        const ids = new Set(), dealToId = {};
        (aj.results || []).forEach(row => {
            const from = row.from && row.from.id;
            const to = (row.to && row.to[0] && (row.to[0].toObjectId || row.to[0].id)) || '';
            if (from && to) { dealToId[from] = String(to); ids.add(String(to)); }
        });
        if (!ids.size) return out;
        const rr = await fetch(`${HS}/crm/v3/objects/${toType}/batch/read`, { method: 'POST', headers, body: JSON.stringify({ inputs: [...ids].map(id => ({ id })), properties: [prop] }) });
        if (!rr.ok) return out;
        const rj = await rr.json();
        const propById = {};
        (rj.results || []).forEach(o => { propById[o.id] = (o.properties && o.properties[prop]) || ''; });
        Object.keys(dealToId).forEach(dealId => { out[dealId] = propById[dealToId[dealId]] || ''; });
    } catch (e) { /* best-effort */ }
    return out;
}

// ---- HubSpot: Closed Won deals + their owner and client (paginated) ----
async function loadHubspotWon() {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) return { configured: false, deals: [] };
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const owners = {};
    try {
        const r = await fetch(`${HS}/crm/v3/owners?limit=200`, { headers });
        if (r.ok) { const j = await r.json(); (j.results || []).forEach(o => { owners[o.id] = { email: (o.email || '').toLowerCase(), name: [o.firstName, o.lastName].filter(Boolean).join(' ').trim() || o.email || '' }; }); }
    } catch (e) { /* owners optional */ }

    let results = [];
    let after, truncated = false;
    try {
        for (let page = 0; page < MAX_DEAL_PAGES; page++) {
            const body = {
                filterGroups: [{ filters: [{ propertyName: 'hs_is_closed_won', operator: 'EQ', value: 'true' }] }],
                sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }],
                properties: ['dealname', 'amount', 'closedate', 'hubspot_owner_id', 'pipeline'],
                limit: 100,
            };
            if (after) body.after = after;
            const r = await fetch(`${HS}/crm/v3/objects/deals/search`, { method: 'POST', headers, body: JSON.stringify(body) });
            if (!r.ok) {
                const detail = (await r.text().catch(() => '')).slice(0, 160);
                return { configured: true, error: `deals ${r.status}: ${detail}`, hint: r.status === 403 ? 'The HubSpot private app needs the crm.objects.deals.read, crm.objects.owners.read and crm.objects.companies.read scopes.' : '', deals: [] };
            }
            const j = await r.json();
            results = results.concat(j.results || []);
            after = j.paging && j.paging.next && j.paging.next.after;
            if (!after) break;
            if (page === MAX_DEAL_PAGES - 1 && after) truncated = true;
        }
    } catch (e) { return { configured: true, error: String((e && e.message) || e).slice(0, 160), deals: [] }; }

    const dealIds = results.map(d => d.id);
    const [compByDeal, emailByDeal] = await Promise.all([
        batchAssocProp(headers, dealIds, 'companies', 'name'),
        batchAssocProp(headers, dealIds, 'contacts', 'email'),
    ]);

    const deals = results.map(d => {
        const p = d.properties || {};
        const owner = owners[p.hubspot_owner_id] || { email: '', name: p.hubspot_owner_id ? ('owner ' + p.hubspot_owner_id) : '' };
        const company = compByDeal[d.id] || p.dealname || '';
        return {
            dealId: d.id,
            name: p.dealname || company || 'Deal',
            company,
            amount: Number(p.amount) || 0,
            closeDate: (p.closedate || '').slice(0, 10),
            ownerEmail: owner.email,
            ownerName: owner.name,
            clientEmail: (emailByDeal[d.id] || '').toLowerCase(),
        };
    });
    return { configured: true, deals, truncated };
}

// ---- QuickBooks: paid invoices + money received, grouped by customer ----
async function loadQboPaid() {
    if (!(await qboConnected())) return { connected: false };
    let invoices = [];
    try {
        const j = await qboQuery("SELECT Id, TotalAmt, Balance, TxnDate, CustomerRef FROM Invoice ORDERBY TxnDate DESC MAXRESULTS 1000");
        invoices = (j && j.QueryResponse && j.QueryResponse.Invoice) || [];
    } catch (e) { return { connected: true, error: String((e && e.message) || e).slice(0, 200) }; }
    let customers = [];
    try {
        const j = await qboQuery("SELECT Id, DisplayName, PrimaryEmailAddr FROM Customer MAXRESULTS 1000");
        customers = (j && j.QueryResponse && j.QueryResponse.Customer) || [];
    } catch (e) { customers = []; }

    const custById = {}, custByName = {}, custByEmail = {};
    customers.forEach(c => {
        const name = c.DisplayName || '';
        const email = ((c.PrimaryEmailAddr && c.PrimaryEmailAddr.Address) || '').toLowerCase();
        custById[c.Id] = { id: c.Id, name, email };
        const nn = norm(name); if (nn) custByName[nn] = c.Id;
        if (email) custByEmail[email] = c.Id;
    });

    const byCust = {};
    function ensure(id, name) { return byCust[id] || (byCust[id] = { id, name: name || (custById[id] && custById[id].name) || '', paidTotal: 0, paidCount: 0, openTotal: 0, lastPaidDate: '', firstPaidDate: '', firstPaidAmt: 0, received: 0 }); }
    invoices.forEach(inv => {
        const id = inv.CustomerRef && inv.CustomerRef.value;
        if (!id) return;
        const total = Number(inv.TotalAmt) || 0;
        const balance = Number(inv.Balance) || 0;
        const date = (inv.TxnDate || '').toString();
        const paid = balance <= 0 && total > 0;
        const c = ensure(id, inv.CustomerRef && inv.CustomerRef.name);
        if (paid) {
            c.paidCount++; c.paidTotal += total;
            if (date && (!c.lastPaidDate || date > c.lastPaidDate)) c.lastPaidDate = date;
            if (date && (!c.firstPaidDate || date < c.firstPaidDate)) { c.firstPaidDate = date; c.firstPaidAmt = total; }
            if (!c.firstPaidAmt) c.firstPaidAmt = total; // fallback when dates are missing
        } else c.openTotal += balance;
    });

    // Money actually received (Payment objects). A voided/written-off invoice can show Balance 0 with no
    // payment, so payable requires a paid invoice AND received > 0.
    let payments = [];
    try {
        const j = await qboQuery("SELECT CustomerRef, TotalAmt, TxnDate FROM Payment ORDERBY TxnDate DESC MAXRESULTS 1000");
        payments = (j && j.QueryResponse && j.QueryResponse.Payment) || [];
    } catch (e) { payments = []; }
    payments.forEach(p => {
        const id = p.CustomerRef && p.CustomerRef.value; if (!id) return;
        ensure(id, p.CustomerRef && p.CustomerRef.name).received += Number(p.TotalAmt) || 0;
    });

    return { connected: true, byCust, custById, custByName, custByEmail, truncated: invoices.length >= 1000 || payments.length >= 1000 };
}

// ---- QuickBooks: what we have actually PAID each rep (1099 contractors = Vendors) ----
// Reps are paid weekly and one payment usually covers several commissions, so we total what each rep
// has been paid and settle their payable deals oldest-first against it, rather than guessing per deal.
async function loadRepPayouts(reps) {
    if (!reps.length) return { connected: true, byRep: {} };
    let vendors = [];
    try {
        const j = await qboQuery("SELECT Id, DisplayName, PrimaryEmailAddr FROM Vendor MAXRESULTS 1000");
        vendors = (j && j.QueryResponse && j.QueryResponse.Vendor) || [];
    } catch (e) { return { connected: false, error: String((e && e.message) || e).slice(0, 160), byRep: {} }; }

    // vendor id -> rep email, matched on vendor email first, then normalized name.
    const repByEmail = {}, repByName = {};
    reps.forEach(r => {
        const e = (r.email || '').toLowerCase(); if (e) repByEmail[e] = e;
        const n = norm(r.name); if (n) repByName[n] = e;
    });
    const vendorToRep = {};
    vendors.forEach(v => {
        const vEmail = ((v.PrimaryEmailAddr && v.PrimaryEmailAddr.Address) || '').toLowerCase();
        const vName = norm(v.DisplayName || '');
        const rep = (vEmail && repByEmail[vEmail]) || (vName && repByName[vName]) || '';
        if (rep) vendorToRep[v.Id] = rep;
    });

    const byRep = {};
    function add(repEmail, amt, date) {
        if (!repEmail) return;
        const r = byRep[repEmail] || (byRep[repEmail] = { paid: 0, lastDate: '' });
        r.paid += Number(amt) || 0;
        if (date && (!r.lastDate || date > r.lastDate)) r.lastDate = date;
    }
    // Bill payments (bill -> pay) and direct checks/expenses both count as paying the rep.
    try {
        const j = await qboQuery("SELECT VendorRef, TotalAmt, TxnDate FROM BillPayment ORDERBY TxnDate DESC MAXRESULTS 1000");
        ((j && j.QueryResponse && j.QueryResponse.BillPayment) || []).forEach(p => {
            const vid = p.VendorRef && p.VendorRef.value;
            add(vendorToRep[vid], p.TotalAmt, (p.TxnDate || '').toString());
        });
    } catch (e) { /* optional */ }
    try {
        const j = await qboQuery("SELECT EntityRef, TotalAmt, TxnDate FROM Purchase ORDERBY TxnDate DESC MAXRESULTS 1000");
        ((j && j.QueryResponse && j.QueryResponse.Purchase) || []).forEach(p => {
            const vid = p.EntityRef && p.EntityRef.value;
            add(vendorToRep[vid], p.TotalAmt, (p.TxnDate || '').toString());
        });
    } catch (e) { /* optional */ }

    // Only reps we can find as a QBO Vendor can be auto-settled. A W2 employee (Madison) is paid through
    // payroll, where the commission is bundled into a paycheck with base pay and taxes, so the books cannot
    // tell us how much of it was commission. Those reps stay on a manual mark, by design, not by omission.
    const autoReps = {};
    Object.keys(vendorToRep).forEach(vid => { autoReps[vendorToRep[vid]] = true; });
    return { connected: true, byRep, autoReps, vendorsMatched: Object.keys(vendorToRep).length };
}

// Settle each rep's payable deals against what QuickBooks says we already paid them, oldest first.
// A manual paidOut override always stands; this only auto-settles what the books can prove.
function allocatePayouts(lines, payouts) {
    const budget = {};
    Object.keys(payouts || {}).forEach(e => { budget[e] = payouts[e].paid; });
    // Manual paid-out lines consume budget first so they are not double counted.
    lines.filter(l => l.status === 'paid_out').forEach(l => { if (budget[l.repEmail] != null) budget[l.repEmail] -= l.commission; });
    const byRep = {};
    lines.filter(l => l.status === 'payable').forEach(l => { (byRep[l.repEmail] || (byRep[l.repEmail] = [])).push(l); });
    Object.keys(byRep).forEach(email => {
        let left = budget[email];
        if (left == null || left <= 0) return;
        byRep[email]
            .sort((a, b) => (a.paidDate || a.closeDate || '').localeCompare(b.paidDate || b.closeDate || ''))
            .forEach(l => {
                if (left >= l.commission && l.commission > 0) {
                    left -= l.commission;
                    l.status = 'paid_out';
                    l.payoutAuto = true;
                    l.payoutDate = (payouts[email] && payouts[email].lastDate) || '';
                }
            });
    });
    return lines;
}

async function loadOverrides() {
    const h = (await redis.hgetall(OVERRIDE_KEY)) || {};
    const out = {};
    for (const k of Object.keys(h)) { let v = h[k]; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } } if (v) out[k] = v; }
    return out;
}

// The closer is whoever owned the deal when it was WON. HubSpot owners get reassigned (handoff to an
// account manager, territory changes, someone leaving), and that must never move an earned commission.
// So the first time we see a deal Closed Won we snapshot its owner, and attribute to the snapshot forever.
async function loadOwnerSnapshots() {
    const h = (await redis.hgetall(OWNER_KEY)) || {};
    const out = {};
    for (const k of Object.keys(h)) { let v = h[k]; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } } if (v) out[k] = v; }
    return out;
}

async function snapshotNewOwners(deals, snaps) {
    const writes = {};
    deals.forEach(d => {
        if (snaps[d.dealId]) return;
        if (!d.ownerEmail) return; // nothing to lock yet; try again next load once the owner is set
        const rec = { ownerEmail: d.ownerEmail, ownerName: d.ownerName || '', closeDate: d.closeDate || '', at: Date.now() };
        snaps[d.dealId] = rec;
        writes[d.dealId] = JSON.stringify(rec);
    });
    if (Object.keys(writes).length) { try { await redis.hset(OWNER_KEY, writes); } catch (e) { /* non-fatal */ } }
    return snaps;
}

// Match a Closed Won deal to a QBO customer id: explicit pin, then contact email, then company name.
function matchCustomer(deal, ov, qbo) {
    if (ov && ov.customerId) return ov.customerId;
    if (!qbo || !qbo.custById) return '';
    if (deal.clientEmail && qbo.custByEmail[deal.clientEmail]) return qbo.custByEmail[deal.clientEmail];
    const key = norm(deal.company || deal.name);
    if (key && qbo.custByName[key]) return qbo.custByName[key];
    return '';
}

function reconcile(deal, ov, qbo, repRateByEmail, snap) {
    const dealType = (ov && DEAL_TYPES.includes(ov.dealType)) ? ov.dealType : 'va';
    // Admin override wins, then the owner locked at win time, then the current owner as a last resort.
    const closerEmail = (snap && snap.ownerEmail) || deal.ownerEmail || '';
    const repEmail = ((ov && ov.rep) || closerEmail || '').toLowerCase();
    const knownRep = !!repEmail && repRateByEmail[repEmail] != null;
    const ownerChanged = !!(snap && snap.ownerEmail && deal.ownerEmail && snap.ownerEmail !== deal.ownerEmail);
    const rate = rateFor(dealType, knownRep ? repRateByEmail[repEmail] : 35);

    const customerId = (qbo && qbo.connected) ? matchCustomer(deal, ov, qbo) : '';
    const cust = customerId && qbo.byCust ? qbo.byCust[customerId] : null;
    const invoicePaid = !!(cust && cust.paidCount > 0 && cust.received > 0); // paid AND money received to us
    const paidAmt = cust ? round(cust.firstPaidAmt || cust.paidTotal) : 0;

    const base = round((ov && ov.amount != null) ? ov.amount : (invoicePaid ? (paidAmt || deal.amount) : deal.amount));
    const commission = round(base * rate / 100);
    const paidOut = !!(ov && ov.paidOut);
    const status = paidOut ? 'paid_out' : (invoicePaid ? 'payable' : 'pending');

    return {
        dealId: deal.dealId, client: deal.name, company: deal.company,
        repEmail, repKnown: knownRep,
        ownerEmail: deal.ownerEmail, ownerName: deal.ownerName,
        closerEmail, closerName: (snap && snap.ownerName) || deal.ownerName, ownerChanged,
        dealType, base, rate, commission,
        closeDate: deal.closeDate,
        customerId, customerMatched: !!customerId, invoicePaid, paidDate: cust ? cust.lastPaidDate : '',
        status, override: ov || null,
    };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const who = await currentRep(req).catch(() => null);
    const isAdmin = (who && who.role === 'admin') || adminAuthorized(req);

    // ---- POST: admin overrides one deal ----
    if (req.method === 'POST') {
        if (!isAdmin) return res.status(403).json({ error: 'admin_only' });
        const b = readBody(req);
        const dealId = (b.dealId || '').toString();
        if (!dealId) return res.status(400).json({ error: 'bad_deal' });
        if (b.clear) { await redis.hdel(OVERRIDE_KEY, dealId); return res.status(200).json({ ok: true, cleared: dealId }); }
        const rec = {
            rep: (b.rep || '').toString().trim().toLowerCase() || undefined,
            dealType: DEAL_TYPES.includes((b.dealType || '').toString()) ? b.dealType : undefined,
            amount: (b.amount != null && b.amount !== '') ? Math.max(0, Number(b.amount) || 0) : undefined,
            customerId: (b.customerId || '').toString() || undefined,
            paidOut: (b.paidOut === true || b.paidOut === 'true') ? true : undefined,
            at: Date.now(), by: (who && who.email) || 'admin',
        };
        Object.keys(rec).forEach(k => rec[k] === undefined && delete rec[k]);
        await redis.hset(OVERRIDE_KEY, { [dealId]: JSON.stringify(rec) });
        return res.status(200).json({ ok: true, saved: dealId, override: rec });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    if (req.query.probe === '1') {
        return res.status(200).json({ qbo: await qboConnected().catch(() => false), hubspot: !!process.env.HUBSPOT_TOKEN });
    }

    if (!who && !isAdmin) return res.status(401).json({ error: 'login_required' });

    const [hs, qbo, overrides, reps, ownerSnaps] = await Promise.all([
        loadHubspotWon().catch(() => ({ configured: true, error: 'hubspot load failed', deals: [] })),
        loadQboPaid().catch(() => ({ connected: false })),
        loadOverrides().catch(() => ({})),
        listReps().catch(() => []),
        loadOwnerSnapshots().catch(() => ({})),
    ]);
    const repRateByEmail = {};
    reps.forEach(r => { const e = (r.email || '').toLowerCase(); if (e) repRateByEmail[e] = repRate(r); });

    if (!hs.configured) return res.status(200).json({ connected: false, source: 'hubspot', message: 'HubSpot is not connected yet, so there are no Closed Won deals to track.' });
    if (hs.error) return res.status(200).json({ connected: true, source: 'hubspot', error: hs.error, hint: hs.hint || '', deals: [] });

    // Lock the closer on any deal we are seeing Closed Won for the first time, then attribute to that.
    const snaps = await snapshotNewOwners(hs.deals || [], ownerSnaps).catch(() => ownerSnaps);
    const lines = (hs.deals || []).map(d => reconcile(d, overrides[d.dealId], qbo, repRateByEmail, snaps[d.dealId]));

    // Auto-settle: flip payable -> paid out for any rep QuickBooks shows we have already paid (1099 vendors).
    // W2 reps (payroll) have no vendor record, so they stay manual and are labeled as such.
    let payouts = { byRep: {}, autoReps: {} };
    if (qbo.connected) payouts = await loadRepPayouts(reps).catch(() => ({ byRep: {}, autoReps: {} }));
    allocatePayouts(lines, payouts.byRep || {});
    lines.forEach(l => { l.payoutMode = (payouts.autoReps && payouts.autoReps[l.repEmail]) ? 'auto' : 'manual'; });

    // ---- Admin view ----
    if (req.query.view === 'admin') {
        if (!isAdmin) return res.status(403).json({ error: 'admin_only' });
        const counts = {
            deals: lines.length,
            payable: lines.filter(l => l.status === 'payable').length,
            pending: lines.filter(l => l.status === 'pending').length,
            paidOut: lines.filter(l => l.status === 'paid_out').length,
            unmapped: lines.filter(l => !l.repKnown).length,
            unmatched: lines.filter(l => qbo.connected && !l.customerMatched).length,
            ownerChanged: lines.filter(l => l.ownerChanged).length,
        };
        const custList = qbo.connected ? Object.values(qbo.custById || {}).map(c => ({ id: c.id, name: c.name, email: c.email })) : [];
        return res.status(200).json({
            connected: true, view: 'admin', qboConnected: !!qbo.connected, qboError: qbo.error || '',
            truncated: { hubspot: !!hs.truncated, qbo: !!(qbo && qbo.truncated) },
            reps: reps.map(r => ({ email: (r.email || '').toLowerCase(), name: r.name || r.email })),
            customers: custList, counts, deals: lines,
        });
    }

    // ---- Rep view ----
    if (!who || !who.email) return res.status(401).json({ error: 'login_required' });
    const meEmail = who.email.toLowerCase();
    const mine = lines.filter(l => l.repEmail === meEmail);

    let payableCount = 0, payableCommission = 0, pendingCount = 0, pendingCommission = 0, paidOutCount = 0, paidOutCommission = 0;
    mine.forEach(l => {
        if (l.status === 'payable') { payableCount++; payableCommission += l.commission; }
        else if (l.status === 'paid_out') { paidOutCount++; paidOutCommission += l.commission; }
        else { pendingCount++; pendingCommission += l.commission; }
    });

    return res.status(200).json({
        connected: true, view: 'rep', qboConnected: !!qbo.connected,
        rep: { name: who.name || who.email, email: who.email, rate: repRate(who) },
        totals: {
            payableCount, payableCommission: round(payableCommission),
            pendingCount, pendingCommission: round(pendingCommission),
            paidOutCount, paidOutCommission: round(paidOutCommission),
        },
        deals: mine.map(l => ({
            client: l.client, dealType: l.dealType, base: l.base, rate: l.rate, commission: l.commission,
            status: l.status, closeDate: l.closeDate, paidDate: l.paidDate, invoicePaid: l.invoicePaid, customerMatched: l.customerMatched,
        })),
    });
}
