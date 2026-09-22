// Turning a verified onboarding payment into an activated client, and telling them so.
//
// Deliberately free of clients: everything external arrives through `deps`, so this module can be
// exercised as written instead of re-described in a test. The webhook owns the Redis, QuickBooks
// and Resend instances and passes them in.
import { activationFromPayment, isVerifiedPaid, verdictRetryable } from './_pilot-payment.js';
import { acceptedTerms } from './_pilot-terms.js';
import crypto from 'node:crypto';

const INTAKE_FORM_URL = 'https://recruiting.gostaffify.com/client-intake';

// ─── Email helpers ──────────────────────────────────────────────
//
// KICKOFF, NOT DISCOVERY. This email used to send a paying client to the discovery-call booking
// page under the name "Strategy Call (30 min)". That event does not exist: it was the top-of-funnel
// discovery event wearing a utm_content parameter, at whatever length that event happens to be. A
// client who has just paid does not belong in the discovery queue, and naming a call we do not have
// is the same defect as counting a task as a send.
//
// So the kickoff link is only used when a real kickoff event is configured. When it is not, the
// email says plainly that Paul will send times. No link, no invented duration, nothing to book.
export const defaultKickoffUrl = () => String(process.env.PILOT_KICKOFF_URL || '').trim();

export function onboardingEmail({ firstName, kickoff }) {
    const subject = 'Welcome to Staffify, here is what happens next';
    const step2Text = kickoff
        ? `2) Kickoff call: ${kickoff}
   Once your intake is in, book a time and we will walk through the role profile together: sourcing timeline, screening, and the plan for week one.`
        : `2) Kickoff call
   Once your intake is in, I will email you times for the kickoff so we can walk through the role profile together: sourcing timeline, screening, and the plan for week one.`;

    const text =
`Hey ${firstName},

Welcome to Staffify. Your onboarding fee is in and we are building your team.

Two things before we go live:

1) Client intake form (10 min): ${INTAKE_FORM_URL}
   This is how we map your role requirements, working style, brand, and the must-haves against the nice-to-haves for the person we place.

${step2Text}

Welcome aboard.

Paul
Founder, Staffify`;

    const step2Html = kickoff
        ? `<p style="margin:24px 0 8px 0;"><strong>2) Kickoff call</strong></p>
      <p style="margin:0 0 14px 0;font-size:15px;color:#4a4a4f;">Once your intake is in, book a time and we will walk through the role profile together: sourcing timeline, screening, and the plan for week one.</p>
      <p style="margin:18px 0;"><a href="${kickoff}" style="display:inline-block;background:#0c1118;color:#fff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600;font-size:15px;">Book your kickoff call</a></p>`
        : `<p style="margin:24px 0 8px 0;"><strong>2) Kickoff call</strong></p>
      <p style="margin:0 0 14px 0;font-size:15px;color:#4a4a4f;">Once your intake is in, I will email you times for the kickoff so we can walk through the role profile together: sourcing timeline, screening, and the plan for week one.</p>`;

    const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;"><tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;">
    <tr><td style="padding:36px 36px 28px 36px;font-size:16px;line-height:1.55;color:#1a1a1a;">
      <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
      <p style="margin:0 0 14px 0;">Welcome to Staffify. Your onboarding fee is in and we are building your team.</p>
      <p style="margin:18px 0 8px 0;font-size:15px;"><strong>Two things before we go live:</strong></p>
      <p style="margin:0 0 8px 0;"><strong>1) Client intake form</strong> (10 min)</p>
      <p style="margin:0 0 14px 0;font-size:15px;color:#4a4a4f;">How we map your role requirements, working style, brand, and the must-haves against the nice-to-haves for the person we place.</p>
      <p style="margin:18px 0;"><a href="${INTAKE_FORM_URL}" style="display:inline-block;background:#0c1118;color:#fff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600;font-size:15px;">Fill out the intake form</a></p>
      ${step2Html}
      <p style="margin:24px 0 6px 0;">Welcome aboard.</p>
      <p style="margin:0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
    return { subject, text, html };
}

// ─── Process a single payment event ─────────────────────────────
//
// WHAT THIS USED TO DO: fetch the payment, read the customer's email, and if that address existed
// as a subscriber, send the onboarding email and write decision='client' and paid_at. Any payment,
// any amount, any invoice or none.
//
// WHAT IT DOES NOW: activationFromPayment() is the only thing allowed to say paid, and it says so
// only for a payment that settles an invoice whose ItemRef IS the approved onboarding item, at the
// amount this opportunity actually accepted, for the same customer, in the expected company.
//
// Three separations the old version collapsed:
//   - the claim is atomic and keyed on the PAYMENT, so concurrent deliveries cannot both act and a
//     legitimate second payment is not suppressed by a lifetime per-email flag;
//   - a failure that might succeed later stays RETRYABLE and the webhook does not acknowledge it,
//     so Intuit redelivers instead of the event being lost to a permanent wrong answer;
//   - activation and communication are different facts. A failed email does not un-pay somebody,
//     and a sent email does not pay them.

