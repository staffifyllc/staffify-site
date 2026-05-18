// POST /api/calendly-webhook/
// Fires when someone books a Calendly meeting. Detects role from utm_content
// on the booking URL, sends a tailored case study / nurture email via Resend,
// and stores the prospect in Upstash with source=discovery-call-booked.
//
// Env vars required:
//   CALENDLY_WEBHOOK_SIGNING_KEY  — from Calendly when you create the webhook
//   RESEND_API_KEY
//   FROM_EMAIL                    — e.g. "Paul <paul@gostaffify.com>"
//   KV_REST_API_URL / KV_REST_API_TOKEN
//
// Calendly link convention: append ?utm_content=editors|admins|csr|sales
// to the booking URL on each role landing page so the role is auto-detected.

import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

// We need the raw body for signature verification, so disable Vercel's parser.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

// Calendly signs webhooks as: header value "t=<timestamp>,v1=<hex-sha256>"
// where the HMAC-SHA-256 is computed over `<timestamp>.<raw-body>`
function verifyCalendlySignature(rawBody, header, signingKey) {
    if (!header || !signingKey) return false;
    const parts = {};
    for (const seg of String(header).split(',')) {
        const [k, v] = seg.split('=');
        if (k && v) parts[k.trim()] = v.trim();
    }
    if (!parts.t || !parts.v1) return false;

    // Reject signatures older than 5 minutes (replay protection)
    const ageSec = Math.abs(Date.now() / 1000 - Number(parts.t));
    if (!Number.isFinite(ageSec) || ageSec > 300) return false;

    const signed = `${parts.t}.${rawBody}`;
    const expected = crypto.createHmac('sha256', signingKey).update(signed).digest('hex');
    try {
        return crypto.timingSafeEqual(
            Buffer.from(parts.v1, 'hex'),
            Buffer.from(expected, 'hex'),
        );
    } catch {
        return false;
    }
}

// ─── Role mapping ───────────────────────────────────────────────
function normalizeRole(utm) {
    if (!utm) return 'default';
    const s = String(utm).toLowerCase();
    if (s.includes('editor') || s === 'video' || s === 've') return 'editors';
    if (s.includes('admin') || s.includes('exec') || s === 'ea') return 'admins';
    if (s.includes('csr') || s.includes('customer') || s.includes('support')) return 'csr';
    if (s.includes('sale') || s.includes('sdr') || s.includes('campaign') || s === 'outbound') return 'sales';
    return 'default';
}

// ─── Email templates (per role) ─────────────────────────────────
function shellHTML({ subject, bodyHTML }) {
    return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;">
      <tr><td style="padding:36px 36px 28px 36px;font-size:16px;line-height:1.55;color:#1a1a1a;">${bodyHTML}</td></tr>
      <tr><td style="padding:18px 36px 28px 36px;border-top:1px solid #eee;font-size:12px;color:#888;line-height:1.5;">
        You're receiving this because you booked a discovery call at gostaffify.com.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function btn(href, label) {
    return `<p style="margin:18px 0;"><a href="${href}" style="display:inline-block;background:#0c1118;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600;font-size:15px;">${label}</a></p>`;
}

