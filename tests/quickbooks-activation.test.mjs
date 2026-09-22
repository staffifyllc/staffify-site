// The payment webhook, through its real exported handler.
//
// The gate tests drive the real activationFromPayment. The flow tests drive the real
// processPaymentEvent with injected clients, so the claim/settle control flow, the retry paths and
// the concurrency behaviour are exercised as written, not re-described.
//
// SCOPE NOTE: fakeRedis.eval reimplements the two Lua scripts in JS. That proves this module's
// control flow around an atomic primitive; it does not prove the Lua itself is atomic on Upstash.
// That is checked separately against a live qatest key namespace and reported with the deploy.
//
// Nothing here contacts QuickBooks or Resend, and no address outside example.com appears.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activationFromPayment, isVerifiedPaid, verdictRetryable, onboardingLines } from '../api/_pilot-payment.js';
import { processPaymentEvent } from '../api/_pilot-activation.js';

process.env.QB_REALM_ID = process.env.QB_REALM_ID || 'REALM1';
const REALM = process.env.QB_REALM_ID;
const ITEM = { ItemRef: { value: '7', name: 'onboarding' } };

const inv = (o = {}) => ({ Id: '900', DocNumber: 'INV-900', TotalAmt: 2499, Balance: 0,
    CustomerRef: { value: '55' }, Line: [{ Amount: 2499, SalesItemLineDetail: ITEM }], ...o });
const pay = (o = {}) => ({ Id: 'P1', TxnDate: '2026-10-02', CustomerRef: { value: '55' },
    Line: [{ Amount: 2499, LinkedTxn: [{ TxnId: '900', TxnType: 'Invoice' }] }], ...o });
const gate = (o = {}) => activationFromPayment({
    payment: pay(o.payment), realm: o.realm || REALM, expectedRealm: REALM,
    getInvoice: o.getInvoice || (async () => inv(o.invoice)),
    resolveTerms: o.resolveTerms,
});

// ─── The gate ───────────────────────────────────────────────────

test('a settled onboarding invoice at the published amount is paid', async () => {
    const v = await gate();
    assert.equal(v.status, 'paid');
    assert.equal(isVerifiedPaid(v), true);
    assert.equal(v.termsAccepted, false, 'no recorded terms means assumed, and it says so');
    assert.match(v.why, /published default/);
    assert.equal(v.reference, `qbo:${REALM}:customer:55:invoice:900:payment:P1`);
});

test('an item that merely mentions onboarding in a description does not activate', async () => {
    const v = await gate({ invoice: { Line: [{ Amount: 2499, Description: 'onboarding shoot',
        SalesItemLineDetail: { ItemRef: { value: '12', name: 'Aerial photography' } } }] } });
    assert.equal(v.status, 'not-onboarding');
    assert.equal(verdictRetryable(v), false, 'a real no is not retried');
});

test('onboardingLines ignores a line with no ItemRef at all', () => {
    assert.equal(onboardingLines({ Line: [{ Amount: 2499, Description: 'onboarding' }] }).length, 0);
    assert.equal(onboardingLines({ Line: [{ Amount: 2499, SalesItemLineDetail: ITEM }] }).length, 1);
});

test('deferred terms never activate from a payment', async () => {
    const v = await gate({ resolveTerms: async () => ({ kind: 'DEFERRED', cents: 0 }) });
    assert.equal(v.status, 'deferred-terms');
    assert.equal(isVerifiedPaid(v), false);
    assert.match(v.why, /placement start/);
});

test('accepted terms, not the global default, set the amount that counts', async () => {
    const custom = { invoice: { TotalAmt: 1800, Line: [{ Amount: 1800, SalesItemLineDetail: ITEM }] } };
    const wrong = await gate(custom);
    assert.equal(wrong.status, 'wrong-amount', 'without terms it is measured against the published price');

    const right = await gate({ ...custom, resolveTerms: async () => ({ kind: 'CASH_UPFRONT', cents: 180000 }) });
    assert.equal(right.status, 'paid');
    assert.equal(right.termsAccepted, true);
    assert.match(right.why, /accepted terms/);
});

test('the invoice customer must be the paying customer', async () => {
    const v = await gate({ invoice: { CustomerRef: { value: '999' } } });
    assert.equal(v.status, 'mismatched');
});

test('a zero or negative applied amount settles nothing', async () => {
    for (const Amount of [0, -2499]) {
        const v = await gate({ payment: { Line: [{ Amount, LinkedTxn: [{ TxnId: '900', TxnType: 'Invoice' }] }] } });
        assert.equal(v.status, 'unlinked', `amount ${Amount}`);
    }
});

test('unreadable numbers are unknown, never a verdict', async () => {
    const v = await gate({ invoice: { Line: [{ Amount: 'abc', SalesItemLineDetail: ITEM }] } });
    assert.equal(v.status, 'unknown');
    assert.equal(verdictRetryable(v), true);
});

