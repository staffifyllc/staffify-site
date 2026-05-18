// POST /api/subscribe
// Stores the email in Upstash Redis and fires the playbook delivery via Resend.
// No external marketing tool. We own the list.
//
// Env vars required (set in Vercel project settings):
//   RESEND_API_KEY          — from https://resend.com/api-keys
//   UPSTASH_REDIS_REST_URL  — from Vercel → Storage → connected Upstash KV
//   UPSTASH_REDIS_REST_TOKEN
//   FROM_EMAIL              — verified sender (e.g. "Paul <paul@gostaffify.com>")

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const PLAYBOOK_URL = 'https://www.gostaffify.com/playbook/';
const CALENDLY_URL = 'https://calendly.com/go-staffify/discovery-call';

const ALLOWED_ORIGINS = [
    'https://www.gostaffify.com',
    'https://gostaffify.com',
    'http://localhost:3000',
];

function corsHeaders(origin) {
    const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin': allow,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
    };
}

function isValidEmail(s) {
    return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length < 254;
}

function renderEmail(email) {
    const greeting = 'Hey,';
    const body = `
Here's the playbook you signed up for. Six chapters on the operational moves that separate the $300K service businesses from the $3M ones.

Read it here: ${PLAYBOOK_URL}

What's inside:
  • The Bottleneck Audit (60-minute framework)
  • The Delegation Matrix
  • The Hiring Funnel that doesn't collapse
  • Pricing Power for Service Businesses
  • The 95% Retention System
  • The Operations Layer behind every hire

If any of it lands and you want to talk about putting it into practice in your business, my calendar is here:

${CALENDLY_URL}

Paul
Founder, Staffify
`.trim();

    const text = `${greeting}\n\n${body}`;

    const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;">
        <tr><td style="padding:36px 36px 28px 36px;">
          <p style="margin:0 0 14px 0;font-size:16px;line-height:1.55;">Hey,</p>
          <p style="margin:0 0 14px 0;font-size:16px;line-height:1.55;">Here's the playbook you signed up for. Six chapters on the operational moves that separate the $300K service businesses from the $3M ones.</p>
          <p style="margin:18px 0;">
            <a href="${PLAYBOOK_URL}" style="display:inline-block;background:#0c1118;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600;font-size:15px;">Read the Playbook →</a>
          </p>
          <p style="margin:18px 0 8px 0;font-size:15px;line-height:1.55;"><strong>What's inside:</strong></p>
          <ul style="margin:0 0 18px 0;padding-left:20px;font-size:15px;line-height:1.7;">
            <li>The Bottleneck Audit (60-minute framework)</li>
            <li>The Delegation Matrix</li>
            <li>The Hiring Funnel that doesn't collapse</li>
            <li>Pricing Power for Service Businesses</li>
            <li>The 95% Retention System</li>
            <li>The Operations Layer behind every hire</li>
          </ul>
          <p style="margin:0 0 14px 0;font-size:15px;line-height:1.55;">If any of it lands and you want to talk about putting it into practice in your business, my calendar is here:</p>
          <p style="margin:0 0 22px 0;font-size:15px;line-height:1.55;"><a href="${CALENDLY_URL}" style="color:#0c1118;">${CALENDLY_URL}</a></p>
          <p style="margin:0;font-size:15px;line-height:1.55;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>
        </td></tr>
        <tr><td style="padding:18px 36px 28px 36px;border-top:1px solid #eee;font-size:12px;color:#888;line-height:1.5;">
          You're receiving this because you requested the Operator's Playbook at gostaffify.com.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

    return { text, html };
}

async function sendViaResend({ to, subject, html, text }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.FROM_EMAIL || 'Paul <paul@gostaffify.com>';
    if (!apiKey) throw new Error('RESEND_API_KEY not set');

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to, subject, html, text, reply_to: 'paul@gostaffify.com' }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Resend ${res.status}: ${detail}`);
    }
    return res.json();
}

export default async function handler(req, res) {
    const origin = req.headers.origin || '';
    const cors = corsHeaders(origin);
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const email = (body.email || '').toString().trim().toLowerCase();
    const source = (body.source || 'unknown').toString().slice(0, 64);
    // Honeypot: if 'website' field is populated, silently accept and bail.
    if (body.website) return res.status(200).json({ ok: true });

    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'invalid_email' });
    }

    const now = Date.now();
    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 256);

    try {
        // Rate-limit by IP: 10 signups per hour
        if (ip) {
            const rlKey = `rl:subscribe:${ip}`;
            const count = await redis.incr(rlKey);
            if (count === 1) await redis.expire(rlKey, 3600);
            if (count > 10) return res.status(429).json({ error: 'rate_limited' });
        }

        // Has this email signed up before?
        const existing = await redis.hget(`subscriber:${email}`, 'signed_up_at');

        // Upsert subscriber record
        await redis.hset(`subscriber:${email}`, {
            email,
            source,
            signed_up_at: existing || now,
            last_seen_at: now,
            ip,
            ua,
        });
        await redis.zadd('subscribers:by_date', { score: existing ? Number(existing) : now, member: email });

        // Only send the welcome/delivery email on first signup
        if (!existing) {
            await sendViaResend({
                to: email,
                subject: "Your Service Business Operator's Playbook is here",
                ...renderEmail(email),
            });
            await redis.hset(`subscriber:${email}`, { playbook_sent_at: Date.now() });
        }

        return res.status(200).json({ ok: true, returning: !!existing });
    } catch (err) {
        console.error('subscribe error', err);
        return res.status(500).json({ error: 'server_error' });
    }
}