const EVENT_TTL_MS = 1000 * 60 * 60 * 24 * 90;
const STALE_CLAIM_MS = 10 * 60 * 1000;

// Claim, take over a dead claim, or stand down. One round trip, no read-then-write race.
// A recorded outcome only blocks re-entry when it was final; a retryable outcome lets the next
// delivery back in.
const CLAIM_LUA = `
local key, token, now, stale, ttl = KEYS[1], ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local outcome = redis.call('HGET', key, 'outcome')
local retryable = redis.call('HGET', key, 'retryable')
if outcome and retryable ~= '1' then return {'done', outcome} end
local owner = redis.call('HGET', key, 'owner')
local claimedAt = redis.call('HGET', key, 'claimedAt')
if owner and claimedAt and (now - tonumber(claimedAt)) < stale then
  return {'busy', tostring(now - tonumber(claimedAt))}
end
local prior = owner or ''
redis.call('HSET', key, 'owner', token, 'claimedAt', ARGV[2])
redis.call('HDEL', key, 'outcome', 'retryable', 'why')
redis.call('PEXPIRE', key, ttl)
return {'ok', prior}
`;

// Only the worker that still holds the claim may record. A worker whose claim was taken over
// while it was running writes nothing, so it cannot overwrite the newer attempt's answer.
const RECORD_LUA = `
local key, token = KEYS[1], ARGV[1]
if redis.call('HGET', key, 'owner') ~= token then return 0 end
redis.call('HSET', key, 'outcome', ARGV[2], 'retryable', ARGV[3], 'decidedAt', ARGV[4], 'why', ARGV[5])
if ARGV[3] == '1' then redis.call('HDEL', key, 'owner') end
redis.call('PEXPIRE', key, tonumber(ARGV[6]))
return 1
`;