const TEMPLATES = {
    editors: ({ firstName }) => ({
        subject: "Before our call: how Flylisted cut editing spend 60%",
        text:
`Hey ${firstName},

Saw you booked a call about video editing — looking forward to it.

While you're waiting, here's a real customer story that probably mirrors what you're trying to solve. Flylisted, a real estate marketing company in Boston and South Florida, cut their video editing spend by 60% by replacing pay-per-video freelance with a dedicated Staffify editor.

Read it: https://www.gostaffify.com/case-studies/flylisted/

It'll give us a head start on the call — you'll have a concrete model to react to instead of starting from scratch.

See you soon.

Paul
Founder, Staffify`,
        html: shellHTML({
            subject: "Before our call: how Flylisted cut editing spend 60%",
            bodyHTML: `
                <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
                <p style="margin:0 0 14px 0;">Saw you booked a call about video editing — looking forward to it.</p>
                <p style="margin:0 0 14px 0;">While you're waiting, here's a real customer story that probably mirrors what you're trying to solve. <strong>Flylisted</strong>, a real estate marketing company in Boston and South Florida, cut their video editing spend by <strong>60%</strong> by replacing pay-per-video freelance with a dedicated Staffify editor.</p>
                ${btn('https://www.gostaffify.com/case-studies/flylisted/', 'Read the Flylisted case study →')}
                <p style="margin:14px 0 0 0;">It'll give us a head start on the call — you'll have a concrete model to react to instead of starting from scratch.</p>
                <p style="margin:18px 0 6px 0;">See you soon.</p>
                <p style="margin:0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>`,
        }),
    }),

    admins: ({ firstName }) => ({
        subject: "Before our call: the Operator Trap",
        text:
`Hey ${firstName},

Saw you booked a call about executive admin support — looking forward to it.

Worth a 7-minute read before we hop on. "The Operator Trap" is about why service businesses stall around $1M and the operational moves that get them unstuck. Most of our admin placements are made by founders who recognize themselves in it.

Read it: https://www.gostaffify.com/blog/operator-trap/

If you want a sharper sense of what to delegate vs keep, also worth a look: https://www.gostaffify.com/blog/delegation-matrix/

Talk soon.

Paul
Founder, Staffify`,
        html: shellHTML({
            subject: "Before our call: the Operator Trap",
            bodyHTML: `
                <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
                <p style="margin:0 0 14px 0;">Saw you booked a call about executive admin support — looking forward to it.</p>
                <p style="margin:0 0 14px 0;">Worth a 7-minute read before we hop on. <strong>"The Operator Trap"</strong> is about why service businesses stall around $1M and the operational moves that get them unstuck. Most of our admin placements are made by founders who recognize themselves in it.</p>
                ${btn('https://www.gostaffify.com/blog/operator-trap/', 'Read The Operator Trap →')}
                <p style="margin:14px 0 0 0;">If you want a sharper sense of what to delegate vs. keep, also worth a look: <a href="https://www.gostaffify.com/blog/delegation-matrix/" style="color:#0c1118;">The Delegation Matrix</a>.</p>
                <p style="margin:18px 0 6px 0;">Talk soon.</p>
                <p style="margin:0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>`,
        }),
    }),

    csr: ({ firstName }) => ({
        subject: "Before our call: when CSR makes sense",
        text:
`Hey ${firstName},

Saw you booked a call about customer service support — looking forward to it.

One thing worth reading before we meet. "First Employee vs. VA" walks through when each makes sense, what the unit economics look like, and how to know which fits your stage.

Read it: https://www.gostaffify.com/blog/first-employee-vs-va/

The CSR overview if you want the full picture: https://www.gostaffify.com/csr/

Talk soon.

Paul
Founder, Staffify`,
        html: shellHTML({
            subject: "Before our call: when CSR makes sense",
            bodyHTML: `
                <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
                <p style="margin:0 0 14px 0;">Saw you booked a call about customer service support — looking forward to it.</p>
                <p style="margin:0 0 14px 0;">One thing worth reading before we meet. <strong>"First Employee vs. VA"</strong> walks through when each makes sense, what the unit economics look like, and how to know which fits your stage.</p>
                ${btn('https://www.gostaffify.com/blog/first-employee-vs-va/', 'Read First Employee vs. VA →')}
                <p style="margin:14px 0 0 0;">The full CSR overview if you want it: <a href="https://www.gostaffify.com/csr/" style="color:#0c1118;">gostaffify.com/csr</a></p>
                <p style="margin:18px 0 6px 0;">Talk soon.</p>
                <p style="margin:0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>`,
        }),
    }),

    sales: ({ firstName }) => ({
        subject: "Before our call: the outbound stack",
        text:
`Hey ${firstName},

Saw you booked a call about sales / SDR support — looking forward to it.

Quick read before we hop on. Here's how we run the outbound stack end to end: verified leads, automated email that doesn't tank deliverability, and an SDR VA who picks up the phone on warm replies so meetings actually land on your calendar.

Read it: https://www.gostaffify.com/campaigns/

If you want the why behind "intelligence + human" instead of pure automation, also: https://www.gostaffify.com/blog/operator-trap/

Talk soon.

Paul
Founder, Staffify`,
        html: shellHTML({
            subject: "Before our call: the outbound stack",
            bodyHTML: `
                <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
                <p style="margin:0 0 14px 0;">Saw you booked a call about sales / SDR support — looking forward to it.</p>
                <p style="margin:0 0 14px 0;">Quick read before we hop on. Here's how we run the outbound stack end to end: verified leads, automated email that doesn't tank deliverability, and an SDR VA who picks up the phone on warm replies so meetings actually land on your calendar.</p>
                ${btn('https://www.gostaffify.com/campaigns/', 'See the outbound stack →')}
                <p style="margin:14px 0 0 0;">If you want the why behind "intelligence + human" instead of pure automation: <a href="https://www.gostaffify.com/blog/operator-trap/" style="color:#0c1118;">The Operator Trap</a>.</p>
                <p style="margin:18px 0 6px 0;">Talk soon.</p>
                <p style="margin:0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>`,
        }),
    }),

    default: ({ firstName }) => ({
        subject: "Before our call: the Operator's Playbook",
        text:
`Hey ${firstName},

Saw you booked a call — looking forward to it.

In case you haven't seen it, here's the playbook we put together for service business operators. Six chapters on the operational moves that separate the $300K businesses from the $3M ones. Skim whatever's relevant.

Read it: https://www.gostaffify.com/playbook/

Talk soon.

Paul
Founder, Staffify`,
        html: shellHTML({
            subject: "Before our call: the Operator's Playbook",
            bodyHTML: `
                <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
                <p style="margin:0 0 14px 0;">Saw you booked a call — looking forward to it.</p>
                <p style="margin:0 0 14px 0;">In case you haven't seen it, here's the playbook we put together for service business operators. Six chapters on the operational moves that separate the $300K businesses from the $3M ones. Skim whatever's relevant before we talk.</p>
                ${btn('https://www.gostaffify.com/playbook/', 'Read the Playbook →')}
                <p style="margin:18px 0 6px 0;">Talk soon.</p>
                <p style="margin:0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>`,
        }),
    }),
};

