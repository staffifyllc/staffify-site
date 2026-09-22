// Payment evidence, through the real exported functions against a fake QuickBooks that answers only
// the queries this module actually sends. Nothing here creates an invoice, a payment or a charge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPaymentCandidates, verifyLinkedPayment, isVerifiedPaid, approvedAmount } from '../api/_pilot-payment.js';

const CUST = { Id: '55', DisplayName: 'Okafor Media', PrimaryEmailAddr: { Address: 'dana@example.com' } };
const OTHER = { Id: '56', DisplayName: 'Unrelated Media Group', PrimaryEmailAddr: { Address: 'someone@else.com' } };
const inv = (over = {}) => ({ Id: '900', DocNumber: 'INV-900', TotalAmt: 2499, Balance: 0, TxnDate: '2026-10-01',
    CustomerRef: { value: '55' }, Line: [{ Description: 'Staffify onboarding', Amount: 2499,
        SalesItemLineDetail: { ItemRef: { value: '7', name: 'Onboarding' } } }], ...over });
const pay = (over = {}) => ({ Id: 'P1', TxnDate: '2026-10-02', CustomerRef: { value: '55' },
    Line: [{ Amount: 2499, LinkedTxn: [{ TxnId: '900', TxnType: 'Invoice' }] }], ...over });

// The fake rejects the query shapes QuickBooks does not reliably support, so a test cannot pass by
// relying on filtering that would fail in the real thing.
function qbo({ customers = [CUST, OTHER], invoices = [inv()], payments = [pay()], throwOn = '', connected = true, realm = 'REALM1' } = {}) {
    return {
        qboConnected: async () => connected,
        getRealmId: async () => realm,
        expectedRealm: () => 'REALM1',
        qboQuery: async (sql) => {
            if (/PrimaryEmailAddr/.test(sql)) throw new Error('QuickBooks does not support filtering on PrimaryEmailAddr');
            if (throwOn && sql.includes(throwOn)) throw new Error('quickbooks down');
            if (/from Customer/.test(sql)) return { QueryResponse: { Customer: customers } };
            if (/from Invoice/.test(sql)) {
                const m = /Id = '(\d+)'/.exec(sql);
                return { QueryResponse: { Invoice: m ? invoices.filter((i) => String(i.Id) === m[1]) : invoices } };
            }
            if (/from Payment/.test(sql)) return { QueryResponse: { Payment: payments } };
            return { QueryResponse: {} };
        },
    };
}
const WHO = { email: 'dana@example.com', company: 'Okafor Media' };
const LINK = { realm: 'REALM1', customerId: '55', invoiceId: '900' };

test('with nothing linked the answer is needs-link, never paid', async () => {
    const v = await verifyLinkedPayment(null, qbo());
    assert.equal(v.status, 'needs-link');
    assert.equal(isVerifiedPaid(v), false);
});

test('candidates are offered for a person to link, and are never a verdict', async () => {
    const v = await findPaymentCandidates(WHO, qbo());
    assert.equal(v.status, 'candidates');
    assert.equal(v.candidates.length, 1);
    assert.equal(v.candidates[0].strength, 'strong');
    assert.equal(v.candidates[0].customerMatch, 'email');
    assert.match(v.why, /not identity/);
    assert.equal(isVerifiedPaid(v), false);
});

test('a company-name match is a weak candidate, not identity', async () => {
    const c = { Id: '70', DisplayName: 'Okafor Productions', PrimaryEmailAddr: { Address: 'other@x.com' } };
    const v = await findPaymentCandidates(WHO, qbo({ customers: [c], invoices: [inv({ CustomerRef: { value: '70' } })] }));
    assert.equal(v.candidates[0].strength, 'weak');
    assert.equal(v.candidates[0].customerMatch, 'company name');
});

test('an invoice predating the inquiry is flagged as almost certainly different work', async () => {
    const v = await findPaymentCandidates({ ...WHO, since: '2026-09-21T00:00:00Z' },
        qbo({ invoices: [inv({ TxnDate: '2026-03-04' })] }));
    assert.equal(v.candidates[0].predatesRequest, true);
    assert.match(v.candidates[0].note, /predates the inquiry/);
});

test('a linked, settled onboarding invoice at the approved amount is the only thing called paid', async () => {
    const v = await verifyLinkedPayment(LINK, qbo());
    assert.equal(v.status, 'paid');
    assert.equal(isVerifiedPaid(v), true);
    assert.match(v.reference, /^qbo:REALM1:customer:55:invoice:900:payment:P1$/);
});

