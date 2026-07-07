// POST /api/sales-application
// Application intake for the 1099 remote sales position (/careers/sales/).
// NOT connected to the talent console — standalone. Emails Paul at
// hello@gostaffify.com and stores a copy in Redis.
//
// Env vars required (already set in Vercel):
//   RESEND_API_KEY, KV_REST_API_URL, KV_REST_API_TOKEN, FROM_EMAIL

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

const EXPERIENCE_LEVELS = ['<1', '1-3', '3-5', '5+'];
const AVAILABILITY = ['10-20', '20-30', '30-40', '40+'];

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

async function sendViaResend({ subject, html, text, replyTo }) {
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
            reply_to: replyTo || 'hello@gostaffify.com',
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

    // Honeypot
    if (body.website) return res.status(200).json({ ok: true });

    // Prepend https:// to bare URLs so pasted "linkedin.com/in/x" links stay clickable
    const normalizeUrl = (s) => {
        const v = (s || '').toString().trim().slice(0, 300);
        if (!v) return '';
        return /^https?:\/\//i.test(v) ? v : `https://${v}`;
    };

    const name = (body.name || '').toString().trim().slice(0, 120);
    const email = (body.email || '').toString().trim().toLowerCase();
    const phone = (body.phone || '').toString().trim().slice(0, 40);
    const location = (body.location || '').toString().trim().slice(0, 120);
    const linkedin = normalizeUrl(body.linkedin);
    const experience = (body.experience || '').toString().trim();
    const sold = (body.sold || '').toString().trim().slice(0, 500);
    const win = (body.win || '').toString().trim().slice(0, 3000);
    const availability = (body.availability || '').toString().trim();
    const video = normalizeUrl(body.video);

    if (!name) return res.status(400).json({ error: 'name_required' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' });
    if (phone.replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'phone_required' });
    if (!location) return res.status(400).json({ error: 'location_required' });
    if (!linkedin || !linkedin.includes('.')) return res.status(400).json({ error: 'linkedin_required' });
    if (!EXPERIENCE_LEVELS.includes(experience)) return res.status(400).json({ error: 'invalid_experience' });
    if (!sold) return res.status(400).json({ error: 'sold_required' });
    if (!win) return res.status(400).json({ error: 'win_required' });
    if (!AVAILABILITY.includes(availability)) return res.status(400).json({ error: 'invalid_availability' });
    if (!video || !video.includes('.')) return res.status(400).json({ error: 'video_required' });

    const now = Date.now();
    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 256);

    try {
        // Rate-limit by IP: 4 applications per hour
        if (ip) {
            const rlKey = `rl:sales-app:${ip}`;
            const count = await redis.incr(rlKey);
            if (count === 1) await redis.expire(rlKey, 3600);
            if (count > 4) return res.status(429).json({ error: 'rate_limited' });
        }

        // One application per email, ever. Backfill the dedupe set from
        // existing records on first run, then silently swallow duplicates
        // (200 ok, no record, no email) so repeat submitters learn nothing.
        const emailSetSize = await redis.scard('salesapps:emails');
        if (!emailSetSize) {
            const existing = await redis.zrange('salesapps:by_date', 0, -1);
            for (const id of existing) {
                const parts = String(id).split(':');
                if (parts.length >= 3) await redis.sadd('salesapps:emails', parts.slice(2).join(':'));
            }
        }
        const isDupeEmail = await redis.sismember('salesapps:emails', email);
        if (isDupeEmail) return res.status(200).json({ ok: true });

        // Lifetime cap per IP (no expiry): 3 submissions, then silent swallow
        if (ip) {
            const lifeCount = await redis.incr(`salesapps:ipcount:${ip}`);
            if (lifeCount > 3) return res.status(200).json({ ok: true });
        }

        await redis.sadd('salesapps:emails', email);

        const appId = `salesapp:${now}:${email}`;
        await redis.hset(appId, {
            name, email, phone, location, linkedin, experience, sold, win, availability, video,
            source: 'careers-sales',
            created_at: now,
            ip, ua,
        });
        await redis.zadd('salesapps:by_date', { score: now, member: appId });

        const subject = `Sales applicant: ${name} — ${experience} yrs, ${location}`;

        const text = `New 1099 sales application from gostaffify.com/careers/sales/

Name:          ${name}
Email:         ${email}
Phone:         ${phone || '(not provided)'}
Location:      ${location}
LinkedIn:      ${linkedin || '(not provided)'}
Experience:    ${experience} years B2B sales
Availability:  ${availability} hrs/wk
Video intro:   ${video || '(not provided)'}

What they've sold:
${sold}

Biggest win:
${win}

Reply directly to reach them.
`;

        const row = (label, value, isLink) => `
          <tr>
            <td style="padding:10px 0;border-top:1px solid #eee;font-size:12px;font-weight:600;color:#71798a;letter-spacing:0.06em;text-transform:uppercase;width:110px;vertical-align:top;">${label}</td>
            <td style="padding:10px 0;border-top:1px solid #eee;font-size:15px;color:#14181f;">${value ? (isLink ? `<a href="${escapeHtml(value)}" style="color:#0d82b8;">${escapeHtml(value)}</a>` : escapeHtml(value)) : '<span style="color:#aaa;">(not provided)</span>'}</td>
          </tr>`;

        const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea;">
  <tr><td align="center" style="padding:40px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.08);">
      <tr><td style="background:linear-gradient(90deg,#1abde1 0%,#0fa3c5 55%,#0d82b8 100%);height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:32px 36px 8px;">
        <p style="margin:0 0 8px 0;font-size:11px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#0fa3c5;">Sales Application · 1099 Remote</p>
        <h1 style="margin:0 0 22px 0;font-size:22px;font-weight:700;color:#14181f;line-height:1.3;">${escapeHtml(name)} wants to sell for Staffify.</h1>
      </td></tr>
      <tr><td style="padding:0 36px 10px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          ${row('Email', email)}
          ${row('Phone', phone)}
          ${row('Location', location)}
          ${row('LinkedIn', linkedin, true)}
          ${row('Experience', experience + ' years B2B sales')}
          ${row('Hours/wk', availability)}
          ${row('Video intro', video, true)}
        </table>
      </td></tr>
      <tr><td style="padding:0 36px 8px;">
        <div style="padding:14px 18px;background:#f4f1ea;border-radius:10px;border-left:3px solid #1abde1;margin-bottom:12px;">
          <p style="margin:0 0 6px 0;font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#0fa3c5;">What they've sold</p>
          <p style="margin:0;font-size:14px;color:#3a4150;line-height:1.6;white-space:pre-wrap;">${escapeHtml(sold)}</p>
        </div>
        <div style="padding:14px 18px;background:#f4f1ea;border-radius:10px;border-left:3px solid #1abde1;">
          <p style="margin:0 0 6px 0;font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#0fa3c5;">Biggest win</p>
          <p style="margin:0;font-size:14px;color:#3a4150;line-height:1.6;white-space:pre-wrap;">${escapeHtml(win)}</p>
        </div>
      </td></tr>
      <tr><td style="padding:16px 36px 28px;">
        <p style="margin:0;font-size:13px;color:#71798a;">Reply directly to reach them. Captured from gostaffify.com/careers/sales/.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

        await sendViaResend({ subject, html, text, replyTo: email });

        return res.status(200).json({ ok: true });
    } catch (err) {
        console.error('sales-application error', err);
        return res.status(500).json({ error: 'server_error' });
    }
}
