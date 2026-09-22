// WHAT HAPPENS AFTER THEY SAY YES, through the real exported gate.
//
// The model used to stop at payment, so a client who paid and got nothing looked the same as one
// who was being served, and both looked the same as a deferred owner who has paid nothing at all.
// These tests pin the distinctions that keep those three apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFulfilment, balanceOf, fulfilmentNext, REVIEW_RESULTS, verifiedCashPayment } from '../api/_pilot-fulfilment.js';

// What the SERVER records after it checks an invoice against QuickBooks. Only this counts as paid.
const VERIFIED = { paymentStatus: 'paid', paymentReference: 'qbo:REALM1:customer:55:invoice:900:payment:P1',
    paymentVerifiedAt: '2026-09-22T10:00:00Z' };

const REF = 'qbo:REALM1:customer:55:invoice:900:payment:P1';
const OWNER = { fulfilmentOwner: 'Paul', nextDueAt: '2026-10-01' };
const cashTerms = {
    ...OWNER, acceptedTermsKind: 'CASH_UPFRONT', acceptedAmountCents: 249900,
    acceptedBy: 'Dana Okafor', acceptedAt: '2026-09-20', acceptedWords: 'Yes, send the invoice and we will pay it this week.',
};
const deferredTerms = {
    ...OWNER, acceptedTermsKind: 'DEFERRED', acceptedAmountCents: 249900, carryPerHour: 2,
    acceptedBy: 'Dana Okafor', acceptedAt: '2026-09-20', acceptedWords: 'We would rather carry it on the rate.',
};
const accept = (set) => validateFulfilment({}, 'TERMS_ACCEPTED', set);

// ─── Terms ──────────────────────────────────────────────────────

test('accepted terms need their words, a person and an amount', () => {
    assert.equal(accept({ ...cashTerms, acceptedWords: '' }).error, 'record what they agreed to, in their words');
    assert.equal(accept({ ...cashTerms, acceptedBy: '' }).error, 'name who accepted, on their side');
    assert.equal(accept({ ...cashTerms, acceptedAmountCents: '' }).error, 'record the onboarding amount they actually agreed to');
    assert.equal(accept({ ...cashTerms, acceptedTermsKind: 'MAYBE' }).ok, false);
});

test('every open step needs an owner and a date', () => {
    assert.match(accept({ ...cashTerms, fulfilmentOwner: '' }).error, /name who owns this/);
    assert.match(accept({ ...cashTerms, nextDueAt: '' }).error, /date the next thing is due/);
    assert.match(accept({ ...cashTerms, nextDueAt: 'soon' }).error, /not a date/);
});

test('deferred terms need the per-hour carry, and the balance starts at the full amount', () => {
    assert.match(accept({ ...deferredTerms, carryPerHour: '' }).error, /per-hour carry/);
    const v = accept(deferredTerms);
    assert.equal(v.ok, true);
    assert.equal(v.patch.deferredBalanceCents, 249900);
    assert.equal(v.patch.deferredPaidCents, 0);
});

// ─── Activation, which is different for each ────────────────────

test('cash activates only on a payment the server itself verified', () => {
    const rec = accept(cashTerms).patch;
    assert.match(validateFulfilment(rec, 'ACTIVATED', OWNER).error, /no verified QuickBooks payment/);
    const ok = validateFulfilment({ ...rec, ...VERIFIED }, 'ACTIVATED', OWNER);
    assert.equal(ok.ok, true);
    assert.equal(ok.patch.activationKind, 'CASH_UPFRONT');
    assert.equal(ok.patch.activationReference, VERIFIED.paymentReference);
});

// THE BYPASS. A reference that matches the pattern is a string, not a payment.
test('an operator cannot activate cash by typing a well-formed reference', () => {
    const rec = accept(cashTerms).patch;
    for (const spoof of [REF, 'qbo:ANY:customer:1:invoice:2:payment:3', 'qbo:x:invoice:y:payment:z']) {
        const v = validateFulfilment(rec, 'ACTIVATED', { ...OWNER, activationReference: spoof });
        assert.equal(v.ok, false, `typed reference ${spoof} must not activate`);
        assert.match(v.error, /no verified QuickBooks payment/);
        assert.match(v.hint, /typed reference is not a payment/);
    }
});