export async function processPaymentEvent(paymentId, realmId, deps = {}) {
    const { redis, qbApi, send: sendViaResend } = deps;
    if (!redis || !qbApi || !sendViaResend) throw new Error('processPaymentEvent needs redis, qbApi and send');
    const terms = deps.terms || acceptedTerms;
    const kickoffUrl = deps.kickoffUrl || defaultKickoffUrl;
    const newToken = deps.token || (() => crypto.randomUUID());

    const evt = `qb:payevent:${realmId}:${paymentId}`;
    const token = newToken();
    const claim = await redis.eval(CLAIM_LUA, [evt],
        [token, String(Date.now()), String(STALE_CLAIM_MS), String(EVENT_TTL_MS)]);
    const [state, detail] = Array.isArray(claim) ? claim : [];
    if (state === 'done') return { skipped: 'already_processed', outcome: detail };
    if (state === 'busy') return { skipped: 'in_flight', claimedMsAgo: Number(detail) || 0 };
    const tookOver = !!detail;

    const settle = async (outcome, { retryable = false, why = '', ...extra } = {}) => {
        const held = await redis.eval(RECORD_LUA, [evt],
            [token, outcome, retryable ? '1' : '0', String(Date.now()), String(why).slice(0, 300), String(EVENT_TTL_MS)]);
        return { outcome, retryable, ...(why ? { why } : {}), ...extra,
            ...(held === 1 ? {} : { note: 'claim was taken over while this attempt ran, so its answer was discarded' }),
            ...(tookOver ? { tookOverStaleClaim: true } : {}) };
    };

    let payment;
    try {
        const payRes = await qbApi(`/payment/${paymentId}?minorversion=70`);
        payment = payRes && payRes.Payment;
    } catch (e) {
        // QuickBooks being unreadable is unknown, not "not onboarding". Stays retryable.
        return settle('qb_unreadable', { retryable: true, why: String((e && e.message) || e) });
    }
    if (!payment) return settle('payment_not_found', { retryable: true, why: 'QuickBooks returned no Payment for this id' });

    // THE GATE. Nothing below runs for a payment that is not verified onboarding.
    let verdict;
    try {
        verdict = await activationFromPayment({
            payment,
            realm: realmId,
            expectedRealm: process.env.QB_REALM_ID,
            getInvoice: async (id) => {
                const r = await qbApi(`/invoice/${encodeURIComponent(id)}?minorversion=70`);
                return r && r.Invoice;
            },
            resolveTerms: (ref) => terms({ ...ref, realm: realmId }, { redis }),
        });
    } catch (e) {
        return settle('gate_failed', { retryable: true, why: String((e && e.message) || e) });
    }
    if (!isVerifiedPaid(verdict)) {
        return settle(`not_activated:${verdict.status}`, {
            retryable: verdictRetryable(verdict),
            why: String(verdict.why || ''),
        });
    }

    // INSTALLMENTS. Two payments can settle one onboarding invoice. Once the second clears the
    // balance, a redelivery of the FIRST payment's event passes this gate too, and its claim key is
    // a different payment id, so the per-event claim does not stop it. Onboarding is therefore
    // deduplicated on the INVOICE, which is the thing being paid for, not on the payment event.
    const actKey = `qb:activated:${realmId}:invoice:${verdict.invoiceId}`;
    const firstForInvoice = await redis.hsetnx(actKey, 'reference', verdict.reference);
    const prior = firstForInvoice ? null : ((await redis.hgetall(actKey)) || {});
    if (prior && prior.emailedAt) {
        return settle('already_activated_for_invoice', {
            reference: prior.reference || verdict.reference,
            invoiceId: verdict.invoiceId,
            why: 'this onboarding invoice is already activated and the welcome was already sent',
        });
    }
    if (firstForInvoice) {
        await redis.hset(actKey, { activatedAt: Date.now(), paymentId: String(paymentId),
            customerId: String(verdict.customerId), termsAccepted: verdict.termsAccepted ? 'true' : 'false' });
    }

    // Identify the person from the INVOICE's customer, not from whoever the payment was keyed to.
    let email = '';
    let customer = {};
    try {
        const custRes = await qbApi(`/customer/${encodeURIComponent(verdict.customerId)}?minorversion=70`);
        customer = (custRes && custRes.Customer) || {};
        email = String((customer.PrimaryEmailAddr && customer.PrimaryEmailAddr.Address) || '').toLowerCase().trim();
    } catch (e) {
        return settle('customer_unreadable', { retryable: true, why: String((e && e.message) || e) });
    }
    if (!email) {
        return settle('paid_but_no_email', { why: 'the paying customer has no email address in QuickBooks',
            reference: verdict.reference, customerId: verdict.customerId });
    }

    // Activation is written from the verified reference and does not depend on the email going out.
    // `email` is written explicitly: this hash may not exist yet, and a subscriber record without
    // its own address is unreadable by everything downstream.
    const key = `subscriber:${email}`;
    const priorName = await redis.hget(key, 'first_name').catch(() => '');
    await redis.hset(key, {
        email,
        decision: 'client',
        paid_at: Date.now(),
        activation_kind: verdict.termsKind || 'CASH_UPFRONT',
        activation_terms_accepted: verdict.termsAccepted ? 'true' : 'false',
        activation_amount: (Number(verdict.amountCents || 0) / 100).toFixed(2),
        activation_reference: verdict.reference,
        qb_payment_id: String(paymentId),
        qb_customer_id: String(verdict.customerId),
        qb_invoice_id: String(verdict.invoiceId),
    });

    // Communication is a separate fact with its own evidence.
    const firstName = priorName || customer.GivenName || email.split('@')[0];
    const { subject, html, text } = onboardingEmail({ firstName, kickoff: kickoffUrl() });
    let providerId = '';
    try {
        const sent = await sendViaResend({
            to: email, subject, html, text,
            // Keyed on the INVOICE, not the payment: two installments settling one onboarding
            // invoice must not produce two welcomes even if both events reach the send.
            idempotencyKey: `qb-onboarding:${realmId}:invoice:${verdict.invoiceId}`,
        });
        providerId = String((sent && sent.id) || '');
        if (!providerId) throw new Error('Resend accepted the request but returned no message id');
    } catch (e) {
        await redis.hset(key, { onboarding_email_error: String((e && e.message) || e).slice(0, 300) });
        // Activated, not told. Retryable: activation above is idempotent and the provider key stops
        // a duplicate, so the next delivery can finish the job instead of the person never hearing.
        return settle('activated_email_failed', { retryable: true,
            why: String((e && e.message) || e), reference: verdict.reference, email });
    }

    await redis.hset(key, {
        onboarding_email_sent_at: Date.now(),
        onboarding_email_provider_id: providerId,
        onboarding_email_error: '',
    });
    await redis.hset(actKey, { emailedAt: Date.now(), providerId, email });
    return settle('activated', { reference: verdict.reference, email, providerId,
        termsAccepted: !!verdict.termsAccepted, kickoffLinked: !!kickoffUrl() });
}

