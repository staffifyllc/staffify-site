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
import { processPaymentEvent } from './_pilot-activation.js';

const _redis = new Redis({
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
    const cached = await _redis.hgetall('qb:tokens');
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

    await _redis.hset('qb:tokens', {
        access_token: accessToken,
        access_expires_at: expiresAt,
        refresh_token: newRefreshToken,
        refresh_token_updated_at: now,
    });
    return accessToken;
}

async function _qbApi(path) {
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

let _lastResendCallAt = 0;

async function _sendViaResend({ to, subject, html, text, idempotencyKey }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.FROM_EMAIL || 'Staffify <hello@gostaffify.com>';
    if (!apiKey) throw new Error('RESEND_API_KEY not set');
    // Throttle: at most 4 requests/sec to stay under Resend's 5/sec free-tier cap
    const MIN_GAP_MS = 260;
    const since = Date.now() - _lastResendCallAt;
    if (since < MIN_GAP_MS) await new Promise(r => setTimeout(r, MIN_GAP_MS - since));
    _lastResendCallAt = Date.now();
    let attempt = 0;
    while (true) {
        const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
        // Resend honours this for 24 hours, so a retry after an ambiguous failure cannot double-send.
        if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 256);
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers,
            body: JSON.stringify({ from, to, subject, html, text, reply_to: 'hello@gostaffify.com' }),
        });
        if (r.ok) return r.json();
        // Backoff once on 429 (rate limit) before giving up
        if (r.status === 429 && attempt === 0) {
            attempt++;
            await new Promise(r => setTimeout(r, 1200));
            _lastResendCallAt = Date.now();
            continue;
        }
        throw new Error(`Resend ${r.status}: ${await r.text().catch(() => '')}`);
    }
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
                const r = await processPaymentEvent(ent.id, note.realmId, {
                    redis: _redis, qbApi: _qbApi, send: _sendViaResend,
                });
                results.push({ paymentId: ent.id, ...r });
            } catch (err) {
                console.error('payment processing error', err);
                // An unexpected throw is unknown, so it is retryable by default. Acknowledging it
                // would drop the event permanently.
                results.push({ paymentId: ent.id, error: String(err.message || err), retryable: true });
            }
        }
    }

    // A 200 tells Intuit the event is handled and they stop redelivering it. Anything we could not
    // finish, but might finish next time, must NOT be acknowledged: answer 503 so it comes back.
    const retry = results.filter((r) => r && r.retryable);
    if (retry.length) {
        return res.status(503).json({ ok: false, retrying: retry.length, processed: results });
    }
    return res.status(200).json({ ok: true, processed: results });
}