test('an invoice belonging to a different customer is a mismatch', async () => {
    const v = await verifyLinkedPayment({ ...LINK, customerId: '56' }, qbo());
    assert.equal(v.status, 'mismatched');
    assert.equal(isVerifiedPaid(v), false);
});

test('the wrong QuickBooks company can never answer', async () => {
    assert.equal((await verifyLinkedPayment(LINK, qbo({ realm: 'SOMEONE_ELSE' }))).status, 'wrong-realm');
    assert.equal((await verifyLinkedPayment({ ...LINK, realm: 'OLD_REALM' }, qbo())).status, 'wrong-realm');
});

test('an amount that is not the approved onboarding amount is refused', async () => {
    const v = await verifyLinkedPayment(LINK, qbo({ invoices: [inv({ TotalAmt: 1200, Line: [{ Description: 'onboarding, discounted', Amount: 1200,
        SalesItemLineDetail: { ItemRef: { value: '7', name: 'Onboarding' } } }] })] }));
    assert.equal(v.status, 'wrong-amount');
    assert.match(v.why, new RegExp(String(approvedAmount())));
});

test('a missing balance is missing, not zero', async () => {
    const i = inv(); delete i.Balance;
    const v = await verifyLinkedPayment(LINK, qbo({ invoices: [i] }));
    assert.equal(v.status, 'unknown');
    assert.match(v.why, /no balance field/);
});

test('a voided payment does not settle anything', async () => {
    const v = await verifyLinkedPayment(LINK, qbo({ payments: [pay({ PrivateNote: 'Voided' })] }));
    assert.equal(v.status, 'settled-without-payment');
    assert.equal(isVerifiedPaid(v), false);
});

test('a voided invoice is refused outright', async () => {
    const v = await verifyLinkedPayment(LINK, qbo({ invoices: [inv({ PrivateNote: 'Voided' })] }));
    assert.equal(v.status, 'void');
});

test('allocations short of the total are partial, whatever the balance says', async () => {
    const v = await verifyLinkedPayment(LINK, qbo({
        invoices: [inv({ Balance: 999 })],
        payments: [pay({ Line: [{ Amount: 1500, LinkedTxn: [{ TxnId: '900', TxnType: 'Invoice' }] }] })] }));
    assert.equal(v.status, 'partial');
    assert.equal(v.paid, 1500);
});

test('a payment linked to another invoice does not settle this one', async () => {
    const v = await verifyLinkedPayment(LINK, qbo({ payments: [pay({ Line: [{ Amount: 2499, LinkedTxn: [{ TxnId: '111', TxnType: 'Invoice' }] }] })] }));
    assert.equal(v.status, 'settled-without-payment');
});

test('QuickBooks down or disconnected is unknown, never paid and never unpaid', async () => {
    assert.equal((await verifyLinkedPayment(LINK, qbo({ throwOn: 'from Payment' }))).status, 'unknown');
    assert.equal((await verifyLinkedPayment(LINK, qbo({ connected: false }))).status, 'not-configured');
    assert.equal((await findPaymentCandidates(WHO, qbo({ connected: false }))).status, 'not-configured');
});

test('the module never sends a query QuickBooks cannot answer', async () => {
    // The fake throws on PrimaryEmailAddr filtering. Reaching a verdict proves we do not rely on it.
    const v = await findPaymentCandidates(WHO, qbo());
    assert.equal(v.status, 'candidates');
});

test('only an explicit paid verdict with a full reference is accepted', () => {
    for (const bad of [null, {}, { status: 'paid' }, { status: 'paid', reference: 'qbo:REALM1' },
        { status: 'partial', reference: 'qbo:R:customer:1:invoice:2:payment:3' }, { status: 'needs-link' }]) {
        assert.equal(isVerifiedPaid(bad), false);
    }
    assert.equal(isVerifiedPaid({ status: 'paid', reference: 'qbo:R:customer:1:invoice:2:payment:3' }), true);
});

// The item is the item, not a word that happens to appear in the line.
test('a line that only MENTIONS onboarding in its description is not an onboarding line', async () => {
    const decoy = inv({
        Line: [{ Description: 'Drone work for the onboarding shoot', Amount: 2499,
            SalesItemLineDetail: { ItemRef: { value: '12', name: 'Aerial photography' } } }],
    });
    const v = await verifyLinkedPayment(LINK, qbo({ invoices: [decoy] }));
    assert.equal(v.status, 'not-onboarding');
    assert.equal(isVerifiedPaid(v), false);
});
