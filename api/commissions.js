// Rep commissions, driven by Paul's trigger:
//   1) ATTRIBUTION: a deal is Closed Won in HubSpot -> the HubSpot deal OWNER is the rep.
//   2) EARNED: commission accrues on money actually RECEIVED against this deal's QuickBooks invoice
//      (TotalAmt - Balance), so an instalment plan pays the rep as each instalment lands.
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
import { hoursByClient, hubstaffStatus } from './_hubstaff.js';

const OVERRIDE_KEY = 'commission:overrides';
const OWNER_KEY = 'commission:owners'; // dealId -> the owner AT THE TIME IT WAS FIRST SEEN CLOSED WON
const DEAL_TYPES = ['va', 'website', 'ai'];
const HS = 'https://api.hubapi.com';
const MAX_DEAL_PAGES = 10; // 100/page -> up to 1000 Closed Won deals
const LEAD_SOURCE_PROP = process.env.COMMISSION_LEADSOURCE_PROP || 'deal_source';

function repRate(rep) { const n = Number(rep && rep.rate); return (n > 0 && n < 100) ? n : 35; }
// Rate on leads the company hands the rep. Only set for reps on a split plan (Madison: 20 house / 35 self).
// Everyone else has no houseRate and earns their single rate on every deal.
function repHouseRate(rep) { const n = Number(rep && rep.houseRate); return (n > 0 && n < 100) ? n : null; }

// Foundry websites pay a FLAT amount per site, not a percentage (Paul, 2026-08-11). AI stays a percentage.
const FLAT_COMMISSION = { website: Number(process.env.FOUNDRY_COMMISSION || 400) };
const ACCEL_AFTER = Number(process.env.ACCEL_AFTER_DEALS || 5);  // 40% starts on the 6th close of a month
const ACCEL_RATE = Number(process.env.ACCEL_RATE || 40);

// Paul, 2026-08-14: commission is calculated NET of card processing fees, and a refund or chargeback
// claws the commission back automatically. Fees are only applied when the payment actually went
// through a card, so an ACH or a cheque is not docked a fee it never incurred.
const FEE_PCT = Number(process.env.PROCESSING_FEE_PCT || 2.9);
const FEE_FIXED = Number(process.env.PROCESSING_FEE_FIXED || 0.30);
const CARD_METHOD = /card|credit|visa|master|amex|discover|stripe/i;

function rateFor(dealType, rate) { if (dealType === 'ai') return 10; return rate; }
// A flat-fee deal type pays a fixed amount, so netting a processing fee off the invoice would not
// change the payout. Skip the calculation rather than showing a deduction that does nothing.
function flatOrPct(dealType) { return (FLAT_COMMISSION[dealType] != null) ? 'skip' : 'pct'; }
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
async function loadHubspotWon(ownerIdToRep = {}) {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) return { configured: false, deals: [] };
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // Owners are NOT optional: the owner's email is the only key that maps a won deal to a rep, so a
    // silent failure here pays nobody. On 2026-09-04 this call was returning 403 (the private app is
    // missing crm.objects.owners.read) and the empty map was swallowed, which meant every rep's
    // commission silently computed to nothing. Capture it and let the caller surface it.
    const owners = {};
    let ownersError = '';
    try {
        const r = await fetch(`${HS}/crm/v3/owners?limit=200`, { headers });
        if (r.ok) { const j = await r.json(); (j.results || []).forEach(o => { owners[o.id] = { email: (o.email || '').toLowerCase(), name: [o.firstName, o.lastName].filter(Boolean).join(' ').trim() || o.email || '' }; }); }
        else ownersError = `owners ${r.status}`;
    } catch (e) { ownersError = 'owners request failed'; }

    // Pipeline -> deal type, so a Foundry website deal is not silently paid the VA rate.
    const pipeType = {};
    try {
        const r = await fetch(`${HS}/crm/v3/pipelines/deals`, { headers });
        if (r.ok) {
            const j = await r.json();
            (j.results || []).forEach(p => {
                const l = (p.label || '').toLowerCase();
                if (/foundry|website|web design|site/.test(l)) pipeType[p.id] = 'website';
                else if (/\bai\b|automation/.test(l)) pipeType[p.id] = 'ai';
                else if (/va|staffing|placement|talent/.test(l)) pipeType[p.id] = 'va';
            });
        }
    } catch (e) { /* classification falls back to the admin override */ }

    let results = [];
    let after, truncated = false;
    try {
        for (let page = 0; page < MAX_DEAL_PAGES; page++) {
            const body = {
                filterGroups: [{ filters: [{ propertyName: 'hs_is_closed_won', operator: 'EQ', value: 'true' }] }],
                sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }],
                properties: ['dealname', 'amount', 'closedate', 'hubspot_owner_id', 'pipeline', LEAD_SOURCE_PROP],
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
        // Fall back to the owner id a rep has on file, so commissions still attribute correctly when
        // the owners scope is missing. Without this the whole page degrades to zero for everyone.
        const byId = ownerIdToRep[String(p.hubspot_owner_id || '')];
        const owner = owners[p.hubspot_owner_id]
            || (byId ? { email: byId.email, name: byId.name || byId.email } : null)
            || { email: '', name: p.hubspot_owner_id ? ('owner ' + p.hubspot_owner_id) : '' };
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
            dealType: pipeType[p.pipeline] || '',
            // Self-sourced only when the deal says so. Anything else is treated as a company lead.
            leadSource: /self|own|rep.?sourced|prospect/i.test(String(p[LEAD_SOURCE_PROP] || '')) ? 'self' : '',
        };
    });
    return { configured: true, deals, truncated, ownersError };
}

