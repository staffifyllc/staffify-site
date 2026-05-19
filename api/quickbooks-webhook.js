// POST /api/quickbooks-webhook/
// Fires when QuickBooks Online tells us an invoice/payment changed.
// We look for Payment events on Paid status, find the customer's email,
// match against subscriber DB, and if they're in status=client we send
// the onboarding email (intake form + strategy call link).
//
// Env vars:
//   QB_CLIENT_ID, QB_CLIENT_SECRET              — Intuit Developer app credentials
//   QB_REALM_ID                                 — the QuickBooks company ID we listen to
//   QB_WEBHOOK_VERIFIER_TOKEN                   — HMAC verification token from QB webhook config
//   RESEND_API_KEY, FROM_EMAIL                  — for sending the onboarding email
//   KV_REST_API_URL, KV_REST_API_TOKEN          — Upstash (stores rotated refresh+access tokens)

import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

// Prod base. Sandbox is https://sandbox-quickbooks.api.intuit.com
const QB_API_BASE = 'https://quickbooks.api.intuit.com';
const QB_OAUTH_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const INTAKE_FORM_URL = 'https://recruiting.gostaffify.com/client-intake';
const STRATEGY_CALL_URL = 'https://calendly.com/go-staffify/discovery-call?utm_content=strategy';

// We need the raw body for signature verification
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

// QB signs webhooks with HMAC-SHA-256 of the raw body using the verifier token,
// base64-encoded, sent as `intuit-signature` header.
function verifyQbSignature(rawBody, header, verifier) {
    if (!header || !verifier) return false;
    const expected = crypto.createHmac('sha256', verifier).update(rawBody).digest('base64');
    try {
        return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
    } catch {
        return false;
    }
}

// ─── OAuth token management ─────────────────────────────────────
async function getAccessToken() {
    // If we have a non-expired cached access token, use it.
    const cached = await redis.hgetall('qb:tokens');
    const now = Date.now();
    if (cached && cached.access_token && cached.access_expires_at && Number(cached.access_expires_at) > now + 60000) {
        return cached.access_token;
    }
    // Otherwise, refresh.
    const refreshToken = cached && cached.refresh_token;
    if (!refreshToken) throw new Error('No refresh token stored. Run OAuth first.');

    const basicAuth = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
    const res = await fetch(QB_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${basicAuth}`,
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`QB token refresh failed ${res.status}: ${detail}`);
    }
    const j = await res.json();
    const accessToken = j.access_token;
    const newRefreshToken = j.refresh_token || refreshToken; // QB sometimes rotates, sometimes not
    const expiresAt = now + (Number(j.expires_in || 3600) * 1000);

    await redis.hset('qb:tokens', {
        access_token: accessToken,
        access_expires_at: expiresAt,
        refresh_token: newRefreshToken,
        refresh_token_updated_at: now,
    });
    return accessToken;
}

async function qbApi(path) {
    const token = await getAccessToken();
    const realmId = process.env.QB_REALM_ID;
    const url = `${QB_API_BASE}/v3/company/${realmId}${path}`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
    if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new Error(`QB ${path} → ${r.status}: ${detail}`);
    }
    return r.json();
}

// ─── Email helpers ──────────────────────────────────────────────
function onboardingEmail({ firstName }) {
    const subject = "Welcome to Staffify — your next two steps";
    const text =
`Hey ${firstName},

Welcome to Staffify. Thanks for getting your onboarding fee in. We're officially building your team.

Two things to wrap up before we go live:

1) Client Intake Form (10 min): ${INTAKE_FORM_URL}
   This is how we map your role requirements, working style, brand, and the must-haves vs nice-to-haves for the person we're placing.

2) Strategy Call (30 min): ${STRATEGY_CALL_URL}
   Once you've sent us the intake, book a slot for us to walk through the role profile together. We'll cover sourcing timeline, screening process, and the rollout plan for week one.

Both links work in any order, but the strategy call is more useful after we've seen your intake answers.

Welcome aboard.