test('a missing balance is missing, not zero', async () => {
    const bad = inv(); delete bad.Balance;
    const v = await gate({ getInvoice: async () => bad });
    assert.equal(v.status, 'unknown');
});

test('an outstanding balance is partial', async () => {
    const v = await gate({ invoice: { Balance: 500 } });
    assert.equal(v.status, 'partial');
});

test('the wrong company never activates', async () => {
    const v = await gate({ realm: 'SOMEONE_ELSE' });
    assert.equal(v.status, 'wrong-realm');
});

test('an unreadable invoice is retryable, not "not onboarding"', async () => {
    const v = await gate({ getInvoice: async () => { throw new Error('quickbooks down'); } });
    assert.equal(v.status, 'unknown');
    assert.equal(verdictRetryable(v), true);
});

test('unreadable accepted terms do not silently fall back to the default', async () => {
    const v = await gate({ resolveTerms: async () => { throw new Error('redis down'); } });
    assert.equal(v.status, 'unknown');
    assert.equal(verdictRetryable(v), true);
});

// ─── The flow ───────────────────────────────────────────────────

function fakeRedis() {
    const H = new Map();
    const h = (k) => { if (!H.has(k)) H.set(k, new Map()); return H.get(k); };
    return {
        H,
        async hgetall(k) { const m = H.get(k); return m ? Object.fromEntries(m) : null; },
        async hget(k, f) { const m = H.get(k); return m && m.has(f) ? m.get(f) : null; },
        async hset(k, o) { const m = h(k); for (const [a, b] of Object.entries(o)) m.set(a, String(b)); return 1; },
        async hsetnx(k, f, v) { const m = h(k); if (m.has(f)) return 0; m.set(f, String(v)); return 1; },
        async eval(script, keys, args) {
            const m = h(keys[0]);
            if (script.includes("'done'")) {
                const [token, nowS, staleS] = args; const now = Number(nowS), stale = Number(staleS);
                if (m.has('outcome') && m.get('retryable') !== '1') return ['done', m.get('outcome')];
                if (m.has('owner') && m.has('claimedAt') && (now - Number(m.get('claimedAt'))) < stale) {
                    return ['busy', String(now - Number(m.get('claimedAt')))];
                }
                const prior = m.get('owner') || '';
                m.set('owner', token); m.set('claimedAt', nowS);
                m.delete('outcome'); m.delete('retryable'); m.delete('why');
                return ['ok', prior];
            }
            const [token, outcome, retryable, decidedAt, why] = args;
            if (m.get('owner') !== token) return 0;
            m.set('outcome', outcome); m.set('retryable', retryable);
            m.set('decidedAt', decidedAt); m.set('why', why);
            if (retryable === '1') m.delete('owner');
            return 1;
        },
    };
}

function rig(over = {}) {
    const sends = [];
    const calls = [];
    const redis = over.redis || fakeRedis();
    const deps = {
        redis,
        kickoffUrl: () => '',
        terms: over.terms || (async () => null),
        qbApi: over.qbApi || (async (path) => {
            calls.push(path);
            if (over.delayMs) await new Promise((r) => setTimeout(r, over.delayMs));
            if (path.startsWith('/payment/')) return { Payment: pay(over.payment) };
            if (path.startsWith('/invoice/')) return { Invoice: inv(over.invoice) };
            if (path.startsWith('/customer/')) return { Customer: { Id: '55', GivenName: 'Dana',
                PrimaryEmailAddr: { Address: 'dana@example.com' } } };
            throw new Error('unexpected ' + path);
        }),
        send: over.send || (async (m) => { sends.push(m); return { id: 're_' + sends.length }; }),
    };
    return { redis, deps, sends, calls };
}

test('the accepted case activates, records the provider id, and keeps email on the record', async () => {
    const { redis, deps, sends } = rig();
    const r = await processPaymentEvent('P1', REALM, deps);
    assert.equal(r.outcome, 'activated');
    assert.equal(sends.length, 1);

    const sub = await redis.hgetall('subscriber:dana@example.com');
    assert.equal(sub.email, 'dana@example.com', 'a subscriber row without its own address is unreadable downstream');
    assert.equal(sub.decision, 'client');
    assert.equal(sub.activation_kind, 'CASH_UPFRONT');
    assert.equal(sub.activation_reference, `qbo:${REALM}:customer:55:invoice:900:payment:P1`);
    assert.equal(sub.onboarding_email_provider_id, 're_1');
    assert.equal(sub.activation_terms_accepted, 'false');
});