test('a half-recorded verdict is not a verified payment', () => {
    const rec = accept(cashTerms).patch;
    // Each field missing in turn. All three have to agree.
    for (const missing of ['paymentStatus', 'paymentReference', 'paymentVerifiedAt']) {
        const partial = { ...rec, ...VERIFIED, [missing]: '' };
        assert.equal(verifiedCashPayment(partial), null, `${missing} missing must not read as paid`);
        assert.equal(validateFulfilment(partial, 'ACTIVATED', OWNER).ok, false);
    }
    // A non-paid status with a leftover reference is not paid either.
    assert.equal(verifiedCashPayment({ ...VERIFIED, paymentStatus: 'partial' }), null);
    assert.equal(verifiedCashPayment({ ...VERIFIED, paymentStatus: 'unpaid' }), null);
});

test('QuickBooks being disconnected means not paid, not paid-by-default', () => {
    const rec = { ...accept(cashTerms).patch, paymentStatus: 'not-configured',
        paymentWhy: 'QuickBooks is not connected' };
    assert.equal(verifiedCashPayment(rec), null);
    assert.equal(balanceOf(rec).fullyPaid, false);
    assert.equal(validateFulfilment(rec, 'ACTIVATED', OWNER).ok, false);
});

test('a voided payment revokes paid status, even after activation', () => {
    const active = { ...accept(cashTerms).patch, ...VERIFIED,
        activationKind: 'CASH_UPFRONT', activatedAt: '2026-09-22T10:00:00Z',
        activationReference: VERIFIED.paymentReference };
    assert.equal(balanceOf(active).fullyPaid, true);

    // payment-link re-checks and finds it voided: it clears the live reference and keeps the old one.
    const voided = { ...active, paymentStatus: 'void', paymentReference: '',
        paymentVerifiedAt: '', paymentFormerReference: VERIFIED.paymentReference };
    const b = balanceOf(voided);
    assert.equal(b.fullyPaid, false, 'a stale activationReference must not keep them looking paid');
    assert.equal(b.cashPaid, false);
    assert.equal(b.revoked, true);
    assert.match(b.why, /withdrawn or voided/);
    // And it cannot be re-activated on the strength of the old copy.
    const again = validateFulfilment(voided, 'ACTIVATED', OWNER);
    assert.equal(again.ok, false);
    assert.match(again.error, /withdrawn or voided/);
});

test('DEFERRED CANNOT BE ACTIVATED BY A PAYMENT, TYPED OR VERIFIED', () => {
    const rec = accept(deferredTerms).patch;
    assert.match(validateFulfilment(rec, 'ACTIVATED', { ...OWNER, activationReference: REF }).error,
        /when did the placement actually start/);
    // Even a genuinely verified payment does not start a placement.
    const withPayment = { ...rec, ...VERIFIED };
    assert.equal(validateFulfilment(withPayment, 'ACTIVATED', OWNER).ok, false);
    assert.equal(balanceOf(withPayment).cashPaid, false, 'deferred never borrows a cash verdict');
    assert.equal(balanceOf(withPayment).fullyPaid, false);
});

test('deferred activates on a real placement, with a person', () => {
    const rec = accept(deferredTerms).patch;
    assert.match(validateFulfilment(rec, 'ACTIVATED',
        { ...OWNER, placementStartedAt: '2026-10-01' }).error, /record the start date and who started/);
    assert.match(validateFulfilment(rec, 'ACTIVATED',
        { ...OWNER, placementStartedAt: '2026-10-01', placementRef: 'Marta R' }).error, /who started and what they are doing/);
    const ok = validateFulfilment(rec, 'ACTIVATED', { ...OWNER,
        placementStartedAt: '2026-10-01', placementRef: 'Marta R', placementEvidence: 'Editing listing video, 30 hours a week.' });
    assert.equal(ok.ok, true);
    assert.equal(ok.patch.activationKind, 'DEFERRED');
    assert.equal(ok.patch.activatedAt, '2026-10-01');
});

test('nothing activates before terms are accepted', () => {
    assert.match(validateFulfilment({}, 'ACTIVATED', { ...OWNER, activationReference: REF }).error, /accept terms before activating/);
});

// ─── The balance, which is the whole point ──────────────────────

test('an activated deferred owner is NOT fully paid', () => {
    const rec = { ...accept(deferredTerms).patch, activationKind: 'DEFERRED', activatedAt: '2026-10-01' };
    const b = balanceOf(rec);
    assert.equal(b.kind, 'DEFERRED');
    assert.equal(b.fullyPaid, false, 'being served is not being paid');
    assert.equal(b.cashPaid, false);
    assert.equal(b.deferredOutstandingCents, 249900);
    assert.match(b.why, /carrying 2499\.00/);
});

