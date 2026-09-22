// WHAT HAPPENS AFTER THEY SAY YES, through the real exported gate.
//
// The model used to stop at payment, so a client who paid and got nothing looked the same as one
// who was being served, and both looked the same as a deferred owner who has paid nothing at all.
// These tests pin the distinctions that keep those three apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFulfilment, balanceOf, fulfilmentNext, REVIEW_RESULTS } from '../api/_pilot-fulfilment.js';

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

test('cash activates on a verified reference and nothing else', () => {
    const rec = accept(cashTerms).patch;
    assert.match(validateFulfilment(rec, 'ACTIVATED', OWNER).error, /verified QuickBooks payment reference/);
    assert.match(validateFulfilment(rec, 'ACTIVATED', { ...OWNER, activationReference: 'they paid, I saw it' }).error,
        /verified QuickBooks payment reference/);
    const ok = validateFulfilment(rec, 'ACTIVATED', { ...OWNER, activationReference: REF });
    assert.equal(ok.ok, true);
    assert.equal(ok.patch.activationKind, 'CASH_UPFRONT');
});

test('DEFERRED CANNOT BE ACTIVATED BY A PAYMENT REFERENCE', () => {
    const rec = accept(deferredTerms).patch;
    const v = validateFulfilment(rec, 'ACTIVATED', { ...OWNER, activationReference: REF });
    assert.equal(v.ok, false, 'a payment reference must not activate deferred terms');
    assert.match(v.error, /placement starts/);
    assert.match(v.hint, /does not mean they have paid/);
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

test('cash is paid only against a verified reference', () => {
    assert.equal(balanceOf({ acceptedTermsKind: 'CASH_UPFRONT', paymentReference: REF }).fullyPaid, true);
    assert.equal(balanceOf({ acceptedTermsKind: 'CASH_UPFRONT', paymentReference: 'paid by card' }).fullyPaid, false);
    assert.equal(balanceOf({ acceptedTermsKind: 'CASH_UPFRONT' }).fullyPaid, false);
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
    const rec = { ...accept(cashTerms).patch };
    const v = validateFulfilment(rec, 'ACTIVATED', { activationReference: REF });
    assert.equal(v.ok, true);
    assert.equal(v.patch.fulfilmentOwner, 'Paul');
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
