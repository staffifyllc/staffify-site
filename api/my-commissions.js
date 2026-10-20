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
// GET /api/my-commissions/ -> { plan, credited:[], totals, notes }
import { requireAccess, redis } from './_auth.js';
import { callerPlan, planSummary } from './_caller-plan.js';

// Written only by the owner attribution path. A caller can read their own row and nothing more.
const CREDITED_KEY = 'finance:caller-onboardings:v1';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
        const rep = await requireAccess(req);
        if (!rep || !rep.email) return res.status(401).json({ error: 'Sign in to your Staffify account' });

        const email = String(rep.email).toLowerCase();
        const plan = callerPlan(email);
        if (!plan) return res.status(404).json({ error: 'No trial plan is on file for this account', name: rep.name || null });

        // Their own credited fees. Filtered by the session's address, never by a parameter, so
        // there is no shape of request that returns somebody else's.
        let credited = [];
        try {
            const raw = (await redis.hgetall(CREDITED_KEY)) || {};
            credited = Object.values(raw)
                .map(v => (typeof v === 'string' ? JSON.parse(v) : v))
                .filter(x => x && String(x.email || '').toLowerCase() === email)
                .sort((a, b) => String(b.clearedAt || '').localeCompare(String(a.clearedAt || '')));
        } catch { credited = []; }

        const summary = planSummary(plan);
        const earned = credited.filter(c => c.status === 'cleared').length * plan.onboardingCommission;
        const pending = credited.filter(c => c.status !== 'cleared').length;

        return res.status(200).json({
            name: plan.name,
            plan: summary,
            credited: credited.map(c => ({
                client: c.client || null, status: c.status || 'pending',
                bookedAt: c.bookedAt || null, clearedAt: c.clearedAt || null,
                amount: c.status === 'cleared' ? plan.onboardingCommission : 0,
            })),
            totals: {
                commissionCleared: earned,
                awaitingClearance: pending,
                // Base pay is owed for hours worked and is not computed here. Showing a running
                // base total would imply this page is the payroll record, and it is not.
                baseWeekly: plan.weeklyBase, baseBiweekly: plan.biweeklyBase,
            },
            notes: [
                'Eligible commission is not proof of payout. Payroll confirms every payment.',
                'There are no automatic bank transfers from this view.',
                ...(summary.paydayKnown ? [] : ['The first payday and the payroll cutoff are not set yet.']),
                ...(summary.callingBeforeTrial
                    ? [`Calling was authorised from ${plan.callingFrom}, and the written trial opens ${plan.trialStart}. Whether a fee booked before ${plan.trialStart} qualifies is with Paul.`]
                    : []),
            ],
        });
    } catch (e) {
        return res.status(503).json({ error: 'Your pay view is unavailable right now. ' + String((e && e.message) || e).slice(0, 100) });
    }
}
