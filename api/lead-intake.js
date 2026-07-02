// POST /api/lead-intake
// Captures visitor intent from the "What's your next move?" bubbles on /how-it-works/
// and emails Paul at hello@gostaffify.com. Stores a copy in Redis for record-keeping.
//
// Env vars required (set in Vercel project settings):
//   RESEND_API_KEY          — from https://resend.com/api-keys
//   KV_REST_API_URL         — from Vercel → Storage → connected Upstash KV
//   KV_REST_API_TOKEN
//   FROM_EMAIL              — verified sender (e.g. "Staffify <hello@gostaffify.com>")

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const NOTIFY_TO = 'hello@gostaffify.com';

const ALLOWED_ORIGINS = [
    'https://www.gostaffify.com',
    'https://gostaffify.com',
    'http://localhost:3000',
];

const INTENT_LABELS = {
    'talk-first': 'Wants to talk it through first (strategy call)',
    'ready-single': 'Ready to start with one VA',
    'volume': 'Hiring 3+ people (volume pricing)',
};

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

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function sendViaResend({ subject, html, text }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.FROM_EMAIL || 'Staffify <hello@gostaffify.com>';
    if (!apiKey) throw new Error('RESEND_API_KEY not set');

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from,
            to: NOTIFY_TO,
            subject,
            html,
            text,
            reply_to: 'hello@gostaffify.com',
        }),
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

    // Honeypot: if 'website' field is populated, silently accept and bail.
    if (body.website) return res.status(200).json({ ok: true });

    const name = (body.name || '').toString().trim().slice(0, 120);
    const email = (body.email || '').toString().trim().toLowerCase();
    const company = (body.company || '').toString().trim().slice(0, 120);
    const intent = (body.intent || '').toString().trim();
    const note = (body.note || '').toString().trim().slice(0, 2000);

    if (!name) return res.status(400).json({ error: 'name_required' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' });
    if (!INTENT_LABELS[intent]) return res.status(400).json({ error: 'invalid_intent' });

    const now = Date.now();
    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 256);

    try {
        // Rate-limit by IP: 6 submissions per hour
        if (ip) {
            const rlKey = `rl:lead-intake:${ip}`;
            const count = await redis.incr(rlKey);
            if (count === 1) await redis.expire(rlKey, 3600);
            if (count > 6) return res.status(429).json({ error: 'rate_limited' });
        }

        // Store record for later CRM push / reporting
        const leadId = `lead:${now}:${email}`;
        await redis.hset(leadId, {
            email, name, company, intent, note,
            source: 'how-it-works',
            created_at: now,
            ip, ua,
        });
        await redis.zadd('leads:by_date', { score: now, member: leadId });
        await redis.zadd(`leads:intent:${intent}`, { score: now, member: leadId });

        const intentLabel = INTENT_LABELS[intent];
        const subject = `New Staffify lead: ${name} — ${intentLabel}`;

        const noteBlock = note ? `\n\nTheir note:\n${note}` : '';
        const text = `New lead from gostaffify.com/how-it-works/

Name:     ${name}
Email:    ${email}
Company:  ${company || '(not provided)'}
Intent:   ${intentLabel}${noteBlock}

Reply directly to reach them.
`;

        const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea;">
  <tr><td align="center" style="padding:40px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.08);">
      <tr><td style="background:linear-gradient(90deg,#1abde1 0%,#0fa3c5 55%,#0d82b8 100%);height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:32px 36px 8px;">
        <p style="margin:0 0 8px 0;font-size:11px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#0fa3c5;">New Lead · How It Works</p>
        <h1 style="margin:0 0 24px 0;font-size:22px;font-weight:700;color:#14181f;line-height:1.3;">${escapeHtml(name)} wants to move.</h1>
      </td></tr>
      <tr><td style="padding:0 36px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            <td style="padding:12px 0;border-top:1px solid #eee;font-size:12px;font-weight:600;color:#71798a;letter-spacing:0.06em;text-transform:uppercase;width:100px;">Email</td>
            <td style="padding:12px 0;border-top:1px solid #eee;font-size:15px;color:#14181f;"><a href="mailto:${escapeHtml(email)}" style="color:#0d82b8;text-decoration:none;font-weight:600;">${escapeHtml(email)}</a></td>
          </tr>
          <tr>
            <td style="padding:12px 0;border-top:1px solid #eee;font-size:12px;font-weight:600;color:#71798a;letter-spacing:0.06em;text-transform:uppercase;">Company</td>
            <td style="padding:12px 0;border-top:1px solid #eee;font-size:15px;color:#14181f;">${company ? escapeHtml(company) : '<span style="color:#aaa;">(not provided)</span>'}</td>
          </tr>
          <tr>
            <td style="padding:12px 0;border-top:1px solid #eee;font-size:12px;font-weight:600;color:#71798a;letter-spacing:0.06em;text-transform:uppercase;">Intent</td>
            <td style="padding:12px 0;border-top:1px solid #eee;font-size:15px;color:#14181f;font-weight:600;">${escapeHtml(intentLabel)}</td>
          </tr>
        </table>
        ${note ? `
        <div style="margin-top:20px;padding:16px 18px;background:#f4f1ea;border-radius:10px;border-left:3px solid #1abde1;">
          <p style="margin:0 0 8px 0;font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#0fa3c5;">Their note</p>
          <p style="margin:0;font-size:14px;color:#3a4150;line-height:1.6;white-space:pre-wrap;">${escapeHtml(note)}</p>
        </div>` : ''}
        <p style="margin:24px 0 0;font-size:13px;color:#71798a;">Reply directly to reach them. Captured from gostaffify.com/how-it-works/.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

        await sendViaResend({ subject, html, text });

        return res.status(200).json({ ok: true });
    } catch (err) {
        console.error('lead-intake error', err);
        return res.status(500).json({ error: 'server_error' });
    }
}