// ─── Resend send ────────────────────────────────────────────────
async function sendViaResend({ to, subject, html, text }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.FROM_EMAIL || 'Paul <paul@gostaffify.com>';
    if (!apiKey) throw new Error('RESEND_API_KEY not set');
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject, html, text, reply_to: 'paul@gostaffify.com' }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Resend ${res.status}: ${detail}`);
    }
    return res.json();
}

// ─── Handler ────────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    let rawBody;
    try { rawBody = await readRawBody(req); }
    catch { return res.status(400).json({ error: 'bad_body' }); }

    const sigHeader = req.headers['calendly-webhook-signature'];
    const signingKey = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;

    if (!signingKey) {
        console.warn('calendly-webhook: CALENDLY_WEBHOOK_SIGNING_KEY not set');
        return res.status(503).json({ error: 'webhook_not_configured' });
    }
    if (!verifyCalendlySignature(rawBody, sigHeader, signingKey)) {
        return res.status(401).json({ error: 'invalid_signature' });
    }

    let event;
    try { event = JSON.parse(rawBody); }
    catch { return res.status(400).json({ error: 'invalid_json' }); }

    if (event.event !== 'invitee.created') {
        return res.status(200).json({ ok: true, skipped: event.event });
    }

    const p = event.payload || {};
    const email = String(p.email || '').toLowerCase().trim();
    const firstName = p.first_name || String(p.name || '').split(' ')[0] || 'there';
    const utmContent = (p.tracking && p.tracking.utm_content) || '';
    const eventName = (p.scheduled_event && p.scheduled_event.name) || '';
    const startTime = (p.scheduled_event && p.scheduled_event.start_time) || '';

    if (!email) return res.status(400).json({ error: 'no_email' });

    const role = normalizeRole(utmContent);
    const builder = TEMPLATES[role] || TEMPLATES.default;

    // Idempotency: don't send the same role's email to the same person within 24h
    const dedupKey = `discovery:sent:${email}:${role}`;
    const already = await redis.get(dedupKey);
    const now = Date.now();

    let sent = false;
    if (!already) {
        try {
            const { subject, html, text } = builder({ firstName });
            await sendViaResend({ to: email, subject, html, text });
            await redis.set(dedupKey, now, { ex: 86400 });
            sent = true;
        } catch (err) {
            console.error('calendly-webhook send error', err);
            // Don't fail the webhook — Calendly will retry indefinitely on 5xx.
            // We still want to record the booking.
        }
    }

    // Upsert into subscribers list
    const existingSignedAt = await redis.hget(`subscriber:${email}`, 'signed_up_at');
    await redis.hset(`subscriber:${email}`, {
        email,
        source: 'discovery-call-booked',
        role,
        signed_up_at: existingSignedAt || now,
        last_seen_at: now,
        last_booking_at: now,
        event_name: eventName,
    });
    await redis.zadd('subscribers:by_date', {
        score: existingSignedAt ? Number(existingSignedAt) : now,
        member: email,
    });

    // Track the booking record separately for analytics
    await redis.hset(`discovery:${email}`, {
        email, role, booked_at: now,
        event_name: eventName, start_time: startTime,
        utm_content: utmContent,
    });

    return res.status(200).json({ ok: true, role, sent });
}
