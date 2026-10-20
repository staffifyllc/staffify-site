// A caller's OWN pay view. Their plan, their credited fees, nothing else.
// ------------------------------------------------------------------
// Paul, 2026-10-20: Milton clicking Commissions hit "Private to Paul and Madison" and a sign-in
// prompt. That gate is correct and stays: the owner view carries every rep's earnings, company
// revenue totals and the comp plans, and a caller has no business in it.
//
// This is the other half. It answers for exactly one person, the one holding the session, and it
// reads nothing that could leak somebody else. It does not call the owner finance endpoints, it
// does not compute company totals, and there is no parameter that lets a caller ask about anyone
// but themselves.
//
// It reads the SAME ledger the owner view reads, filtered to his own accounts, so his page and
// Paul's page can never disagree about what he has earned. The earlier version read a separate
// hand-entered store that nothing ever wrote, which is why both screens showed nothing at all.
//
// GET /api/my-commissions/ -> { plan, credited:[], totals, notes }
import { requireAccess, redis } from './_auth.js';
import { callerPlan, planSummary, emailMismatch } from './_caller-plan.js';

// Built by /api/account-commissions/ from QBO invoices, payments and verified settlements.
const LEDGER = 'finance:account-ledger:v1';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
        const rep = await requireAccess(req);
        if (!rep || !rep.email) return res.status(401).json({ error: 'Sign in to your Staffify account' });

        const email = String(rep.email).toLowerCase();
        const plan = callerPlan(email);
        if (!plan) return res.status(404).json({ error: 'No trial plan is on file for this account', name: rep.name || null });

        // His own accounts, by the handle on his plan. Filtered from the session's plan, never from
        // a parameter, so there is no shape of request that returns somebody else's.
        let mine = [], ledgerAt = null, ledgerReadable = true;
        try {
            const snap = await redis.get(LEDGER);
            if (!snap || !Array.isArray(snap.accounts)) ledgerReadable = false;
            else {
                ledgerAt = snap.updatedAt || null;
                mine = snap.accounts.filter(a => String(a.rep || '').toLowerCase() === plan.handle);
            }
        } catch { ledgerReadable = false; }

        // One line per invoice that carries a commission. Only his own fields are copied across:
        // no company revenue, no other rep, no customer list.
        const credited = mine.flatMap(a => (a.invoices || [])
            .filter(i => (i.placementEarned || 0) > 0 || (i.placementPending || 0) > 0)
            .map(i => ({
                client: a.contactName ? a.contactName + ' / ' + a.name : a.name,
                invoice: i.number || null,
                date: i.date || null,
                status: (i.placementEarned || 0) > 0 ? 'cleared' : 'pending',
                amount: i.placementEarned || 0,
                awaiting: (i.placementEarned || 0) > 0 ? 0 : (i.placementPending || 0),
                collection: i.status || null,
                funds: i.cashStatus || null,
                earliestPayroll: i.payrollDate || null,
                holds: Array.isArray(i.holds) ? i.holds : [],
            })))
            .sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')));

        const sum = k => Math.round(mine.reduce((n, a) => n + (a[k] || 0), 0) * 100) / 100;
        const summary = planSummary(plan);
        const mismatch = emailMismatch(email);

        return res.status(200).json({
            name: plan.name,
            plan: summary,
            ledger: { readable: ledgerReadable, updatedAt: ledgerAt, accounts: mine.length },
            credited,
            emailOnRecord: mismatch,
            totals: {
                commissionCleared: sum('placementEarned'),
                awaitingCollection: sum('placementPending'),
                clearedForPayroll: sum('placementCashEligible'),
                // Base pay is owed for hours worked and is not computed here. Showing a running
                // base total would imply this page is the payroll record, and it is not.
                baseWeekly: plan.weeklyBase, baseBiweekly: plan.biweeklyBase,
            },
            source: plan.source,
            notes: [
                ...(ledgerReadable ? [] : ['The finance ledger could not be read just now, so these figures are not current. They are not a statement that you have earned nothing.']),
                ...(ledgerReadable && !mine.length ? ['No client account is attributed to you yet. A commission appears here once Paul attributes the account and the onboarding fee is collected.'] : []),
                'Eligible commission is not proof of payout. Payroll confirms every payment.',
                'There are no automatic bank transfers from this view.',
                // 5.3: the company owes him this before services begin, so the gap is named.
                ...(summary.paydayKnown ? [] : ['Staffify provides the payment calendar and processing cutoff before services begin. Not supplied yet.']),
                // 6: work booked before the trial ends keeps its commission if the client signs inside the window.
                `A discovery call you book and record before ${plan.trialEnd} stays commissionable if the client signs within ${plan.postTrialAttributionDays} days of that date. Collection can happen later.`,
                // 4: using a different scheduling link needs written authorization.
                `All discovery calls are booked through ${plan.bookingLink}. Another link needs written authorization.`,
                ...(mismatch ? [`You are signed in as ${mismatch.signedIn}, and the agreement names ${mismatch.onContract}. The contract address governs; ask Paul to reconcile the login.`] : []),
            ],
        });
    } catch (e) {
        return res.status(503).json({ error: 'Your pay view is unavailable right now. ' + String((e && e.message) || e).slice(0, 100) });
    }
}
