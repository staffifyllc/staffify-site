// GET /api/preview-emails/?email=you@example.com
// Sends all 6 marketing emails (welcome + day 2/6/12/21/45) to a given inbox
// immediately, prefixed with [PREVIEW] in the subject. Lets you review the
// entire soft-yes sequence without waiting 45 days.
//
// Auth: Authorization: Bearer <ADMIN_TOKEN or CRON_SECRET>
//
// Does NOT write to Upstash. Does NOT enroll the email. Pure preview.
//
// Templates are imported from their source-of-truth modules so a copy
// change in the cron / subscribe files reaches previews automatically.

import { TEMPLATES as SOFTYES_TEMPLATES } from './cron-softyes-nurture.js';
import { renderEmail as renderWelcome } from './subscribe.js';

function authorized(req) {
    const adminToken = process.env.ADMIN_TOKEN || '';
    const cronSecret = process.env.CRON_SECRET || '';
    const header = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return false;
    const provided = m[1];
    return (adminToken && provided === adminToken) ||
           (cronSecret && provided === cronSecret);
}

function isValidEmail(s) {
    return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length < 254;
}

let _lastResendCallAt = 0;
async function sendViaResend({ to, subject, html, text }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.FROM_EMAIL || 'Staffify <hello@gostaffify.com>';
    if (!apiKey) throw new Error('RESEND_API_KEY not set');
    // Throttle so we stay under Resend's 5/sec free-tier cap
    const MIN_GAP_MS = 260;
    const since = Date.now() - _lastResendCallAt;
    if (since < MIN_GAP_MS) await new Promise(r => setTimeout(r, MIN_GAP_MS - since));
    _lastResendCallAt = Date.now();
    let attempt = 0;
    while (true) {
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to, subject, html, text, reply_to: 'hello@gostaffify.com' }),
        });
        if (r.ok) return r.json();
        if (r.status === 429 && attempt === 0) {
            attempt++;
            await new Promise(r => setTimeout(r, 1200));
            _lastResendCallAt = Date.now();
            continue;
        }
        throw new Error(`Resend ${r.status}: ${await r.text().catch(() => '')}`);
    }
}

// Build the full 6-email sequence for a given firstName by pulling
// the live templates (welcome + 5 soft-yes drip touches).
function buildPreviewSequence(firstName) {
    const welcome = renderWelcome();   // { text, html }
    const seq = [
        {
            subject: 'The 10 highest-ROI delegations, inside',
            text:    welcome.text,
            html:    welcome.html,
        },
    ];
    for (const key of ['day2', 'day6', 'day12', 'day21', 'day45']) {
        const tpl = SOFTYES_TEMPLATES[key]({ firstName });
        seq.push({ subject: tpl.subject, text: tpl.text, html: tpl.html });
    }
    return seq;
}

export default async function handler(req, res) {
    if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

    const url = new URL(req.url, `https://${req.headers.host}`);
    const email = (url.searchParams.get('email') || '').toString().trim().toLowerCase();
    const firstName = (url.searchParams.get('name') || email.split('@')[0] || 'there').toString();

    if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' });

    const sequence = buildPreviewSequence(firstName);

    const sent = [];
    const errors = [];
    for (const tmpl of sequence) {
        try {
            const subject = `[PREVIEW] ${tmpl.subject}`;
            const r = await sendViaResend({ to: email, subject, html: tmpl.html, text: tmpl.text });
            sent.push({ subject, id: r.id });
            await new Promise(rs => setTimeout(rs, 400));
        } catch (err) {
            errors.push({ subject: tmpl.subject, error: String(err.message || err) });
        }
    }

    return res.status(200).json({
        ok: errors.length === 0,
        to: email,
        sent_count: sent.length,
        sent,
        errors,
    });
}
