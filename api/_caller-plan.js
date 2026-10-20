// Trial pay terms for a caller seat. Separate from the owners' percentage and residual plans,
// and never reusing them.
// ------------------------------------------------------------------
// Confirmed by Paul for Milton's written trial. Every figure here came from him directly; nothing
// is inferred, and the fields he left open are left open. A blank payday on screen is honest. A
// guessed one is a promise the company has not made.
export const CALLER_PLANS = {
    'miltion@trystaffify.com': Object.freeze({
        name: 'Milton',
        version: '2026-10-20-trial',
        weeklyBase: 160,
        biweeklyBase: 320,
        // Per SEPARATE qualifying onboarding fee, and only once the funds have cleared. Not on
        // signature, not on invoice, not on payment received.
        onboardingCommission: 650,
        // No residuals during the trial. Zero is a decision, not a missing value.
        residualPerHour: 0,
        trialStart: '2026-10-26',
        trialEnd: '2026-11-24',
        // Fixed offset, deliberately not "Eastern": it does not shift with daylight saving.
        schedule: 'Monday to Friday, 4pm to 8pm, fixed UTC-5',
        firstPayday: null,
        payrollCutoff: null,
        // Calling was authorised from the 20th, six days before the written trial opens. That gap
        // decides whether a deal booked in those six days earns the fee, and it is Paul's to
        // settle, so it is surfaced rather than resolved either way.
        callingFrom: '2026-10-20',
    }),
};

export const callerPlan = email => CALLER_PLANS[String(email || '').trim().toLowerCase()] || null;
export const hasCallerPlan = email => !!callerPlan(email);

/** What has to be true before a fee is owed. Shown to the caller so the bar is not a mystery. */
export const ELIGIBILITY = Object.freeze([
    'The onboarding fee is collected in full. No financing, instalments or discounts.',
    'The funds have cleared, not merely been received.',
    'It is a separate qualifying onboarding fee. One fee, one commission.',
    'The booking is attributed to you in the CRM.',
]);

/**
 * The trial window stated plainly, including the gap between calling and the written start.
 * Returns strings only; no dates are invented where Paul left them open.
 */
export function planSummary(plan, now = new Date()) {
    if (!plan) return null;
    const today = now.toISOString().slice(0, 10);
    return {
        ...plan,
        started: today >= plan.trialStart,
        // Both true at once between the 20th and the 26th, which is exactly the thing to flag.
        callingBeforeTrial: today >= plan.callingFrom && today < plan.trialStart,
        paydayKnown: !!plan.firstPayday,
        eligibility: ELIGIBILITY,
    };
}
