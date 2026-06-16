// GET /api/unsubscribe?e=foo@bar.com&t=<hmac>
//
// One-click unsubscribe. Validates the HMAC token (so attackers can't
// unsubscribe arbitrary emails), then removes the subscriber from every
// active queue and writes a tombstone to `unsubscribed:set` so future
// enrollment paths (subscribe, calendly-webhook, backfill) skip them.
//
// Returns an HTML confirmation page on success.

import { Redis } from '@upstash/redis';
import { verify as verifyToken } from '../lib/unsubscribe-token.js';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

function isValidEmail(s) {
    return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length < 254;
}

function page({ status, email, message }) {
    const color = status === 'ok' ? '#1abde1' : '#dc2626';
    const heading = status === 'ok' ? "You're unsubscribed." : "Couldn't unsubscribe.";
    return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>${heading} — Staffify</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:#0d0f14;color:#e4e8ef;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
  .card{max-width:520px;width:100%;background:#ffffff;color:#1a1a1a;border-radius:18px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.5);}
  .accent{height:4px;background:linear-gradient(90deg,${color} 0%,${color} 100%);}
  .body{padding:46px 38px 40px;}
  .brand{font-size:13px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:${color};margin-bottom:18px;}
  h1{font-size:26px;font-weight:800;letter-spacing:-0.02em;line-height:1.2;color:#0c1118;margin-bottom:14px;}
  p{font-size:15px;line-height:1.65;color:#444;margin-bottom:14px;}
  .email{display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;background:#f3f5f8;padding:6px 12px;border-radius:8px;color:#0c1118;}
  .footer{margin-top:18px;font-size:13px;color:#888;}
  a{color:#0d82b8;text-decoration:none;font-weight:600;}
</style>
</head><body>
<div class="card">
  <div class="accent"></div>
  <div class="body">
    <div class="brand">Staffify</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${email ? `<p><span class="email">${email}</span></p>` : ''}
    <p class="footer">Questions? Reply to any of our emails or write to <a href="mailto:hello@gostaffify.com">hello@gostaffify.com</a>.</p>
  </div>
</div>
</body></html>`;
}

export default async function handler(req, res) {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const rawEmail = (url.searchParams.get('e') || '').toString();
    const token = (url.searchParams.get('t') || '').toString();
    const email = rawEmail.trim().toLowerCase();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    if (!isValidEmail(email) || !token) {
        return res.status(400).send(page({
            status: 'err',
            email: rawEmail,
            message: 'This unsubscribe link is missing or malformed. Reply <strong>stop</strong> to any email and we\'ll remove you manually.',
        }));
    }

    if (!verifyToken(email, token)) {
        return res.status(400).send(page({
            status: 'err',
            email,
            message: 'This unsubscribe link is invalid or has been tampered with. Reply <strong>stop</strong> to any email and we\'ll remove you manually.',
        }));
    }

    try {
        // Tombstone first so any race with a concurrent enrollment loses.
        await redis.sadd('unsubscribed:set', email);
        await redis.hset(`unsubscribed:${email}`, {
            email,
            unsubscribed_at: Date.now(),
            source: 'one-click-link',
        });

        // Pull out of every active queue + delete drip records.
        await redis.zrem('softyes:active', email);
        await redis.zrem('nurture:active', email);
        await redis.zrem('disposition:pending', email);
        await redis.del(`softyes:${email}`);
        await redis.del(`nurture:${email}`);

        // Wipe the subscriber row + master index so future re-signups go through
        // the normal flow and bounce off the tombstone.
        await redis.del(`subscriber:${email}`);
        await redis.zrem('subscribers:by_date', email);

        return res.status(200).send(page({
            status: 'ok',
            email,
            message: 'You won\'t hear from us again. We\'ve removed you from every list, drip, and follow-up queue.',
        }));
    } catch (err) {
        console.error('unsubscribe error', err);
        return res.status(500).send(page({
            status: 'err',
            email,
            message: 'Something went wrong on our end. Reply <strong>stop</strong> to any email and we\'ll remove you manually within a day.',
        }));
    }
}