test('the REJECTED case sends nothing and writes no subscriber at all', async () => {
    const { redis, deps, sends } = rig({ invoice: { Line: [{ Amount: 60,
        SalesItemLineDetail: { ItemRef: { value: '3', name: 'Retainer' } } }], TotalAmt: 60 } });
    const r = await processPaymentEvent('P1', REALM, deps);
    assert.equal(r.outcome, 'not_activated:not-onboarding');
    assert.equal(r.retryable, false);
    assert.equal(sends.length, 0, 'nobody is told their team is being built');
    assert.equal(await redis.hgetall('subscriber:dana@example.com'), null);
});

test('a second delivery of a finished event does nothing', async () => {
    const { deps, sends } = rig();
    await processPaymentEvent('P1', REALM, deps);
    const again = await processPaymentEvent('P1', REALM, deps);
    assert.equal(again.skipped, 'already_processed');
    assert.equal(sends.length, 1);
});

test('two concurrent deliveries activate once and send once', async () => {
    const { deps, sends } = rig({ delayMs: 15 });
    const [a, b] = await Promise.all([
        processPaymentEvent('P1', REALM, deps),
        processPaymentEvent('P1', REALM, deps),
    ]);
    const outcomes = [a, b];
    assert.equal(outcomes.filter((r) => r.outcome === 'activated').length, 1);
    assert.equal(outcomes.filter((r) => r.skipped === 'in_flight').length, 1);
    assert.equal(sends.length, 1, 'exactly one onboarding email for one payment');
});

test('a failed email is retryable, and the retry completes without a second activation', async () => {
    const redis = fakeRedis();
    let attempt = 0;
    const sends = [];
    const mk = () => rig({ redis, send: async (m) => {
        attempt++;
        if (attempt === 1) throw new Error('Resend 500: upstream');
        sends.push(m); return { id: 're_ok' };
    } }).deps;

    const first = await processPaymentEvent('P1', REALM, mk());
    assert.equal(first.outcome, 'activated_email_failed');
    assert.equal(first.retryable, true, 'the person must still get told');
    let sub = await redis.hgetall('subscriber:dana@example.com');
    assert.equal(sub.decision, 'client', 'a failed email does not un-pay them');
    assert.match(sub.onboarding_email_error, /Resend 500/);

    const second = await processPaymentEvent('P1', REALM, mk());
    assert.equal(second.outcome, 'activated');
    assert.equal(sends.length, 1);
    sub = await redis.hgetall('subscriber:dana@example.com');
    assert.equal(sub.onboarding_email_provider_id, 're_ok');
    assert.equal(sub.onboarding_email_error, '');
    assert.equal(sub.activation_reference, `qbo:${REALM}:customer:55:invoice:900:payment:P1`);
});

test('the retry reuses one provider idempotency key, so the provider can dedupe it', async () => {
    const redis = fakeRedis();
    const keys = [];
    let attempt = 0;
    const mk = () => rig({ redis, send: async (m) => {
        keys.push(m.idempotencyKey); attempt++;
        if (attempt === 1) throw new Error('network reset');
        return { id: 're_ok' };
    } }).deps;
    await processPaymentEvent('P1', REALM, mk());
    await processPaymentEvent('P1', REALM, mk());
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.equal(keys[0], `qb-onboarding:${REALM}:invoice:900`);
});

test('QuickBooks being unreadable stays retryable and does not become a permanent answer', async () => {
    const redis = fakeRedis();
    const bad = rig({ redis, qbApi: async () => { throw new Error('QB 503'); } }).deps;
    const r = await processPaymentEvent('P1', REALM, bad);
    assert.equal(r.outcome, 'qb_unreadable');
    assert.equal(r.retryable, true);
    // The next delivery must get back in rather than being told the event is done.
    const good = rig({ redis }).deps;
    const r2 = await processPaymentEvent('P1', REALM, good);
    assert.equal(r2.outcome, 'activated');
});

test('a worker whose claim was taken over cannot overwrite the newer answer', async () => {
    const redis = fakeRedis();
    const key = `qb:payevent:${REALM}:P1`;
    // A dead worker's claim, older than the stale window.
    await redis.hset(key, { owner: 'dead-worker', claimedAt: String(Date.now() - 60 * 60 * 1000) });

    const { deps } = rig({ redis });
    const r = await processPaymentEvent('P1', REALM, deps);
    assert.equal(r.outcome, 'activated');
    assert.equal(r.tookOverStaleClaim, true);

    // The dead worker now tries to record its own answer. It no longer owns the claim.
    const held = await redis.eval('if redis.call(...) owner', [key],
        ['dead-worker', 'activated_email_failed', '1', String(Date.now()), 'stale', '1000']);
    assert.equal(held, 0);
    const row = await redis.hgetall(key);
    assert.equal(row.outcome, 'activated', 'the live answer survives');
});

