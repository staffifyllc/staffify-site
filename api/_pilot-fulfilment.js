// WHAT HAPPENS AFTER THEY SAY YES, and what each step demands before it may be claimed.
//
// The pilot model used to stop at payment. So a client who paid and then received nothing looked
// identical to a client who paid and was delivered a working placement, and neither could be told
// apart from a deferred owner who has paid nothing yet and owes the whole onboarding fee on their
// rate. Three different situations, one indistinguishable "paid" flag.
//
// Four steps, each with evidence that a person has to type:
//
//   TERMS_ACCEPTED  they agreed to an arrangement, in their words, and we recorded which one
//   ACTIVATED       cash: a verified settled onboarding invoice
//                   deferred: the placement actually started, with the person and the date
//   FIRST_VALUE     the client accepted a real deliverable. Not "we sent it". They took it.
//   REVIEW_30       somebody asked them, about a month in, and wrote down what they said
//
// The rule that keeps the rest honest: DEFERRED IS NEVER FULLY PAID UNTIL THE CARRY IS CLEARED.
// A deferred owner is activated, is being served, and still owes the balance. Those are separate
// facts and this module refuses to collapse them.

import { TERMS, validateActivation } from './_pilot-terms.js';

export const FULFILMENT_STATES = Object.freeze({
    TERMS_ACCEPTED: { needs: ['acceptedTermsKind', 'acceptedAt', 'acceptedWords', 'acceptedBy'],
        label: 'Terms accepted' },
    ACTIVATED: { needs: ['activationKind', 'activatedAt'], label: 'Activated' },
    FIRST_VALUE: { needs: ['firstValueAt', 'firstValueRef', 'firstValueAcceptedBy'],
        label: 'First deliverable accepted' },
    REVIEW_30: { needs: ['reviewAt', 'reviewResult', 'reviewEvidence'], label: '30-day review done' },
});

export const REVIEW_RESULTS = Object.freeze(['WORKING', 'MIXED', 'NOT_WORKING', 'ENDED', 'NO_ANSWER']);
// A review nobody answered has nothing to quote, so it is the one result that needs no words from
// them. Every other result is a claim about what they think, and a claim needs a source.
export const WORDLESS_REVIEWS = Object.freeze(['NO_ANSWER']);

const S = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const intCents = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
    if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; }
    return null;
};
const isVerifiedRef = (v) => /^qbo:.+:invoice:.+:payment:.+$/.test(S(v, 300));

/**
 * The money, with cash and deferred kept apart.
 * `fullyPaid` is deliberately hard to earn: cash needs a verified reference, deferred needs the
 * carried balance actually cleared. Neither can borrow the other's evidence.
 */
export function balanceOf(rec = {}) {
    const kind = S(rec.acceptedTermsKind, 20).toUpperCase();
    const cashPaid = isVerifiedRef(rec.paymentReference) || isVerifiedRef(rec.activationReference);
    const agreed = intCents(rec.acceptedAmountCents);
    const carried = intCents(rec.deferredBalanceCents);
    const cleared = intCents(rec.deferredPaidCents) || 0;

    if (kind === 'CASH_UPFRONT') {
        return {
            kind, cashPaid, deferredOutstandingCents: 0, deferredPaidCents: 0,
            agreedCents: agreed, fullyPaid: cashPaid,
            why: cashPaid ? 'onboarding settled against a verified QuickBooks payment'
                : 'no verified payment is linked, so nothing is paid',
        };
    }
    if (kind === 'DEFERRED') {
        const outstanding = carried === null ? null : Math.max(0, carried - cleared);
        return {
            kind, cashPaid: false, deferredOutstandingCents: outstanding, deferredPaidCents: cleared,
            agreedCents: agreed,
            // Unknown carry is not zero. An unreadable balance must never read as settled.
            fullyPaid: outstanding === 0 && carried !== null,
            why: carried === null ? 'the carried balance was never recorded, so what they owe is unknown'
                : outstanding === 0 ? 'the carried onboarding balance is cleared'
                : `carrying ${(outstanding / 100).toFixed(2)} of onboarding on the hourly rate`,
        };
    }
    return { kind: '', cashPaid, deferredOutstandingCents: null, deferredPaidCents: 0, agreedCents: agreed,
        fullyPaid: false, why: 'no terms have been accepted yet, so there is nothing to owe' };
}

/**
 * Move a record one step, or refuse and say what is missing.
 * Nothing here overwrites a field the operator did not send, so an update cannot silently erase
 * evidence somebody recorded earlier.
 * @returns {{ok:true, patch:object}|{ok:false, error:string, hint?:string}}
 */