test('a deferred balance is only clear when it has actually been cleared', () => {
    const base = accept(deferredTerms).patch;
    assert.equal(balanceOf({ ...base, deferredPaidCents: 100000 }).deferredOutstandingCents, 149900);
    const done = balanceOf({ ...base, deferredPaidCents: 249900 });
    assert.equal(done.deferredOutstandingCents, 0);
    assert.equal(done.fullyPaid, true);
});

test('an unrecorded carry is unknown, never zero', () => {
    const b = balanceOf({ acceptedTermsKind: 'DEFERRED', acceptedAmountCents: 249900 });
    assert.equal(b.deferredOutstandingCents, null);
    assert.equal(b.fullyPaid, false, 'an unreadable balance must never read as settled');
    assert.match(b.why, /unknown/);
});

test('cash is paid only against the recorded verified verdict', () => {
    assert.equal(balanceOf({ acceptedTermsKind: 'CASH_UPFRONT', ...VERIFIED }).fullyPaid, true);
    assert.equal(balanceOf({ acceptedTermsKind: 'CASH_UPFRONT', paymentReference: REF }).fullyPaid, false,
        'a reference with no verified status and date is not a payment');
    assert.equal(balanceOf({ acceptedTermsKind: 'CASH_UPFRONT', paymentReference: 'paid by card' }).fullyPaid, false);
    assert.equal(balanceOf({ acceptedTermsKind: 'CASH_UPFRONT' }).fullyPaid, false);
    // The stale copy on its own proves nothing.
    assert.equal(balanceOf({ acceptedTermsKind: 'CASH_UPFRONT', activationReference: REF }).fullyPaid, false);
});

test('a deferred record can never borrow a cash payment reference to look paid', () => {
    const b = balanceOf({ acceptedTermsKind: 'DEFERRED', paymentReference: REF, deferredBalanceCents: 249900 });
    assert.equal(b.cashPaid, false);
    assert.equal(b.fullyPaid, false);
    assert.equal(b.deferredOutstandingCents, 249900);
});

// ─── First value and the review ─────────────────────────────────

test('sending work is not first value: the client has to have accepted it', () => {
    const rec = { ...accept(cashTerms).patch, activatedAt: '2026-09-25' };
    assert.match(validateFulfilment(rec, 'FIRST_VALUE', { ...OWNER, firstValueAt: '2026-10-02' }).error, /name the deliverable/);
    const v = validateFulfilment(rec, 'FIRST_VALUE', { ...OWNER, firstValueAt: '2026-10-02', firstValueRef: 'Job 4182, 24 listing photos' });
    assert.match(v.error, /who on their side accepted it/i);
    assert.match(v.hint, /Them taking it is/);
    const ok = validateFulfilment(rec, 'FIRST_VALUE', { ...OWNER, firstValueAt: '2026-10-02',
        firstValueRef: 'Job 4182, 24 listing photos', firstValueAcceptedBy: 'Dana' });
    assert.equal(ok.ok, true);
});

test('first value cannot be recorded before activation', () => {
    const rec = accept(cashTerms).patch;
    assert.match(validateFulfilment(rec, 'FIRST_VALUE', { ...OWNER, firstValueAt: '2026-10-02',
        firstValueRef: 'x', firstValueAcceptedBy: 'Dana' }).error, /activate before recording first value/);
});

test('a 30-day review needs a known result and their words', () => {
    const rec = { ...accept(cashTerms).patch, activatedAt: '2026-09-25', firstValueAt: '2026-10-02' };
    assert.match(validateFulfilment(rec, 'REVIEW_30', { reviewAt: '2026-11-01', reviewResult: 'GREAT' }).error, /result must be one of/);
    assert.match(validateFulfilment(rec, 'REVIEW_30', { reviewAt: '2026-11-01', reviewResult: 'WORKING' }).error, /paste what they said/);
    const ok = validateFulfilment(rec, 'REVIEW_30', { reviewAt: '2026-11-01', reviewResult: 'WORKING',
        reviewEvidence: 'She is quicker than my last editor and I stopped re-checking her work.' });
    assert.equal(ok.ok, true);
    assert.ok(REVIEW_RESULTS.includes(ok.patch.reviewResult));
});

test('no answer is the one review result that needs no words', () => {
    const rec = { ...accept(cashTerms).patch, activatedAt: '2026-09-25', firstValueAt: '2026-10-02' };
    const ok = validateFulfilment(rec, 'REVIEW_30', { reviewAt: '2026-11-01', reviewResult: 'NO_ANSWER' });
    assert.equal(ok.ok, true);
    assert.match(ok.patch.reviewEvidence, /no answer/);
});