// ---- QuickBooks: paid invoices + money received, grouped by customer ----
async function loadQboPaid() {
    if (!(await qboConnected())) return { connected: false };
    let invoices = [];
    try {
        const j = await qboQuery("SELECT Id, DocNumber, TotalAmt, Balance, TxnDate, CustomerRef FROM Invoice ORDERBY TxnDate DESC MAXRESULTS 1000");
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
    function ensure(id, name) { return byCust[id] || (byCust[id] = { id, name: name || (custById[id] && custById[id].name) || '', paidTotal: 0, paidCount: 0, openTotal: 0, lastPaidDate: '', received: 0, cardPaid: 0, cardCount: 0, refunded: 0, lastRefundDate: '', invoices: [] }); }
    invoices.forEach(inv => {
        const id = inv.CustomerRef && inv.CustomerRef.value;
        if (!id) return;
        const total = Number(inv.TotalAmt) || 0;
        const balance = Number(inv.Balance) || 0;
        const date = (inv.TxnDate || '').toString();
        const paid = balance <= 0 && total > 0;
        const c = ensure(id, inv.CustomerRef && inv.CustomerRef.name);
        // Keep every invoice so a deal can be tied to ITS OWN invoice, not to the customer as a whole.
        c.invoices.push({ id: inv.Id, docNumber: inv.DocNumber || '', total, balance, date, paid });
        if (paid) {
            c.paidCount++; c.paidTotal += total;
            if (date && (!c.lastPaidDate || date > c.lastPaidDate)) c.lastPaidDate = date;
        } else c.openTotal += balance;
    });

    // Money actually received (Payment objects). A voided/written-off invoice can show Balance 0 with no
    // payment, so payable requires a paid invoice AND received > 0.
    let payments = [];
    try {
        const j = await qboQuery("SELECT CustomerRef, TotalAmt, TxnDate, PaymentMethodRef FROM Payment ORDERBY TxnDate DESC MAXRESULTS 1000");
        payments = (j && j.QueryResponse && j.QueryResponse.Payment) || [];
    } catch (e) { payments = []; }
    payments.forEach(p => {
        const id = p.CustomerRef && p.CustomerRef.value; if (!id) return;
        const c = ensure(id, p.CustomerRef && p.CustomerRef.name);
        const amt = Number(p.TotalAmt) || 0;
        c.received += amt;
        const method = (p.PaymentMethodRef && (p.PaymentMethodRef.name || p.PaymentMethodRef.value)) || '';
        const isCard = CARD_METHOD.test(String(method));
        if (isCard) { c.cardPaid += amt; c.cardCount++; }
        // Keep the individual payments. A client on an instalment plan needs to see what EACH payment
        // earned, and the fixed part of the card fee is charged per transaction, so a cumulative
        // calculation with one fixed fee quietly under-charges a three-payment deal.
        (c.payments || (c.payments = [])).push({ date: (p.TxnDate || '').slice(0, 10), amount: amt, method, isCard });
    });

    // Money that went back OUT to the client. A refund or a credit memo reverses the commission.
    let refunds = [];
    try {
        const j = await qboQuery("SELECT CustomerRef, TotalAmt, TxnDate FROM RefundReceipt ORDERBY TxnDate DESC MAXRESULTS 500");
        refunds = (j && j.QueryResponse && j.QueryResponse.RefundReceipt) || [];
    } catch (e) { refunds = []; }
    try {
        const j = await qboQuery("SELECT CustomerRef, TotalAmt, TxnDate FROM CreditMemo ORDERBY TxnDate DESC MAXRESULTS 500");
        refunds = refunds.concat((j && j.QueryResponse && j.QueryResponse.CreditMemo) || []);
    } catch (e) { /* credit memos optional */ }
    refunds.forEach(r => {
        const id = r.CustomerRef && r.CustomerRef.value; if (!id) return;
        const c = ensure(id, r.CustomerRef && r.CustomerRef.name);
        c.refunded += Number(r.TotalAmt) || 0;
        const d = (r.TxnDate || '').toString();
        if (d && (!c.lastRefundDate || d > c.lastRefundDate)) c.lastRefundDate = d;
    });

    return { connected: true, byCust, custById, custByName, custByEmail, truncated: invoices.length >= 1000 || payments.length >= 1000 };
}

// ---- Residual: $/hour on every hour a VA works under a client the rep closed ----
//
// Paul, 2026-09-04: Madison earns $0.50 per hour worked. The canonical plan is $1/hr for six
// months; hers is half, matching her 20% against the standard 35%.
//
// THE CHAIN: Hubstaff time entry -> Hubstaff project (= the client) -> the Closed Won deal for that
// client -> that deal's owner -> the rep. It only scales if the client-to-deal step is automatic,
// so names are matched normalised, and anything ambiguous is reported as UNMATCHED rather than
// guessed. Guessing here pays the wrong rep, which is worse than paying nobody yet.
const RESIDUAL_MAP_KEY = 'residual:clientmap';   // hubstaff client name -> dealId, set by an admin
const RESIDUAL_MONTHS = Number(process.env.RESIDUAL_MONTHS || 6);

function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Deal close date + the residual window. Hours before the deal closed are not the rep's, and the
// window stops the residual running forever on a client they closed years ago.
function residualWindow(closeDate) {
    if (!closeDate) return null;
    const from = new Date(closeDate + 'T00:00:00Z');
    if (isNaN(from)) return null;
    const to = new Date(from); to.setUTCMonth(to.getUTCMonth() + RESIDUAL_MONTHS);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

async function loadResidualMap() {
    try { return (await redis.hgetall(RESIDUAL_MAP_KEY)) || {}; } catch (e) { return {}; }
}

// One residual line per client that worked hours, attributed to the rep who closed it.
export async function buildResiduals(deals, repRateByEmail, manualMap, range) {
    const hs = await hoursByClient(range).catch(e => ({ connected: false, error: String(e).slice(0, 100), clients: [] }));
    if (!hs.connected) return { connected: false, error: hs.error, hint: hs.hint, lines: [], unmatched: [] };

    // Index the won deals by normalised client and company name, both, since a Hubstaff project is
    // usually named for the person and the deal is often named for the business, or the reverse.
    // Deals are named "Vic Devore - Staffify VA" while the Hubstaff project is just "Vic Devore",
    // so the whole string never matches. Index the leading segment before a dash or a pipe as well
    // as the full name. Missing this matched 0 of 36 clients in production while the same data
    // matched 29 of 32 by hand, which is the difference between every rep being paid and none.
    const candidates = (v) => {
        const raw = String(v || '');
        const head = raw.split(/\s+[-|\u2013\u2014]\s+/)[0];
        return [raw, head];
    };
    const byName = {};
    deals.forEach(d => {
        [d.company, d.client, d.name].filter(Boolean).forEach(n => {
            candidates(n).forEach(c => {
                const k = normName(c);
                if (k && k.length > 2 && !byName[k]) byName[k] = d;
            });
        });
    });

    const lines = [], unmatched = [];
    for (const c of hs.clients) {
        const forced = manualMap[c.name] || manualMap[normName(c.name)];
        // Try the Hubstaff project name whole, then its own leading segment, so "PRSPCTV Media - Kyle
        // Lux" can find a deal named for either half.
        const deal = forced
            ? deals.find(d => String(d.dealId) === String(forced))
            : (candidates(c.name).map(x => byName[normName(x)]).find(Boolean) || null);
        if (!deal) { unmatched.push({ client: c.name, hours: c.hours, vaCount: c.vaCount }); continue; }

        const repEmail = (deal.ownerEmail || '').toLowerCase();
        const plan = repRateByEmail[repEmail];
        const perHour = plan && plan.residualPerHour != null ? Number(plan.residualPerHour) : 0;
        const win = residualWindow(deal.closeDate);
        // No rate on file means no residual, and we say so. Silently paying $0 is how this rots.
        lines.push({
            client: c.name, dealId: deal.dealId, repEmail,
            hours: c.hours, vaCount: c.vaCount,
            perHour, residual: Math.round(c.hours * perHour * 100) / 100,
            window: win, closeDate: deal.closeDate,
            note: !repEmail ? 'deal has no owner, so no rep to pay'
                : !plan ? 'owner is not a registered rep'
                : !perHour ? 'rep has no residualPerHour on file'
                : '',
        });
    }
    return { connected: true, lines, unmatched, range, truncated: !!hs.truncated };
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
    // Only COMMISSION payments may settle a commission. Summing every payment to the rep's vendor record
    // would let base pay, an expense reimbursement, or a travel advance silently mark real commissions as
    // paid out. Payments must carry the tag (default "commission") in their memo. If nothing is tagged,
    // nothing auto-settles and the deals stay payable, which is the safe direction to be wrong in.
    const TAG = (process.env.COMMISSION_MEMO_TAG || 'commission').toLowerCase();
    const matchAll = String(process.env.COMMISSION_PAYOUT_MATCH_ALL || '') === 'true';
    const isCommission = (memo) => matchAll || String(memo || '').toLowerCase().includes(TAG);
    let scanned = 0, tagged = 0;
    try {
        const j = await qboQuery("SELECT VendorRef, TotalAmt, TxnDate, PrivateNote FROM BillPayment ORDERBY TxnDate DESC MAXRESULTS 1000");
        ((j && j.QueryResponse && j.QueryResponse.BillPayment) || []).forEach(p => {
            const vid = p.VendorRef && p.VendorRef.value;
            if (!vendorToRep[vid]) return;
            scanned++;
            if (!isCommission(p.PrivateNote)) return;
            tagged++;
            add(vendorToRep[vid], p.TotalAmt, (p.TxnDate || '').toString());
        });
    } catch (e) { /* optional */ }
    try {
        const j = await qboQuery("SELECT EntityRef, TotalAmt, TxnDate, PrivateNote FROM Purchase ORDERBY TxnDate DESC MAXRESULTS 1000");
        ((j && j.QueryResponse && j.QueryResponse.Purchase) || []).forEach(p => {
            const vid = p.EntityRef && p.EntityRef.value;
            if (!vendorToRep[vid]) return;
            scanned++;
            if (!isCommission(p.PrivateNote)) return;
            tagged++;
            add(vendorToRep[vid], p.TotalAmt, (p.TxnDate || '').toString());
        });
    } catch (e) { /* optional */ }

    // Only reps we can find as a QBO Vendor can be auto-settled. A W2 employee (Madison) is paid through
    // payroll, where the commission is bundled into a paycheck with base pay and taxes, so the books cannot
    // tell us how much of it was commission. Those reps stay on a manual mark, by design, not by omission.
    const autoReps = {};
    Object.keys(vendorToRep).forEach(vid => { autoReps[vendorToRep[vid]] = true; });
    return { connected: true, byRep, autoReps, vendorsMatched: Object.keys(vendorToRep).length, scanned, tagged, tag: TAG };
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

// Strong-month accelerator, MARGINAL (Paul, 2026-08-11): the 6th and later closes in a calendar month
// pay 40% instead of the rep's normal rate. Deals 1-5 keep their normal rate, so it is not retroactive.
// Percentage deals only, and only when it beats the rate already applied. Flat-fee deal types are skipped,
// and reps on a custom split plan are left alone since their offer does not include the accelerator.
function applyAccelerator(lines) {
    const groups = {};
    lines.forEach(l => {
        if (l.flat != null || !l.repEmail || l.splitPlan) return;
        const month = (l.closeDate || '').slice(0, 7);
        if (!month) return;
        (groups[l.repEmail + '|' + month] || (groups[l.repEmail + '|' + month] = [])).push(l);
    });
    Object.keys(groups).forEach(k => {
        groups[k]
            .sort((a, b) => (a.closeDate || '').localeCompare(b.closeDate || '') || String(a.dealId).localeCompare(String(b.dealId)))
            .forEach((l, i) => {
                if (i < ACCEL_AFTER) return;              // deals 1..5 keep their normal rate
                if (!(ACCEL_RATE > (l.rate || 0))) return; // never lower an already-higher rate
                l.rate = ACCEL_RATE;
                l.accelerated = true;
                l.commission = round(l.base * ACCEL_RATE / 100);
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

async function snapshotNewOwners(deals, snaps, repRateByEmail) {
    const writes = {};
    deals.forEach(d => {
        if (snaps[d.dealId]) return;
        if (!d.ownerEmail) return; // nothing to lock yet; try again next load once the owner is set
        // Lock the rate too: a later rate change must not re-price deals already closed (or already paid).
        const plan = repRateByEmail[d.ownerEmail];
        const rec = { ownerEmail: d.ownerEmail, ownerName: d.ownerName || '', closeDate: d.closeDate || '', at: Date.now() };
        if (plan && plan.rate != null) rec.rate = plan.rate;
        if (plan && plan.houseRate != null) rec.houseRate = plan.houseRate;
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

// Tie each deal to ONE specific invoice. Matching at the customer level is wrong: a repeat client already
// has paid invoices, so a brand-new deal would read as "already paid" the second it is marked Closed Won,
// and would be priced off the client's FIRST-ever invoice. Each deal gets the invoice raised nearest its
// close date (preferring on/after the close), and an invoice is only ever claimed by one deal.
function assignInvoices(deals, overrides, qbo) {
    const assigned = {};
    if (!qbo || !qbo.connected) return assigned;
    const claimed = {};

    // Honour explicit admin pins first so they always win the invoice they name.
    deals.forEach(d => {
        const ov = overrides[d.dealId];
        if (!ov || !ov.invoiceId) return;
        const custId = matchCustomer(d, ov, qbo);
        const cust = custId && qbo.byCust[custId];
        const inv = cust && (cust.invoices || []).find(i => String(i.id) === String(ov.invoiceId));
        if (inv) { assigned[d.dealId] = { custId, inv }; claimed[inv.id] = true; }
    });

    // Then auto-assign, oldest close first, so early deals take the early invoices.
    deals.slice().sort((a, b) => (a.closeDate || '').localeCompare(b.closeDate || '')).forEach(d => {
        if (assigned[d.dealId]) return;
        const ov = overrides[d.dealId] || {};
        const custId = matchCustomer(d, ov, qbo);
        const cust = custId && qbo.byCust[custId];
        if (!cust) return;
        const pool = (cust.invoices || []).filter(i => !claimed[i.id]);
        if (!pool.length) { assigned[d.dealId] = { custId, inv: null }; return; }
        const close = d.closeDate || '';
        let best = null, bestScore = null;
        pool.forEach(i => {
            const days = (close && i.date) ? Math.abs((new Date(i.date) - new Date(close)) / 864e5) : 9999;
            // Prefer an invoice raised on/after the close date; a pre-close invoice is likely a different sale.
            const after = (close && i.date && i.date >= close) ? 0 : 1;
            const score = after * 10000 + days;
            if (bestScore === null || score < bestScore) { bestScore = score; best = i; }
        });
        if (best) { assigned[d.dealId] = { custId, inv: best }; claimed[best.id] = true; }
        else assigned[d.dealId] = { custId, inv: null };
    });
    return assigned;
}

function reconcile(deal, ov, qbo, repRateByEmail, snap, assignment) {
    const dealType = (ov && DEAL_TYPES.includes(ov.dealType)) ? ov.dealType : (deal.dealType || 'va');
    // Admin override wins, then the owner locked at win time, then the current owner as a last resort.
    const closerEmail = (snap && snap.ownerEmail) || deal.ownerEmail || '';
    const repEmail = ((ov && ov.rep) || closerEmail || '').toLowerCase();
    const plan = repRateByEmail[repEmail] || null;
    const knownRep = !!repEmail && !!plan;
    const ownerChanged = !!(snap && snap.ownerEmail && deal.ownerEmail && snap.ownerEmail !== deal.ownerEmail);

    // Lead source decides which rate applies for reps on a split plan. Admin override wins, then the
    // HubSpot property, then default to a company lead (the conservative side for a handed-over lead).
    const leadSource = ((ov && ov.leadSource) || deal.leadSource || 'house');
    const selfSourced = leadSource === 'self';
    const houseRate = (snap && snap.houseRate != null) ? Number(snap.houseRate) : (plan ? plan.houseRate : null);
    const ownRate = (snap && snap.rate != null) ? Number(snap.rate) : (plan ? plan.rate : 35);
    // Rates are locked at win time, so changing a rep's plan never re-prices deals they already closed.
    const planRate = (!selfSourced && houseRate != null) ? houseRate : ownRate;
    const rate = rateFor(dealType, planRate);

    const customerId = (qbo && qbo.connected) ? ((assignment && assignment.custId) || matchCustomer(deal, ov, qbo)) : '';
    const cust = customerId && qbo.byCust ? qbo.byCust[customerId] : null;
    const inv = (assignment && assignment.inv) || null;
    // INSTALMENTS (Paul, 2026-09-04). A client paying $2,099 as three $700 instalments earns the rep
    // commission as each payment lands, not all at once when the last one clears. The old rule was
    // Balance == 0 or nothing, which would have shown Madison $0 on a deal already a third collected.
    // An invoice's own TotalAmt and Balance give exact per-invoice attribution, so this needs no walk
    // of QBO Payment lines. cust.received stays in the guard so a written-off invoice, which can read
    // Balance 0 with no money in, is never mistaken for a payment.
    const invTotal = inv ? (Number(inv.total) || 0) : 0;
    const invBalance = inv ? (Number(inv.balance) || 0) : 0;
    const invReceived = inv ? Math.max(0, round(Math.min(invTotal, invTotal - invBalance))) : 0;
    const moneyLanded = !!(cust && cust.received > 0);
    const invoicePaid = !!(inv && inv.paid && moneyLanded);
    const invoicePartPaid = !!(inv && invReceived > 0 && moneyLanded);

    // Earned on what actually came in. With nothing collected yet the line still shows the full deal
    // so the rep can see what is coming, and it stays 'pending' until money lands.
    const gross = round((ov && ov.amount != null) ? ov.amount
        : (invoicePartPaid ? invReceived : deal.amount));

    // Net of processing fees (Paul, 2026-08-14). Only charged when the money actually came in on a
    // card: an ACH or a cheque incurs no processing fee and must not be docked one. An explicit
    // admin amount is taken as already-final and is never reduced again.
    const paidByCard = !!(cust && cust.cardCount > 0);
    const feeApplies = invoicePartPaid && paidByCard && !(ov && ov.amount != null) && flatOrPct(dealType) !== 'skip';
    const fee = feeApplies ? Math.round((gross * (FEE_PCT / 100) + FEE_FIXED) * 100) / 100 : 0;
    const base = round(gross - fee);

    const flat = FLAT_COMMISSION[dealType];
    let commission = (flat != null) ? round(flat) : round(base * rate / 100);

    // A refund or chargeback reverses the commission. The rep does not keep a cut of money we gave back.
    const refunded = !!(cust && cust.refunded > 0);
    const paidOut = !!(ov && ov.paidOut);
    // Partly collected is payable on the collected part. It is not 'pending': that money is earned.
    let status = paidOut ? 'paid_out' : (invoicePartPaid ? 'payable' : 'pending');
    let clawback = 0;
    if (refunded && !(ov && ov.keepOnRefund)) {
        clawback = commission;
        commission = 0;
        status = 'clawed_back';
    }

    // What is still to come on this deal, so a rep sees "earned so far" and "remaining" rather than a
    // single number that quietly means different things on an instalment deal.
    const outstanding = round(Math.max(0, (invTotal || deal.amount) - invReceived));
    const remainingCommission = (flat != null) ? 0 : round(outstanding * rate / 100);

    // Per-payment breakdown, so an instalment deal shows what each payment actually earned rather than
    // one cumulative number. QBO Payment objects are recorded against the CUSTOMER, not the invoice, so
    // this is only unambiguous when the customer has a single invoice. With more than one, the payments
    // cannot be split between deals without walking LinkedTxn, and guessing would misattribute money
    // between reps. In that case the schedule is omitted rather than approximated.
    let paymentSchedule = [];
    const custInvoices = (cust && cust.invoices) ? cust.invoices.length : 0;
    if (flat == null && cust && Array.isArray(cust.payments) && custInvoices === 1) {
        paymentSchedule = cust.payments
            .slice()
            .sort((a, b) => String(a.date).localeCompare(String(b.date)))
            .map(pm => {
                const pFee = pm.isCard ? Math.round((pm.amount * (FEE_PCT / 100) + FEE_FIXED) * 100) / 100 : 0;
                return {
                    date: pm.date, amount: round(pm.amount), method: pm.method || (pm.isCard ? 'card' : ''),
                    fee: pFee, commission: round((pm.amount - pFee) * rate / 100),
                };
            });
    }

    return {
        instalment: invTotal > 0 && invBalance > 0 && invReceived > 0,
        invoiceTotal: invTotal, invoiceReceived: invReceived, invoiceBalance: invBalance,
        outstanding, remainingCommission, paymentSchedule,
        dealId: deal.dealId, client: deal.name, company: deal.company,
        repEmail, repKnown: knownRep,
        ownerEmail: deal.ownerEmail, ownerName: deal.ownerName,
        closerEmail, closerName: (snap && snap.ownerName) || deal.ownerName, ownerChanged,
        dealType, dealTypeAuto: !!(deal.dealType && !(ov && ov.dealType)),
        gross, fee, base, rate: (flat != null) ? null : rate, flat: (flat != null) ? round(flat) : null, commission,
        paidByCard, refunded, refundedAmount: cust ? round(cust.refunded) : 0, clawback, refundDate: cust ? cust.lastRefundDate : '',
        leadSource, splitPlan: houseRate != null, accelerated: false,
        closeDate: deal.closeDate,
        customerId, customerMatched: !!customerId,
        invoiceId: inv ? inv.id : '', invoiceNo: inv ? inv.docNumber : '', invoiceMatched: !!inv,
        invoicePaid, paidDate: (inv && inv.paid) ? inv.date : '',
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
            invoiceId: (b.invoiceId || '').toString() || undefined,
            leadSource: (b.leadSource === 'self' || b.leadSource === 'house') ? b.leadSource : undefined,
            paidOut: (b.paidOut === true || b.paidOut === 'true') ? true : undefined,
            at: Date.now(), by: (who && who.email) || 'admin',
        };
        Object.keys(rec).forEach(k => rec[k] === undefined && delete rec[k]);
        await redis.hset(OVERRIDE_KEY, { [dealId]: JSON.stringify(rec) });
        return res.status(200).json({ ok: true, saved: dealId, override: rec });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    if (req.query.probe === '1') {
        // Named in full on purpose. "hubspot" and "hubstaff" differ by one letter and mean entirely
        // different systems here: HubSpot is the CRM that says who closed the deal, Hubstaff is the
        // time tracker that says how many hours a VA worked. Confusing them wastes a debugging pass.
        const hstaff = await hubstaffStatus().catch(e => ({ connected: false, reason: String(e).slice(0, 120) }));
        return res.status(200).json({
            quickbooks_payments: await qboConnected().catch(() => false),
            hubspot_crm: !!process.env.HUBSPOT_TOKEN,
            hubstaff_hours: hstaff.connected,
            hubstaff_reason: hstaff.connected ? '' : (hstaff.reason || ''),
            qbo: await qboConnected().catch(() => false),   // kept: older callers read these two
            hubspot: !!process.env.HUBSPOT_TOKEN,
        });
    }

    if (!who && !isAdmin) return res.status(401).json({ error: 'login_required' });

    // Reps load FIRST, because a rep's recorded hubspotOwnerId is what lets a deal find its closer
    // when the owners API is unavailable. Loading them in parallel with the deals meant the fallback
    // map was always empty at the moment it was needed.
    const [reps, overrides, ownerSnaps] = await Promise.all([
        listReps().catch(() => []),
        loadOverrides().catch(() => ({})),
        loadOwnerSnapshots().catch(() => ({})),
    ]);
    const ownerIdToRep = {};
    reps.forEach(r => { const id = String(r.hubspotOwnerId || '').trim(); if (id) ownerIdToRep[id] = { email: (r.email || '').toLowerCase(), name: r.name || r.email }; });

    const [hs, qbo] = await Promise.all([
        loadHubspotWon(ownerIdToRep).catch(() => ({ configured: true, error: 'hubspot load failed', deals: [] })),
        loadQboPaid().catch(() => ({ connected: false })),
    ]);
    const repRateByEmail = {};
    reps.forEach(r => { const e = (r.email || '').toLowerCase(); if (e) repRateByEmail[e] = { rate: repRate(r), houseRate: repHouseRate(r), residualPerHour: (r.residualPerHour != null && r.residualPerHour !== '') ? Number(r.residualPerHour) : null }; });

    // A deal that cannot find its rep earns nobody anything, so say so loudly rather than rendering
    // a confident zero. These are the three ways attribution breaks, in the order they bite.
    // Residuals: hours worked by VAs under clients these reps closed. Its own failure surface, so a
    // dead Hubstaff token cannot take the whole commissions page down with it.
    const residualMap = await loadResidualMap();
    const today = new Date().toISOString().slice(0, 10);
    const resStart = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
    const residuals = await buildResiduals(hs.deals || [], repRateByEmail, residualMap, { start: resStart, stop: today })
        .catch(e => ({ connected: false, error: String(e).slice(0, 120), lines: [], unmatched: [] }));

    const unowned = (hs.deals || []).filter(d => !d.ownerEmail);
    const blockers = [];
    if (hs.ownersError) blockers.push({ code: 'owners_scope', detail: hs.ownersError,
        fix: 'The HubSpot private app needs the crm.objects.owners.read scope. Until then a deal can only find its rep through that rep\'s hubspotOwnerId.' });
    if (unowned.length) blockers.push({ code: 'unowned_deals', detail: `${unowned.length} closed-won deal(s) have no HubSpot owner`,
        fix: 'Assign an owner on the deal in HubSpot, or set the rep with an admin override. No owner means no commission for anyone.',
        deals: unowned.slice(0, 20).map(d => ({ dealId: d.dealId, name: d.name, amount: d.amount, closeDate: d.closeDate })) });
    if (!residuals.connected) blockers.push({ code: 'hubstaff_disconnected', detail: (residuals.error || 'Hubstaff is not connected') + (residuals.hint ? ': ' + residuals.hint : ''),
        fix: residuals.hint || 'Generate a Hubstaff personal access token and store it in Redis key hubstaff:refresh_token. Per-hour residuals cannot be tracked until then.' });
    if (residuals.connected && residuals.unmatched && residuals.unmatched.length) blockers.push({ code: 'unmatched_clients',
        detail: `${residuals.unmatched.length} Hubstaff client(s) tracked hours but match no Closed Won deal`,
        fix: 'Map the Hubstaff client name to a deal id in the residual:clientmap hash. Unmatched hours pay no residual to anyone.',
        clients: residuals.unmatched.slice(0, 20) });
    if (!(qbo && qbo.connected)) blockers.push({ code: 'qbo_disconnected', detail: 'QuickBooks is not connected',
        fix: 'Commissions still calculate, but nothing can be marked paid until QBO is connected at /api/quickbooks-oauth-start/.' });

    if (!hs.configured) return res.status(200).json({ connected: false, source: 'hubspot', message: 'HubSpot is not connected yet, so there are no Closed Won deals to track.' });
    if (hs.error) return res.status(200).json({ connected: true, source: 'hubspot', error: hs.error, hint: hs.hint || '', deals: [] });

    // Lock the closer on any deal we are seeing Closed Won for the first time, then attribute to that.
    const snaps = await snapshotNewOwners(hs.deals || [], ownerSnaps, repRateByEmail).catch(() => ownerSnaps);
    // Give each deal its own invoice before pricing anything.
    const assignments = assignInvoices(hs.deals || [], overrides, qbo);
    const lines = (hs.deals || []).map(d => reconcile(d, overrides[d.dealId], qbo, repRateByEmail, snaps[d.dealId], assignments[d.dealId]));
    applyAccelerator(lines);

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
            noInvoice: lines.filter(l => qbo.connected && l.customerMatched && !l.invoiceMatched).length,
            ownerChanged: lines.filter(l => l.ownerChanged).length,
        };
        const custList = qbo.connected ? Object.values(qbo.custById || {}).map(c => ({ id: c.id, name: c.name, email: c.email })) : [];
        return res.status(200).json({
            connected: true, view: 'admin', qboConnected: !!qbo.connected, qboError: qbo.error || '',
            blockers, residuals,
            byRep: ranked,
            truncated: { hubspot: !!hs.truncated, qbo: !!(qbo && qbo.truncated) },
            payoutScan: { vendorsMatched: payouts.vendorsMatched || 0, scanned: payouts.scanned || 0, tagged: payouts.tagged || 0, tag: payouts.tag || 'commission' },
            reps: reps.map(r => ({ email: (r.email || '').toLowerCase(), name: r.name || r.email })),
            customers: custList, counts, deals: lines,
        });
    }

    // ---- Team ranking, and the per-rep roll-up admins see ----
    //
    // Paul, 2026-09-04: he sees everything for every salesperson; a rep sees only their own detail
    // plus a team ranking.
    //
    // ACCESS DECISION, stated so nobody has to guess it later. The ranking a REP sees is built on
    // PRODUCTION (deals won, revenue closed, hours placed), never on a peer's commission dollars or
    // their rate. On a sales floor who is winning is public and what each person is paid is not, and
    // rates differ between reps, so publishing earnings publishes the comp plan. A rep always sees
    // their OWN money in full. Admins see everyone's money. Flip PEER_EARNINGS to true if that
    // changes.
    const PEER_EARNINGS = process.env.COMMISSION_PUBLIC_EARNINGS === 'true';

    const agg = {};
    const bucket = (email) => agg[email] || (agg[email] = {
        repEmail: email, name: '', deals: 0, revenue: 0, commission: 0,
        payable: 0, pending: 0, paidOut: 0, hours: 0, residual: 0,
    });
    lines.forEach(l => {
        if (!l.repEmail) return;
        const t = bucket(l.repEmail);
        t.deals++;
        t.revenue += Number(l.base) || 0;
        t.commission += Number(l.commission) || 0;
        if (l.status === 'payable') t.payable += Number(l.commission) || 0;
        else if (l.status === 'paid_out') t.paidOut += Number(l.commission) || 0;
        else t.pending += Number(l.commission) || 0;
    });
    (residuals.lines || []).forEach(l => {
        if (!l.repEmail) return;
        const t = bucket(l.repEmail);
        t.hours += Number(l.hours) || 0;
        t.residual += Number(l.residual) || 0;
    });
    reps.forEach(r => { const t = agg[(r.email || '').toLowerCase()]; if (t) t.name = r.name || r.email; });
    // A rep with no closed deals still belongs on the board, at the bottom, rather than vanishing.
    reps.forEach(r => { const e = (r.email || '').toLowerCase(); if (e && !agg[e]) { const t = bucket(e); t.name = r.name || r.email; } });

    const ranked = Object.values(agg)
        .map(t => ({ ...t, revenue: round(t.revenue), commission: round(t.commission),
                     payable: round(t.payable), pending: round(t.pending), paidOut: round(t.paidOut),
                     hours: Math.round(t.hours * 10) / 10, residual: Math.round(t.residual * 100) / 100 }))
        .sort((a, b) => b.revenue - a.revenue || b.deals - a.deals)
        .map((t, i) => ({ rank: i + 1, ...t }));

    // What a rep is allowed to see about everyone else.
    const publicRanking = (meEmail) => ranked.map(t => {
        const isMe = t.repEmail === meEmail;
        const row = { rank: t.rank, name: t.name || t.repEmail, deals: t.deals, revenue: t.revenue, hours: t.hours, isMe };
        if (isMe || PEER_EARNINGS) { row.commission = t.commission; row.payable = t.payable; row.residual = t.residual; }
        return row;
    });

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

    // This rep's residual: every hour a VA worked under a client they closed.
    const myResiduals = (residuals.lines || []).filter(l => l.repEmail === meEmail);
    const residualHours = Math.round(myResiduals.reduce((a, l) => a + l.hours, 0) * 10) / 10;
    const residualEarned = Math.round(myResiduals.reduce((a, l) => a + l.residual, 0) * 100) / 100;

    return res.status(200).json({
        connected: true, view: 'rep', qboConnected: !!qbo.connected,
        rep: { name: who.name || who.email, email: who.email, rate: repRate(who),
               residualPerHour: (who.residualPerHour != null && who.residualPerHour !== '') ? Number(who.residualPerHour) : null },
        // A rep must be able to tell "no hours yet" from "we cannot see the hours". Silently showing
        // zero for a broken integration is how a rep quietly stops being paid what they are owed.
        residuals: {
            connected: !!residuals.connected,
            problem: residuals.connected ? '' : (residuals.hint || residuals.error || 'Hubstaff is not connected'),
            hours: residualHours, earned: residualEarned, perHour: (who.residualPerHour != null && who.residualPerHour !== '') ? Number(who.residualPerHour) : null,
            windowStart: resStart, windowEnd: today,
            clients: myResiduals.map(l => ({ client: l.client, hours: l.hours, vaCount: l.vaCount, residual: l.residual, note: l.note })),
        },
        team: publicRanking(meEmail),
        teamMetric: PEER_EARNINGS ? 'earnings visible' : 'ranked on revenue closed; peer earnings hidden',
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
