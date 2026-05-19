// POST /api/pipeline-action/
// Body: { email, action, notes? }
// Actions:
//   - "mark-client"   → upcoming → client-pending-payment (waiting on QB invoice payment)
//   - "mark-paid"     → client-pending-payment → client-active. Fires intake + strategy emails.
//   - "mark-no-close" → upcoming → no-close. Enrolls in nurture drip.
//   - "reopen"        → any → upcoming (manual rescue)
//   - "save-notes"    → updates `notes` field, no status change

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const ALL_PIPELINE_BUCKETS = [
    'pipeline:upcoming',
    'pipeline:client-pending-payment',
    'pipeline:client-active',
    'pipeline:no-close',
];

const STRATEGY_CALL_URL = 'https://calendly.com/go-staffify/discovery-call?utm_content=strategy';
const INTAKE_FORM_URL = 'https://recruiting.gostaffify.com/client-intake';

function authorized(req) {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken) return false;
    const header = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    const tokenFromHeader = m ? m[1] : null;
    const tokenFromQuery = (req.query.token || '').toString();
    return (tokenFromHeader || tokenFromQuery) === adminToken;
}

async function setStatus(email, newStatus, extras = {}) {
    const now = Date.now();
    for (const bucket of ALL_PIPELINE_BUCKETS) {
        if (bucket !== `pipeline:${newStatus}`) await redis.zrem(bucket, email);
    }
    await redis.zadd(`pipeline:${newStatus}`, { score: now, member: email });
    await redis.hset(`subscriber:${email}`, {
        status: newStatus,
        status_updated_at: now,
        ...extras,
    });
}

// ─── Email helpers ──────────────────────────────────────────────
function shellHTML(bodyHTML) {
    return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;">
      <tr><td style="padding:36px 36px 28px 36px;font-size:16px;line-height:1.55;color:#1a1a1a;">${bodyHTML}</td></tr>
      <tr><td style="padding:18px 36px 28px 36px;border-top:1px solid #eee;font-size:12px;color:#888;line-height:1.5;">
        You're receiving this because you signed up for Staffify services.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function btn(href, label) {
    return `<p style="margin:18px 0;"><a href="${href}" style="display:inline-block;background:#0c1118;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600;font-size:15px;">${label}</a></p>`;
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

// ─── Email templates ────────────────────────────────────────────
function onboardingEmail({ firstName }) {
    const subject = "Welcome to Staffify — your next two steps";
    const text =
`Hey ${firstName},

Welcome to Staffify. Thanks for getting your onboarding fee in — we're officially building your team.

Two things to wrap up before we go live:

1) Client Intake Form (10 min): ${INTAKE_FORM_URL}
   This is how we map your role requirements, working style, brand, and the must-haves vs nice-to-haves for the person we're placing.

2) Strategy Call (30 min): ${STRATEGY_CALL_URL}
   Once you've sent us the intake, book a slot for us to walk through the role profile together. We'll cover sourcing timeline, screening process, and the rollout plan for week one.

Both links work in any order, but the strategy call is more useful after we've seen your intake answers.

Welcome aboard.

Paul
Founder, Staffify`;

    const html = shellHTML(`
        <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
        <p style="margin:0 0 14px 0;">Welcome to Staffify. Thanks for getting your onboarding fee in — we're officially building your team.</p>
        <p style="margin:18px 0 8px 0;font-size:15px;"><strong>Two things to wrap up before we go live:</strong></p>
        <p style="margin:0 0 8px 0;"><strong>1) Client Intake Form</strong> (10 min)</p>
        <p style="margin:0 0 14px 0;font-size:15px;color:#4a4a4f;">How we map your role requirements, working style, brand, and the must-haves vs nice-to-haves for the person we're placing.</p>
        ${btn(INTAKE_FORM_URL, 'Fill out the Intake Form →')}
        <p style="margin:24px 0 8px 0;"><strong>2) Strategy Call</strong> (30 min)</p>
        <p style="margin:0 0 14px 0;font-size:15px;color:#4a4a4f;">Once you've sent us the intake, book a slot to walk through the role profile together. We'll cover sourcing timeline, screening process, and the rollout plan for week one.</p>
        ${btn(STRATEGY_CALL_URL, 'Book your Strategy Call →')}
        <p style="margin:24px 0 6px 0;">Welcome aboard.</p>
        <p style="margin:0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>
    `);

    return { subject, html, text };
}

// ─── Handler ────────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const email = String(body.email || '').toLowerCase().trim();
    const action = String(body.action || '').toLowerCase().trim();
    const notes = body.notes != null ? String(body.notes) : null;

    if (!email) return res.status(400).json({ error: 'email_required' });
    if (!action) return res.status(400).json({ error: 'action_required' });

    // Make sure prospect exists
    const existing = await redis.hgetall(`subscriber:${email}`);
    if (!existing || !existing.email) {
        return res.status(404).json({ error: 'prospect_not_found' });
    }

    const firstName = existing.first_name || (existing.email || '').split('@')[0] || 'there';

    try {
        switch (action) {
            case 'mark-client':
                await setStatus(email, 'client-pending-payment');
                if (notes !== null) await redis.hset(`subscriber:${email}`, { notes });
                return res.status(200).json({ ok: true, status: 'client-pending-payment' });

            case 'mark-paid': {
                await setStatus(email, 'client-active', { paid_at: Date.now() });
                if (notes !== null) await redis.hset(`subscriber:${email}`, { notes });
                // Fire onboarding email (idempotent via dedup key)
                const dedupKey = `onboarding:sent:${email}`;
                const alreadySent = await redis.get(dedupKey);
                let onboardingSent = false;
                if (!alreadySent) {
                    try {
                        const { subject, html, text } = onboardingEmail({ firstName });
                        await sendViaResend({ to: email, subject, html, text });
                        await redis.set(dedupKey, Date.now());
                        await redis.hset(`subscriber:${email}`, { onboarding_email_sent_at: Date.now() });
                        onboardingSent = true;
                    } catch (err) {
                        console.error('onboarding email failed', err);
                        // Don't fail the action — status is already set, retry email manually
                    }
                }
                return res.status(200).json({ ok: true, status: 'client-active', onboarding_email_sent: onboardingSent });
            }

            case 'mark-no-close': {
                await setStatus(email, 'no-close');
                if (notes !== null) await redis.hset(`subscriber:${email}`, { notes });
                // Enroll in nurture sequence
                const now = Date.now();
                await redis.hset(`nurture:${email}`, {
                    email,
                    enrolled_at: now,
                    day3_sent_at: '',
                    day14_sent_at: '',
                    day45_sent_at: '',
                });
                await redis.zadd('nurture:active', { score: now, member: email });
                return res.status(200).json({ ok: true, status: 'no-close', enrolled_in_nurture: true });
            }

            case 'reopen':
                await setStatus(email, 'upcoming');
                // Pause any active nurture drip
                await redis.zrem('nurture:active', email);
                return res.status(200).json({ ok: true, status: 'upcoming' });

            case 'save-notes':
                if (notes === null) return res.status(400).json({ error: 'notes_required' });
                await redis.hset(`subscriber:${email}`, { notes, notes_updated_at: Date.now() });
                return res.status(200).json({ ok: true });

            default:
                return res.status(400).json({
                    error: 'unknown_action',
                    valid: ['mark-client', 'mark-paid', 'mark-no-close', 'reopen', 'save-notes'],
                });
        }
    } catch (err) {
        console.error('pipeline-action error', err);
        return res.status(500).json({ error: 'server_error', detail: String(err.message || err) });
    }
}