Paul
Founder, Staffify`;

    const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;"><tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;">
    <tr><td style="padding:36px 36px 28px 36px;font-size:16px;line-height:1.55;color:#1a1a1a;">
      <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
      <p style="margin:0 0 14px 0;">Welcome to Staffify. Thanks for getting your onboarding fee in. We're officially building your team.</p>
      <p style="margin:18px 0 8px 0;font-size:15px;"><strong>Two things to wrap up before we go live:</strong></p>
      <p style="margin:0 0 8px 0;"><strong>1) Client Intake Form</strong> (10 min)</p>
      <p style="margin:0 0 14px 0;font-size:15px;color:#4a4a4f;">How we map your role requirements, working style, brand, and the must-haves vs nice-to-haves for the person we're placing.</p>
      <p style="margin:18px 0;"><a href="${INTAKE_FORM_URL}" style="display:inline-block;background:#0c1118;color:#fff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600;font-size:15px;">Fill out the Intake Form →</a></p>
      <p style="margin:24px 0 8px 0;"><strong>2) Strategy Call</strong> (30 min)</p>
      <p style="margin:0 0 14px 0;font-size:15px;color:#4a4a4f;">Once you've sent us the intake, book a slot to walk through the role profile together. We'll cover sourcing timeline, screening process, and the rollout plan for week one.</p>
      <p style="margin:18px 0;"><a href="${STRATEGY_CALL_URL}" style="display:inline-block;background:#0c1118;color:#fff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600;font-size:15px;">Book your Strategy Call →</a></p>
      <p style="margin:24px 0 6px 0;">Welcome aboard.</p>
      <p style="margin:0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
    return { subject, text, html };
}

async function sendViaResend({ to, subject, html, text }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.FROM_EMAIL || 'Paul <paul@gostaffify.com>';
    if (!apiKey) throw new Error('RESEND_API_KEY not set');
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject, html, text, reply_to: 'paul@gostaffify.com' }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text().catch(() => '')}`);
    return r.json();
}

// ─── Process a single payment event ─────────────────────────────
async function processPaymentEvent(paymentId, realmId) {
    // Fetch the payment to see what invoice(s) it's linked to + customer ref
    const payRes = await qbApi(`/payment/${paymentId}?minorversion=70`);
    const payment = payRes.Payment;
    if (!payment) throw new Error(`Payment ${paymentId} not found`);

    const customerRef = payment.CustomerRef && payment.CustomerRef.value;
    if (!customerRef) return { skipped: 'no_customer_ref' };

    // Fetch the customer to get the email
    const custRes = await qbApi(`/customer/${customerRef}?minorversion=70`);
    const customer = custRes.Customer;
    const email = customer && customer.PrimaryEmailAddr && customer.PrimaryEmailAddr.Address;
    if (!email) return { skipped: 'no_email_on_customer', customerRef };

    const lowered = String(email).toLowerCase().trim();

    // Find the subscriber — accept any subscriber, but only fire onboarding for client status
    const sub = await redis.hgetall(`subscriber:${lowered}`);
    if (!sub || !sub.email) {
        return { skipped: 'subscriber_not_found', email: lowered };
    }

    // Idempotency: if we've already sent onboarding to this person, skip
    const alreadySent = await redis.get(`onboarding:sent:${lowered}`);
    if (alreadySent) return { skipped: 'onboarding_already_sent', email: lowered };

    // Send the onboarding email
    const firstName = sub.first_name || customer.GivenName || lowered.split('@')[0];
    const { subject, html, text } = onboardingEmail({ firstName });
    await sendViaResend({ to: lowered, subject, html, text });

    // Mark dedup + update subscriber
    const now = Date.now();
    await redis.set(`onboarding:sent:${lowered}`, now);
    await redis.hset(`subscriber:${lowered}`, {
        decision: 'client',
        paid_at: now,
        onboarding_email_sent_at: now,
        qb_payment_id: paymentId,
        qb_customer_id: customerRef,
    });

    return { sent: true, email: lowered, firstName };
}

// ─── Handler ────────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    let rawBody;
    try { rawBody = await readRawBody(req); }
    catch { return res.status(400).json({ error: 'bad_body' }); }

    const verifier = process.env.QB_WEBHOOK_VERIFIER_TOKEN;
    if (!verifier) {
        console.warn('quickbooks-webhook: QB_WEBHOOK_VERIFIER_TOKEN not set');
        return res.status(503).json({ error: 'webhook_not_configured' });
    }
    const sigHeader = req.headers['intuit-signature'];
    if (!verifyQbSignature(rawBody, sigHeader, verifier)) {
        return res.status(401).json({ error: 'invalid_signature' });
    }

    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { return res.status(400).json({ error: 'invalid_json' }); }

    const results = [];
    const notifications = payload.eventNotifications || [];
    const allowedRealm = process.env.QB_REALM_ID;

    for (const note of notifications) {
        if (allowedRealm && String(note.realmId) !== String(allowedRealm)) {
            results.push({ skipped: 'wrong_realm', realmId: note.realmId });
            continue;
        }
        const entities = (note.dataChangeEvent && note.dataChangeEvent.entities) || [];
        for (const ent of entities) {
            if (ent.name !== 'Payment') {
                results.push({ skipped: 'not_payment_entity', name: ent.name });
                continue;
            }
            try {
                const r = await processPaymentEvent(ent.id, note.realmId);
                results.push({ paymentId: ent.id, ...r });
            } catch (err) {
                console.error('payment processing error', err);
                results.push({ paymentId: ent.id, error: String(err.message || err) });
            }
        }
    }

    return res.status(200).json({ ok: true, processed: results });
}
