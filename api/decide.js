// GET /api/decide/?email=...&decision=client|nope&exp=...&sig=...
// Magic-link handler. Paul clicks "Client" or "Not a fit" in his disposition
// prompt email. Signed with HMAC of ADMIN_TOKEN so only valid links work.
//
// Side effects:
//   - decision=client → marks subscriber, ready for QB (Phase 2)
//   - decision=nope   → marks subscriber, enrolls in nurture drip

import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

function expectedSig(email, decision, exp) {
    const secret = process.env.ADMIN_TOKEN || '';
    return crypto.createHmac('sha256', secret)
        .update(`${email}|${decision}|${exp}`)
        .digest('hex');
}

function htmlPage({ title, body, accent }) {
    const color = accent === 'green' ? '#22c55e' : accent === 'red' ? '#ef4444' : '#1abde1';
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  body{background:#0a0a0a;color:#f5f5f7;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
       min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;line-height:1.5;-webkit-font-smoothing:antialiased;}
  .card{background:#131313;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:48px 36px;max-width:480px;text-align:center;}
  .badge{display:inline-flex;align-items:center;gap:8px;background:${color}22;color:${color};border:1px solid ${color}44;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-bottom:20px;}
  h1{font-size:22px;font-weight:800;letter-spacing:-.02em;margin-bottom:12px;}
  p{font-size:14px;color:#a1a1a6;margin-bottom:8px;}
  p strong{color:#fff;font-weight:600;}
  a.btn{display:inline-block;margin-top:24px;background:#1abde1;color:#000;padding:10px 22px;border-radius:8px;font-weight:600;text-decoration:none;font-size:13px;}
</style></head><body>
<div class="card">${body}</div>
</body></html>`;
}

export default async function handler(req, res) {
    const email = String(req.query.email || '').toLowerCase().trim();
    const decision = String(req.query.decision || '').toLowerCase().trim();
    const exp = Number(req.query.exp || 0);
    const sig = String(req.query.sig || '');

    if (!email || !decision || !exp || !sig) {
        return res.status(400).setHeader('Content-Type', 'text/html').send(
            htmlPage({ title: 'Invalid link', accent: 'red', body: `
                <div class="badge">Invalid link</div>
                <h1>This link is malformed.</h1>
                <p>Some parameters are missing. Try clicking the original button from the email again.</p>
            `}));
    }

    if (!['client', 'nope'].includes(decision)) {
        return res.status(400).setHeader('Content-Type', 'text/html').send(
            htmlPage({ title: 'Invalid decision', accent: 'red', body: `
                <div class="badge">Invalid</div>
                <h1>Unknown decision.</h1>
                <p>Expected "client" or "nope".</p>
            `}));
    }

    if (Date.now() > exp) {
        return res.status(400).setHeader('Content-Type', 'text/html').send(
            htmlPage({ title: 'Link expired', accent: 'red', body: `
                <div class="badge">Expired</div>
                <h1>This link has expired.</h1>
                <p>Magic links are valid for 14 days. The prospect record is still in the system, just message me to disposition them manually.</p>
            `}));
    }

    // Constant-time signature compare
    const want = expectedSig(email, decision, exp);
    try {
        if (!crypto.timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(sig, 'hex'))) {
            throw new Error();
        }
    } catch {
        return res.status(401).setHeader('Content-Type', 'text/html').send(
            htmlPage({ title: 'Bad signature', accent: 'red', body: `
                <div class="badge">Unauthorized</div>
                <h1>Signature doesn't match.</h1>
                <p>Use the original button in the email.</p>
            `}));
    }

    // Look up the prospect
    const sub = await redis.hgetall(`subscriber:${email}`);
    if (!sub || !sub.email) {
        return res.status(404).setHeader('Content-Type', 'text/html').send(
            htmlPage({ title: 'Not found', accent: 'red', body: `
                <div class="badge">Not found</div>
                <h1>Prospect not on record.</h1>
                <p>${email} isn't in the subscriber database.</p>
            `}));
    }

    const firstName = sub.first_name || email.split('@')[0];
    const now = Date.now();

    if (decision === 'client') {
        await redis.hset(`subscriber:${email}`, {
            decision: 'client',
            decision_at: now,
            disposition_pending: 0,
        });
        await redis.zrem('disposition:pending', email);
        // Don't enroll in nurture; client onboarding flows elsewhere (Phase 2: QB webhook)
        return res.status(200).setHeader('Content-Type', 'text/html').send(
            htmlPage({ title: 'Marked as client', accent: 'green', body: `
                <div class="badge">✓ Client</div>
                <h1>Marked ${firstName} as a client.</h1>
                <p><strong>${email}</strong></p>
                <p style="margin-top:14px;">Next: send them your QuickBooks onboarding invoice. Once they pay, Phase 2 will auto-fire the intake form + strategy call link.</p>
                <a class="btn" href="https://www.gostaffify.com/">Done</a>
            `}));
    }

    // decision === 'nope' — enroll in nurture
    await redis.hset(`subscriber:${email}`, {
        decision: 'nope',
        decision_at: now,
        disposition_pending: 0,
    });
    await redis.zrem('disposition:pending', email);

    // Enroll in nurture drip (idempotent — won't re-enroll if already there)
    const existingNurture = await redis.hget(`nurture:${email}`, 'enrolled_at');
    if (!existingNurture) {
        await redis.hset(`nurture:${email}`, {
            email,
            enrolled_at: now,
            day3_sent_at: '',
            day14_sent_at: '',
            day45_sent_at: '',
        });
        await redis.zadd('nurture:active', { score: now, member: email });
    }

    return res.status(200).setHeader('Content-Type', 'text/html').send(
        htmlPage({ title: 'Enrolled in nurture', accent: 'green', body: `
            <div class="badge">✓ Enrolled</div>
            <h1>${firstName} added to email nurture.</h1>
            <p><strong>${email}</strong></p>
            <p style="margin-top:14px;">They'll receive three emails over the next six weeks (day 3, day 14, day 45) keeping the door open. If they re-engage and book another call, they auto-graduate out of the drip.</p>
            <a class="btn" href="https://www.gostaffify.com/">Done</a>
        `}));
}