test('a fresh claim is respected: a second worker inside the window stands down', async () => {
    const redis = fakeRedis();
    const key = `qb:payevent:${REALM}:P1`;
    await redis.hset(key, { owner: 'live-worker', claimedAt: String(Date.now()) });
    const { deps, sends } = rig({ redis });
    const r = await processPaymentEvent('P1', REALM, deps);
    assert.equal(r.skipped, 'in_flight');
    assert.equal(sends.length, 0);
});

// ─── Boundary cases found in review ─────────────────────────────

test('Balance:false is not a settled invoice', async () => {
    for (const Balance of [false, true, [], {}, '', null]) {
        const v = await gate({ invoice: { Balance } });
        assert.notEqual(v.status, 'paid', `Balance ${JSON.stringify(Balance)} must never read as settled`);
    }
    // ...and a numeric string still works, because QuickBooks sends those.
    assert.equal((await gate({ invoice: { Balance: '0' } })).status, 'paid');
});

test('one invoice paid in two installments produces exactly one welcome', async () => {
    const redis = fakeRedis();
    const sends = [];
    // P1 pays half, P2 pays the rest. Balance is read live, so after P2 the invoice shows 0.
    const balances = { P1: 1249.5, P2: 0 };
    let current = 'P1';
    const deps = () => ({
        redis,
        kickoffUrl: () => '',
        terms: async () => null,
        qbApi: async (path) => {
            if (path.startsWith('/payment/')) {
                const id = path.split('/')[2].split('?')[0];
                return { Payment: pay({ Id: id, Line: [{ Amount: id === 'P1' ? 1249.5 : 1249.5,
                    LinkedTxn: [{ TxnId: '900', TxnType: 'Invoice' }] }] }) };
            }
            if (path.startsWith('/invoice/')) return { Invoice: inv({ Balance: balances[current] }) };
            return { Customer: { Id: '55', GivenName: 'Dana', PrimaryEmailAddr: { Address: 'dana@example.com' } } };
        },
        send: async (m) => { sends.push(m); return { id: 're_' + sends.length }; },
    });

    // P2 arrives and settles the invoice.
    current = 'P2';
    const second = await processPaymentEvent('P2', REALM, deps());
    assert.equal(second.outcome, 'activated');
    assert.equal(sends.length, 1);

    // THE CASE: P1's delivery was lost and arrives for the FIRST time afterwards. Its claim key is
    // its own payment id, so the per-event claim has never seen it, and the live balance now reads
    // zero, so the gate passes on its own terms. Only the per-invoice activation marker stops a
    // second welcome going to somebody who already got one.
    const late = await processPaymentEvent('P1', REALM, deps());
    assert.equal(late.outcome, 'already_activated_for_invoice');
    assert.equal(sends.length, 1, 'one onboarding invoice, one welcome');
});

test('terms belong to an opportunity, so a second deal does not inherit the first', async () => {
    const redis = fakeRedis();
    const store = { 'pilot:terms:REALM1:invoice:900': { kind: 'CASH_UPFRONT', cents: '180000' } };
    const reads = [];
    const termsRedis = { hgetall: async (k) => { reads.push(k); return store[k] || null; } };
    const { acceptedTerms } = await import('../api/_pilot-terms.js');

    const forDeal1 = await acceptedTerms({ realm: REALM, customerId: '55', invoiceId: '900' }, { redis: termsRedis });
    assert.equal(forDeal1.kind, 'CASH_UPFRONT');
    assert.equal(forDeal1.cents, 180000);

    // Same customer, different invoice. The first deal's terms must not answer for it.
    const forDeal2 = await acceptedTerms({ realm: REALM, customerId: '55', invoiceId: '901' }, { redis: termsRedis });
    assert.equal(forDeal2, null, 'a second deal starts with no recorded terms, not the first deal’s');
    assert.ok(reads.includes('pilot:terms:REALM1:invoice:901'));
});

test('legacy customer-scoped terms apply only to the invoice they name', async () => {
    const { acceptedTerms } = await import('../api/_pilot-terms.js');
    const store = { 'pilot:terms:REALM1:customer:55': { kind: 'CASH_UPFRONT', cents: '180000', invoiceId: '900' } };
    const r = { hgetall: async (k) => store[k] || null };
    assert.equal((await acceptedTerms({ realm: REALM, customerId: '55', invoiceId: '900' }, { redis: r })).cents, 180000);
    assert.equal(await acceptedTerms({ realm: REALM, customerId: '55', invoiceId: '901' }, { redis: r }), null);

    // A legacy record naming no invoice is ambiguous, so it applies to nothing.
    const vague = { hgetall: async (k) => (k === 'pilot:terms:REALM1:customer:55'
        ? { kind: 'CASH_UPFRONT', cents: '180000' } : null) };
    assert.equal(await acceptedTerms({ realm: REALM, customerId: '55', invoiceId: '900' }, { redis: vague }), null);
});