test('a review cannot be recorded before first value', () => {
    const rec = { ...accept(cashTerms).patch, activatedAt: '2026-09-25' };
    assert.match(validateFulfilment(rec, 'REVIEW_30', { reviewAt: '2026-11-01', reviewResult: 'NO_ANSWER' }).error,
        /record first value before reviewing/);
});

// ─── Nothing is silently rewritten ──────────────────────────────

test('a patch carries only what was validated, so it cannot erase other evidence', () => {
    const rec = { ...accept(cashTerms).patch, activatedAt: '2026-09-25', firstValueAt: '2026-10-02',
        firstValueRef: 'Job 4182', firstValueAcceptedBy: 'Dana' };
    const v = validateFulfilment(rec, 'REVIEW_30', { reviewAt: '2026-11-01', reviewResult: 'NO_ANSWER' });
    for (const gone of ['acceptedWords', 'firstValueRef', 'acceptedBy', 'activatedAt']) {
        assert.equal(Object.prototype.hasOwnProperty.call(v.patch, gone), false, `${gone} must not appear in the patch`);
    }
});

test('the owner and due date carry forward when a step does not resend them', () => {
    const rec = { ...accept(cashTerms).patch, ...VERIFIED };
    const v = validateFulfilment(rec, 'ACTIVATED', {});
    assert.equal(v.ok, true);
    assert.equal(v.patch.fulfilmentOwner, 'Paul');
});

// ─── Numbers and dates ──────────────────────────────────────────

test('a carried balance cannot be negative, and cannot be over-paid', () => {
    assert.match(accept({ ...deferredTerms, deferredBalanceCents: -100 }).error, /cannot be negative/);
    assert.match(accept({ ...deferredTerms, deferredPaidCents: -1 }).error, /cannot be negative/);
    assert.match(accept({ ...deferredTerms, deferredBalanceCents: 100000, deferredPaidCents: 200000 }).error,
        /more than they are carrying/);
});

test('paying down the carry stays within the carry', () => {
    const rec = accept(deferredTerms).patch;
    const start = { placementStartedAt: '2026-10-01', placementRef: 'Marta R',
        placementEvidence: 'Editing listing video.', ...OWNER };
    assert.match(validateFulfilment(rec, 'ACTIVATED', { ...start, deferredPaidCents: 500000 }).error,
        /more than the 2499\.00 they are carrying/);
    assert.match(validateFulfilment(rec, 'ACTIVATED', { ...start, deferredPaidCents: -5 }).error, /cannot be negative/);
    const ok = validateFulfilment(rec, 'ACTIVATED', { ...start, deferredPaidCents: 50000 });
    assert.equal(ok.ok, true);
    assert.equal(ok.patch.deferredPaidCents, 50000);
});

test('every date field refuses something that is not a date', () => {
    assert.match(accept({ ...cashTerms, acceptedAt: 'whenever' }).error, /not a date/);
    assert.match(accept({ ...cashTerms, nextDueAt: 'soon-ish' }).error, /not a date/);
    const rec = accept(deferredTerms).patch;
    assert.match(validateFulfilment(rec, 'ACTIVATED', { ...OWNER, placementStartedAt: 'last week',
        placementRef: 'Marta R', placementEvidence: 'Editing.' }).error, /when did the placement actually start/);
    const cash = { ...accept(cashTerms).patch, ...VERIFIED, activatedAt: '2026-09-22' };
    assert.match(validateFulfilment(cash, 'FIRST_VALUE', { ...OWNER, firstValueAt: 'yesterday',
        firstValueRef: 'Job 1', firstValueAcceptedBy: 'Dana' }).error, /when did the client accept it/);
});

// ─── What is waiting on somebody ────────────────────────────────

test('the next step and whether it is late', () => {
    assert.equal(fulfilmentNext({}).step, 'TERMS_ACCEPTED');
    const late = fulfilmentNext({ fulfilmentState: 'ACTIVATED', nextDueAt: '2020-01-01' });
    assert.equal(late.step, 'FIRST_VALUE');
    assert.equal(late.overdue, true);
    const soon = fulfilmentNext({ fulfilmentState: 'ACTIVATED', nextDueAt: '2999-01-01' });
    assert.equal(soon.overdue, false);
});

test('a finished deferred record still says what is owed', () => {
    const n = fulfilmentNext({ fulfilmentState: 'REVIEW_30', acceptedTermsKind: 'DEFERRED',
        deferredBalanceCents: 249900, deferredPaidCents: 50000 });
    assert.equal(n.step, '');
    assert.match(n.why, /carrying 1999\.00/);
});
