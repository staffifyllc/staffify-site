// Trial pay terms for a caller seat, taken from the SIGNED agreement.
// ------------------------------------------------------------------
// Source of truth: Staffify_Agreement_Milton_Signed.pdf, Sales Representative Services Agreement,
// signed by Milton Hodgson Gaitan on October 20, 2026. Section and clause numbers below refer to
// that document. Section 15 states the agreement supersedes prior discussions "including earlier
// commission-only proposals, different base compensation amounts, or trial residuals", so figures
// relayed from any earlier conversation do not belong here.
//
// Nothing in this file is inferred. Where the agreement leaves something to be provided later,
// it stays null and the screen says so.
export const CALLER_PLANS = {
    'milton@trystaffify.com': Object.freeze({
        name: 'Milton',
        legalName: 'Milton Hodgson Gaitan',
        // How this person is written on a client account in the finance ledger
        // (finance:account-owners:v1 -> rep). It is what ties the signed plan below to the QBO
        // evidence, so one attribution decides both his view and Paul's.
        handle: 'milton',
        version: '2026-10-20-signed',
        source: 'Sales Representative Services Agreement, signed 2026-10-20',

        // 5.1 Weekly Base Compensation. Not contingent on sales, booked calls, onboarding fees or
        // client payments.
        weeklyBase: 200,
        biweeklyBase: 400,
        weeklyHours: 20,

        // 5.2 Onboarding Commission. Flat, per qualifying onboarding fee actually COLLECTED.
        onboardingCommission: 400,
        commissionCapped: false,                 // 5.2 "There is no cap on qualifying commissions."
        mustClosePersonally: false,              // 5.2 "does not need to conduct the closing call personally"

        // 5.4 No separate appointment fee, and no residuals during the trial.
        appointmentFee: 0,
        residualPerHour: 0,

        // 1. Start Date and Trial Period. A 30-day paid trial.
        trialStart: '2026-10-20',
        trialEnd: '2026-11-18',

        // 3. Fixed UTC-5, explicitly not shifting with daylight saving.
        schedule: 'Monday to Friday, 4:00pm to 8:00pm EST (fixed UTC-5), 20 hours a week',

        // 5.3 The company provides the payment calendar and processing cutoff before services
        // begin. Not yet supplied, so not invented here.
        firstPayday: null,
        payrollCutoff: null,

        // 4. Bookings go through Paul's link. Using another one needs written authorization.
        bookingLink: 'https://calendly.com/go-staffify/discovery-call',

        // 6. Discovery calls booked before the trial ends stay commissionable if the client signs
        // within 90 days of that date. Collection may happen later.
        postTrialAttributionDays: 90,
    }),
};

// The agreement names milton@trystaffify.com (Section 14). The Hub account was provisioned as
// "miltion", a misspelling. Both resolve so he can actually see his own pay, and the mismatch is
// reported rather than quietly normalised: the contract address is the one that governs.
const PROVISIONED_ALIAS = 'miltion@trystaffify.com';
const CONTRACT_EMAIL = 'milton@trystaffify.com';
export const callerPlan = email => {
    const e = String(email || '').trim().toLowerCase();
    if (e === PROVISIONED_ALIAS) return CALLER_PLANS[CONTRACT_EMAIL];
    return CALLER_PLANS[e] || null;
};
export const hasCallerPlan = email => !!callerPlan(email);

// By ledger handle rather than by login, for the finance side.
const BY_HANDLE = Object.fromEntries(Object.values(CALLER_PLANS).filter(p => p.handle).map(p => [p.handle, p]));
export const callerPlanByHandle = handle => BY_HANDLE[String(handle || '').trim().toLowerCase()] || null;
export const CALLER_HANDLES = Object.keys(BY_HANDLE);

/**
 * 5.2: a FLAT fee per qualifying onboarding fee collected, not a share of it. Returns the dollar
 * amount for a rep on a flat trial plan, or null for a percentage rep (Paul, Madison), which is
 * what the commission ladder keys off.
 */
export const flatOnboardingCommission = handle => {
    const plan = callerPlanByHandle(handle);
    return plan && Number.isFinite(plan.onboardingCommission) ? plan.onboardingCommission : null;
};
// Address aliases live in _login-aliases.js, which the sign-in path reads too, so one
// provisioning mistake is recorded in exactly one place.
export { loginAliases } from './_login-aliases.js';

export const emailMismatch = email =>
    String(email || '').trim().toLowerCase() === PROVISIONED_ALIAS
        ? { signedIn: PROVISIONED_ALIAS, onContract: CONTRACT_EMAIL }
        : null;

// Who actually works a campaign's calls.
// ------------------------------------------------------------------
// Paul, 2026-10-22, reading a Spearhead script that opened "this is Paul Chareth with Staffify":
// "its going to be Milton with Staffify, I will not be calling."
//
// The script was naming whoever was LOOKING at the page. Paul reviews these lists; he does not
// dial them. A script that puts the reviewer's name in the caller's mouth is wrong on the page and
// wrong on the phone, so the name comes from who will make the call, never from who is reading.
export const CAMPAIGN_CALLERS = Object.freeze({
    'staffify-tobit-outreach': 'milton@trystaffify.com',
});
export const designatedCaller = campaignId => CAMPAIGN_CALLERS[String(campaignId || '').trim()] || null;

/** 5.2 and 6: everything that must be true before a commission is owed. */
export const ELIGIBILITY = Object.freeze([
    'The business is attributed to you in HubSpot, from the discovery call you booked and recorded.',
    'The client has signed the applicable service agreement with Staffify.',
    'Staffify has received the onboarding fee IN FULL, in cleared funds. A signed agreement, an issued invoice, a booked call or an expected payment does not create a payable commission.',
    'Each separate onboarding fee earns its own commission. Instalments toward one fee do not create more than one.',
]);

export function planSummary(plan, now = new Date()) {
    if (!plan) return null;
    const today = now.toISOString().slice(0, 10);
    return {
        ...plan,
        started: today >= plan.trialStart,
        ended: today > plan.trialEnd,
        paydayKnown: !!plan.firstPayday,
        eligibility: ELIGIBILITY,
    };
}
