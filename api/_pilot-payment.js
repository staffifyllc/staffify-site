// PAID MEANS A PAYMENT A PERSON LINKED, IN THE RIGHT COMPANY, AGAINST THE RIGHT INVOICE.
//
// The existing quickbooks-webhook treats ANY Payment for a known subscriber as onboarding complete:
// no check of which invoice, which realm, how much, or whether the balance cleared. This module does
// not reuse it, call it, or accept its conclusion. A CRM stage called Won is not payment either.
//
// Searching by email or company and then calling the best hit "paid" has the same disease in a
// quieter form: an existing client's onboarding invoice from March would happily answer for an
// inquiry made in September. So there is no search-then-conclude path here at all.
//
//   findPaymentCandidates()  offers customers and invoices for a PERSON to link. Never a verdict.
//   verifyLinkedPayment()    verifies the one invoice somebody explicitly linked, and nothing else.
//
// Without a link the answer is `needs-link`, with the candidates attached. Nothing here creates an
// invoice, a payment or a charge; every call is a read.
//
// QUERY SEMANTICS: QuickBooks does not reliably support filtering or projecting on PrimaryEmailAddr,
// so candidates are fetched with a plain select and matched in JavaScript. That is slower and it is
// the only version whose behaviour we can actually predict.

export const approvedItem = () => String(process.env.PILOT_ONBOARDING_ITEM || 'onboarding');
export const approvedAmount = () => Number(process.env.PILOT_ONBOARDING_AMOUNT || 2499);
const cents = (n) => Math.round(Number(n || 0) * 100);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k) && o[k] !== null && o[k] !== undefined && o[k] !== '';
const VOID = (t) => /voided|deleted/i.test(String((t && (t.PrivateNote || t.TxnStatus)) || ''));

function normCompany(v) {
    return String(v || '').toLowerCase()
        .replace(/\b(llc|inc|ltd|co|corp|company|studios?|media|group|productions?)\b/g, '')
        .replace(/[^a-z0-9]/g, '');
}

async function realmOf(deps) {
    const { getRealmId, expectedRealm = () => process.env.QB_REALM_ID || '' } = deps;
    const realm = String((await getRealmId()) || '');
    const want = String(expectedRealm() || '');
    if (!realm) return { ok: false, status: 'not-configured', why: 'no QuickBooks company id is available' };
    if (want && realm !== want) {
        return { ok: false, status: 'wrong-realm', why: `connected to QuickBooks company ${realm}, not the expected ${want}` };
    }
    return { ok: true, realm };
}

/**
 * Customers and onboarding invoices that MIGHT belong to this prospect, ranked, with the reason for
 * each. Never a verdict: an email match is a strong candidate and a company-name match is a weak
 * one, and neither is identity until a person says so.
 */
export async function findPaymentCandidates({ email, company, since }, deps) {
    const { qboConnected, qboQuery } = deps;
    if (!(await qboConnected())) return { status: 'not-configured', why: 'QuickBooks is not connected' };
    const r = await realmOf(deps);
    if (!r.ok) return r;

    let customers = [];
    try {
        const q = await qboQuery('select * from Customer maxresults 1000');
        customers = (q && q.QueryResponse && q.QueryResponse.Customer) || [];
    } catch (e) {
        return { status: 'unknown', realm: r.realm, why: `QuickBooks did not answer: ${String((e && e.message) || e).slice(0, 120)}` };
    }
    const wantEmail = String(email || '').toLowerCase().trim();
    const wantCompany = normCompany(company);
    const scored = [];
    for (const c of customers) {
        const cEmail = String((c.PrimaryEmailAddr && c.PrimaryEmailAddr.Address) || '').toLowerCase().trim();
        if (wantEmail && cEmail === wantEmail) { scored.push({ id: c.Id, name: c.DisplayName, match: 'email', strength: 'strong' }); continue; }
        if (wantCompany && wantCompany.length >= 4 && normCompany(c.DisplayName) === wantCompany) {
            scored.push({ id: c.Id, name: c.DisplayName, match: 'company name', strength: 'weak' });
        }
    }
    if (!scored.length) return { status: 'no-candidates', realm: r.realm, why: 'no QuickBooks customer matches this address or company' };

    const item = approvedItem().toLowerCase();
    const out = [];
    for (const cand of scored.slice(0, 5)) {
        let invoices = [];
        try {
            const q = await qboQuery(`select * from Invoice where CustomerRef = '${String(cand.id).replace(/'/g, "''")}'`);
            invoices = (q && q.QueryResponse && q.QueryResponse.Invoice) || [];
        } catch (e) { return { status: 'unknown', realm: r.realm, why: 'the invoice query failed' }; }
        for (const inv of invoices) {
            const lines = JSON.stringify(inv.Line || []).toLowerCase();
            if (!lines.includes(item)) continue;
            const tooOld = since && inv.TxnDate && Date.parse(inv.TxnDate) < Date.parse(since);
            out.push({
                customerId: cand.id, customerName: cand.name, customerMatch: cand.match, strength: cand.strength,
                invoiceId: inv.Id, invoiceNumber: inv.DocNumber || '', txnDate: inv.TxnDate || '',
                total: Number(inv.TotalAmt || 0),
                balanceKnown: has(inv, 'Balance'), balance: has(inv, 'Balance') ? Number(inv.Balance) : null,
                predatesRequest: !!tooOld,
                note: tooOld ? 'this invoice predates the inquiry, so it is almost certainly a different piece of work' : '',
            });
        }
    }
    if (!out.length) return { status: 'no-candidates', realm: r.realm, why: `no invoice on a matching customer mentions "${approvedItem()}"` };
    return { status: 'candidates', realm: r.realm, candidates: out,
        why: 'these are candidates, not identity. Link the right one before anything can be called paid.' };
}

