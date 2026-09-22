// WHAT THIS OPPORTUNITY ACCEPTED, not one global number.
//
// `_pilot-payment.js` used to compare every onboarding invoice against a single env default
// (PILOT_ONBOARDING_AMOUNT || 2499). That is wrong in both directions: an owner who accepted the
// deferred arrangement has no upfront invoice to settle at all, and any variation from the default
// reads as "wrong amount" rather than "these are their terms".
//
// Two published arrangements, and they do not activate the same way:
//
//   CASH_UPFRONT  onboarding is paid before we start. Activation is a settled onboarding invoice.
//   DEFERRED      onboarding is carried on the hourly rate until it is paid off. There is no
//                 upfront invoice, so a payment event can never activate it. Activation is the
//                 placement actually starting, and the balance stays owed if they stop early.
//
// Keeping these apart is the whole point. Collapsing them is how a deferred owner gets marked
// unpaid forever, or how a payment for something else gets read as their onboarding.

export const TERMS = Object.freeze({
    CASH_UPFRONT: Object.freeze({
        label: 'Onboarding paid upfront',
        activatedBy: 'PAYMENT',
        needs: ['activationReference'],
        evidence: 'a settled onboarding invoice in QuickBooks, verified by reference',
    }),
    DEFERRED: Object.freeze({
        label: 'Onboarding carried on the hourly rate',
        activatedBy: 'PLACEMENT_START',
        needs: ['placementStartedAt', 'placementRef'],
        evidence: 'the placement actually starting, with the person and start date recorded',
    }),
});

export const TERM_KINDS = Object.freeze(Object.keys(TERMS));

/** The published upfront onboarding price, in cents. Still the default, no longer the only answer. */
export const publishedOnboardingCents = () =>
    Math.round(Number(process.env.PILOT_ONBOARDING_AMOUNT || 2499) * 100);

const S = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
// PER OPPORTUNITY, not per customer. A customer with two deals would otherwise have the second
// deal's terms overwrite the first, and a payment on the older invoice would be measured against
// the newer arrangement.
export const termsKey = (realm, invoiceId) => `pilot:terms:${realm}:invoice:${invoiceId}`;
export const legacyTermsKey = (realm, customerId) => `pilot:terms:${realm}:customer:${customerId}`;

/**
 * Validate terms somebody is recording as accepted. Their own words are required, for the same
 * reason a closed request needs them: an arrangement nobody can quote is an assumption.
 * @returns {{ok:true, record:object}|{ok:false, error:string}}
 */
export function validateTerms(input = {}) {
    const kind = S(input.kind, 20).toUpperCase();
    if (!TERMS[kind]) return { ok: false, error: `terms must be one of ${TERM_KINDS.join(' or ')}` };
    const acceptedWords = S(input.acceptedWords, 1200);
    if (!acceptedWords) return { ok: false, error: 'record what they agreed to, in their words' };
    const acceptedBy = S(input.acceptedBy, 80);
    if (!acceptedBy) return { ok: false, error: 'name who accepted, on their side' };

    const record = {
        kind,
        acceptedAt: S(input.acceptedAt, 40) || new Date().toISOString(),
        acceptedWords, acceptedBy,
        recordedBy: S(input.recordedBy, 60) || 'Paul',
    };
    if (kind === 'CASH_UPFRONT') {
        const cents = Number.isFinite(Number(input.cents)) ? Math.round(Number(input.cents)) : publishedOnboardingCents();
        if (cents <= 0) return { ok: false, error: 'an upfront amount must be positive' };
        record.cents = cents;
    } else {
        // Deferred carries the same total on the rate; an upfront amount here would be a fiction.
        record.cents = 0;
        const perHour = Number(input.carryPerHour);
        if (!Number.isFinite(perHour) || perHour <= 0) return { ok: false, error: 'deferred terms need the per-hour carry that was agreed' };
        record.carryPerHour = perHour;
        record.carryBalanceCents = Number.isFinite(Number(input.carryBalanceCents))
            ? Math.round(Number(input.carryBalanceCents)) : publishedOnboardingCents();
    }
    return { ok: true, record };
}

/**
 * The accepted terms for one opportunity, or null when nothing was recorded.
 * Null is not an error and not a default: the caller decides what an unrecorded arrangement means,
 * and the payment gate marks that verdict as assumed rather than accepted.
 */
export async function acceptedTerms({ customerId, invoiceId, realm } = {}, deps = {}) {
    const { redis } = deps;
    const company = S(realm || process.env.QB_REALM_ID, 40);
    const inv = S(invoiceId, 60);
    const cust = S(customerId, 60);
    if (!redis || !company) return null;

    const read = async (key) => {
        try { return await redis.hgetall(key); }
        // A failed read is unknown, never "no terms". Throwing lets the gate mark the verdict
        // retryable instead of silently falling back to the published default.
        catch (e) { throw new Error(`accepted terms unreadable: ${String((e && e.message) || e).slice(0, 120)}`); }
    };

    let raw = inv ? await read(termsKey(company, inv)) : null;
    if (!raw || !raw.kind) {
        // Compatibility with terms recorded before they were scoped, and ONLY when that record
        // names this same invoice. A customer-scoped record that names a different deal, or names
        // none at all, is ambiguous, and ambiguous terms must not be applied to a payment.
        const legacy = cust ? await read(legacyTermsKey(company, cust)) : null;
        raw = legacy && legacy.kind && inv && S(legacy.invoiceId, 60) === inv ? legacy : null;
    }
    if (!raw || !raw.kind || !TERMS[raw.kind]) return null;
    return {
        kind: raw.kind,
        cents: Number(raw.cents || 0),
        acceptedAt: raw.acceptedAt || '',
        acceptedBy: raw.acceptedBy || '',
        carryPerHour: raw.carryPerHour ? Number(raw.carryPerHour) : undefined,
    };
}

/** What would have to be true for this arrangement to count as activated. */
export function activationRequirement(kind) {
    const t = TERMS[S(kind, 20).toUpperCase()];
    return t ? { activatedBy: t.activatedBy, needs: t.needs, evidence: t.evidence } : null;
}

/**
 * Is this activation evidence sufficient for these terms?
 * Cash activates on a verified payment reference; deferred activates on a real placement start.
 * Neither may borrow the other's evidence.
 */
export function validateActivation(kind, evidence = {}) {
    const k = S(kind, 20).toUpperCase();
    const t = TERMS[k];
    if (!t) return { ok: false, error: 'unknown terms' };
    if (k === 'CASH_UPFRONT') {
        const ref = S(evidence.activationReference, 300);
        if (!/^qbo:.+:invoice:.+:payment:.+$/.test(ref)) {
            return { ok: false, error: 'upfront onboarding activates on a verified QuickBooks payment reference' };
        }
        return { ok: true, patch: { activationKind: k, activationReference: ref, activatedAt: S(evidence.activatedAt, 40) || new Date().toISOString() } };
    }
    const startedAt = S(evidence.placementStartedAt, 40);
    const ref = S(evidence.placementRef, 200);
    if (!startedAt || !ref) {
        return { ok: false, error: 'deferred onboarding activates when the placement starts: record the start date and who started' };
    }
    return { ok: true, patch: { activationKind: k, placementStartedAt: startedAt, placementRef: ref,
        activatedAt: startedAt } };
}