export function validateFulfilment(existing = {}, state = '', set = {}) {
    const def = FULFILMENT_STATES[state];
    if (!def) return { ok: false, error: 'unknown fulfilment step' };
    const patch = { fulfilmentState: state, fulfilmentUpdatedAt: new Date().toISOString() };

    const owner = S(set.fulfilmentOwner, 60) || S(existing.fulfilmentOwner, 60);
    if (!owner) return { ok: false, error: 'name who owns this, on our side', hint: 'Unowned work is how a paid client waits three weeks.' };
    patch.fulfilmentOwner = owner;

    const due = S(set.nextDueAt, 40) || S(existing.nextDueAt, 40);
    if (state !== 'REVIEW_30' && !due) {
        return { ok: false, error: 'set the date the next thing is due', hint: 'Every open step needs a date somebody is working to.' };
    }
    if (due) {
        if (Number.isNaN(Date.parse(due))) return { ok: false, error: 'that due date is not a date' };
        patch.nextDueAt = due;
    }
    if (set.nextAction !== undefined) patch.nextAction = S(set.nextAction, 400);

    if (state === 'TERMS_ACCEPTED') {
        const kind = S(set.acceptedTermsKind, 20).toUpperCase();
        if (!TERMS[kind]) return { ok: false, error: `terms must be ${Object.keys(TERMS).join(' or ')}` };
        const words = S(set.acceptedWords, 1200);
        if (!words) return { ok: false, error: 'record what they agreed to, in their words', hint: 'An arrangement nobody can quote is an assumption.' };
        const by = S(set.acceptedBy, 80);
        if (!by) return { ok: false, error: 'name who accepted, on their side' };
        const at = S(set.acceptedAt, 40) || new Date().toISOString();
        if (Number.isNaN(Date.parse(at))) return { ok: false, error: 'that acceptance date is not a date' };
        patch.acceptedTermsKind = kind; patch.acceptedWords = words; patch.acceptedBy = by; patch.acceptedAt = at;

        const agreed = intCents(set.acceptedAmountCents);
        if (agreed === null || agreed <= 0) return { ok: false, error: 'record the onboarding amount they actually agreed to' };
        patch.acceptedAmountCents = agreed;

        if (kind === 'DEFERRED') {
            const perHour = Number(set.carryPerHour);
            if (!Number.isFinite(perHour) || perHour <= 0) return { ok: false, error: 'deferred terms need the per-hour carry that was agreed' };
            patch.carryPerHour = perHour;
            // The carry starts at the full agreed amount. Recording it explicitly means the balance
            // is never inferred later from a number nobody wrote down.
            const carry = intCents(set.deferredBalanceCents);
            patch.deferredBalanceCents = carry === null ? agreed : carry;
            patch.deferredPaidCents = intCents(set.deferredPaidCents) || 0;
        }
        return { ok: true, patch };
    }

    if (state === 'ACTIVATED') {
        const kind = S(existing.acceptedTermsKind, 20).toUpperCase();
        if (!TERMS[kind]) return { ok: false, error: 'accept terms before activating', hint: 'Activation means something different for cash and for deferred.' };
        const v = validateActivation(kind, {
            activationReference: set.activationReference || existing.paymentReference || existing.activationReference,
            activatedAt: set.activatedAt,
            placementStartedAt: set.placementStartedAt,
            placementRef: set.placementRef,
        });
        if (!v.ok) return { ok: false, error: v.error,
            hint: kind === 'DEFERRED'
                ? 'Deferred onboarding activates when the placement starts. It does not mean they have paid.'
                : 'Link and verify the QuickBooks invoice first. A CRM stage is not a payment.' };
        Object.assign(patch, v.patch);
        if (kind === 'DEFERRED') {
            const ev = S(set.placementEvidence, 600);
            if (!ev) return { ok: false, error: 'say who started and what they are doing', hint: 'A start date with no person is not a placement.' };
            patch.placementEvidence = ev;
        }
        return { ok: true, patch };
    }

    if (state === 'FIRST_VALUE') {
        if (!S(existing.activatedAt, 40)) return { ok: false, error: 'activate before recording first value' };
        const at = S(set.firstValueAt, 40);
        if (!at || Number.isNaN(Date.parse(at))) return { ok: false, error: 'when did the client accept it?' };
        const ref = S(set.firstValueRef, 300);
        if (!ref) return { ok: false, error: 'name the deliverable they accepted', hint: 'A link, a file, a job number. Something that exists.' };
        const by = S(set.firstValueAcceptedBy, 80);
        if (!by) return { ok: false, error: 'who on their side accepted it?',
            hint: 'Sending work is not first value. Them taking it is.' };
        patch.firstValueAt = at; patch.firstValueRef = ref; patch.firstValueAcceptedBy = by;
        if (set.firstValueWords !== undefined) patch.firstValueWords = S(set.firstValueWords, 1200);
        return { ok: true, patch };
    }

    // REVIEW_30
    if (!S(existing.firstValueAt, 40)) return { ok: false, error: 'record first value before reviewing it' };
    const at = S(set.reviewAt, 40);
    if (!at || Number.isNaN(Date.parse(at))) return { ok: false, error: 'when was the review?' };
    const result = S(set.reviewResult, 20).toUpperCase();
    if (!REVIEW_RESULTS.includes(result)) return { ok: false, error: `result must be one of ${REVIEW_RESULTS.join(', ')}` };
    const ev = S(set.reviewEvidence, 1200);
    if (!ev && !WORDLESS_REVIEWS.includes(result)) {
        return { ok: false, error: 'paste what they said', hint: 'A verdict about how it is going needs their words, not ours.' };
    }
    patch.reviewAt = at; patch.reviewResult = result;
    patch.reviewEvidence = ev || 'no answer to the review request';
    return { ok: true, patch };
}

/** What this record is waiting on, for the operator list. Never a guess. */
export function fulfilmentNext(rec = {}) {
    const state = S(rec.fulfilmentState, 30);
    const bal = balanceOf(rec);
    if (!state) return { step: 'TERMS_ACCEPTED', why: 'no terms recorded yet', overdue: false };
    if (state === 'REVIEW_30') {
        return { step: '', why: bal.fullyPaid ? 'complete' : `complete, ${bal.why}`, overdue: false };
    }
    const order = ['TERMS_ACCEPTED', 'ACTIVATED', 'FIRST_VALUE', 'REVIEW_30'];
    const next = order[order.indexOf(state) + 1] || '';
    const due = S(rec.nextDueAt, 40);
    const overdue = !!due && !Number.isNaN(Date.parse(due)) && Date.parse(due) < Date.now();
    return { step: next, why: rec.nextAction || FULFILMENT_STATES[next]?.label || '', overdue, dueAt: due };
}