/**
 * Verify the one invoice a person explicitly linked. `link` is { realm, customerId, invoiceId }.
 * Everything must line up or the answer is not paid.
 */
export async function verifyLinkedPayment(link, deps) {
    const { qboConnected, qboQuery } = deps;
    if (!link || !link.invoiceId || !link.customerId) {
        return { status: 'needs-link', why: 'nobody has linked a QuickBooks invoice to this request yet' };
    }
    if (!(await qboConnected())) return { status: 'not-configured', why: 'QuickBooks is not connected' };
    const r = await realmOf(deps);
    if (!r.ok) return r;
    if (link.realm && String(link.realm) !== r.realm) {
        return { status: 'wrong-realm', why: `this request was linked to QuickBooks company ${link.realm}, but we are connected to ${r.realm}` };
    }

    let inv = null;
    try {
        const q = await qboQuery(`select * from Invoice where Id = '${String(link.invoiceId).replace(/'/g, "''")}'`);
        inv = ((q && q.QueryResponse && q.QueryResponse.Invoice) || [])[0] || null;
    } catch (e) { return { status: 'unknown', realm: r.realm, why: 'the invoice could not be read' }; }
    if (!inv) return { status: 'unmatched', realm: r.realm, why: 'the linked invoice no longer exists in this company' };
    if (VOID(inv)) return { status: 'void', realm: r.realm, why: 'the linked invoice is voided or deleted' };

    const custId = String((inv.CustomerRef && (inv.CustomerRef.value || inv.CustomerRef)) || '');
    if (custId !== String(link.customerId)) {
        return { status: 'mismatched', realm: r.realm, why: `the linked invoice belongs to customer ${custId}, not the linked customer ${link.customerId}` };
    }
    const item = approvedItem().toLowerCase();
    const onboardingLines = (inv.Line || []).filter((l) => JSON.stringify(l).toLowerCase().includes(item));
    if (!onboardingLines.length) {
        return { status: 'not-onboarding', realm: r.realm, why: `the linked invoice has no line matching the approved item "${approvedItem()}"` };
    }
    const lineTotal = onboardingLines.reduce((s, l) => s + cents(l.Amount), 0);
    if (lineTotal !== cents(approvedAmount())) {
        return { status: 'wrong-amount', realm: r.realm, invoiceId: inv.Id, invoiceNumber: inv.DocNumber || '',
            why: `the onboarding lines total ${(lineTotal / 100).toFixed(2)}, not the approved ${approvedAmount().toFixed(2)}` };
    }
    // A missing balance is missing, not zero. Treating it as zero is how an unpaid invoice reads paid.
    if (!has(inv, 'Balance')) {
        return { status: 'unknown', realm: r.realm, invoiceId: inv.Id, why: 'the invoice came back with no balance field, so its state cannot be established' };
    }

    let payments = [];
    try {
        const q = await qboQuery(`select * from Payment where CustomerRef = '${String(link.customerId).replace(/'/g, "''")}'`);
        payments = (q && q.QueryResponse && q.QueryResponse.Payment) || [];
    } catch (e) { return { status: 'unknown', realm: r.realm, why: 'the payment query failed' }; }

    const live = payments.filter((p) => !VOID(p));
    let applied = 0;
    const used = [];
    for (const p of live) {
        for (const l of p.Line || []) {
            const hit = (l.LinkedTxn || []).some((t) => String(t.TxnId) === String(inv.Id) && String(t.TxnType) === 'Invoice');
            if (!hit) continue;
            applied += cents(l.Amount);
            used.push({ id: p.Id, date: p.TxnDate || '', amount: Number(l.Amount || 0) });
        }
    }
    const total = cents(inv.TotalAmt);
    if (!used.length) {
        return { status: cents(inv.Balance) === 0 ? 'settled-without-payment' : 'unpaid', realm: r.realm,
            invoiceId: inv.Id, invoiceNumber: inv.DocNumber || '', total: Number(inv.TotalAmt || 0),
            balance: Number(inv.Balance), why: cents(inv.Balance) === 0
                ? 'the invoice shows a zero balance with no live payment linked to it, which is what a credit memo, a write-off or a voided payment looks like'
                : 'no payment is linked to the onboarding invoice' };
    }
    if (applied < total || cents(inv.Balance) !== 0) {
        return { status: 'partial', realm: r.realm, invoiceId: inv.Id, invoiceNumber: inv.DocNumber || '',
            total: Number(inv.TotalAmt || 0), paid: applied / 100, balance: Number(inv.Balance), payments: used,
            why: `live payments applied to the onboarding invoice total ${(applied / 100).toFixed(2)} of ${Number(inv.TotalAmt).toFixed(2)}, balance ${Number(inv.Balance).toFixed(2)}` };
    }

    const latest = used.sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    return {
        status: 'paid', realm: r.realm, customerId: link.customerId,
        invoiceId: inv.Id, invoiceNumber: inv.DocNumber || '', txnDate: inv.TxnDate || '',
        paymentId: latest.id, paymentDate: latest.date, total: Number(inv.TotalAmt || 0), paid: applied / 100,
        reference: `qbo:${r.realm}:customer:${link.customerId}:invoice:${inv.Id}:payment:${latest.id}`,
        why: `onboarding invoice ${inv.DocNumber || inv.Id} for ${approvedAmount().toFixed(2)} settled by linked payment ${latest.id} on ${latest.date || 'an unrecorded date'}`,
    };
}

/** Only an explicit paid verdict carrying a full reference may be written as payment evidence. */
export function isVerifiedPaid(v) {
    return !!(v && v.status === 'paid' && typeof v.reference === 'string' && /^qbo:.+:invoice:.+:payment:.+$/.test(v.reference));
}
