// GET /api/quickbooks-oauth-callback/?code=...&realmId=...&state=...
// Intuit redirects here after Paul authorizes. We exchange the code for an
// access+refresh token pair and save both in Upstash. Returns a styled
// confirmation page with the realmId so Paul can paste into Vercel env.

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const REDIRECT_URI = 'https://www.gostaffify.com/api/quickbooks-oauth-callback/';
const QB_OAUTH_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function htmlPage({ title, body, accent }) {
    const color = accent === 'green' ? '#22c55e' : accent === 'red' ? '#ef4444' : '#1abde1';
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  body{background:#0a0a0a;color:#f5f5f7;font-family:'Inter',-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;line-height:1.55;}
  .card{background:#131313;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:44px 36px;max-width:580px;width:100%;}
  .badge{display:inline-flex;align-items:center;gap:8px;background:${color}22;color:${color};border:1px solid ${color}44;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-bottom:20px;}
  h1{font-size:22px;font-weight:800;letter-spacing:-.02em;margin-bottom:14px;}
  p{font-size:14px;color:#a1a1a6;margin-bottom:10px;}
  p strong{color:#fff;font-weight:600;}
  code{display:block;background:#0a0a0a;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:14px 16px;font-family:'SF Mono',Menlo,monospace;font-size:13px;color:#86efac;margin:6px 0 16px;word-break:break-all;}
  .label{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8a8a8f;margin-top:14px;}
</style></head><body><div class="card">${body}</div></body></html>`;
}

export default async function handler(req, res) {
    const code = String(req.query.code || '');
    const realmId = String(req.query.realmId || '');
    const state = String(req.query.state || '');
    const error = String(req.query.error || '');

    if (error) {
        return res.status(400).setHeader('Content-Type', 'text/html').send(
            htmlPage({ title: 'QB OAuth error', accent: 'red', body: `
                <div class="badge">Error</div><h1>Intuit returned an error.</h1>
                <p>${error}</p>` }));
    }
    if (!code || !realmId || !state) {
        return res.status(400).setHeader('Content-Type', 'text/html').send(
            htmlPage({ title: 'Missing params', accent: 'red', body: `
                <div class="badge">Missing</div><h1>Required query parameters missing.</h1>
                <p>Expected code, realmId, state.</p>` }));
    }

    // Verify state (CSRF)
    const stored = await redis.get(`qb:oauth:state:${state}`);
    if (!stored) {
        return res.status(401).setHeader('Content-Type', 'text/html').send(
            htmlPage({ title: 'Bad state', accent: 'red', body: `
                <div class="badge">Unauthorized</div><h1>State mismatch.</h1>
                <p>Restart the connect flow from /api/quickbooks-oauth-start/.</p>` }));
    }
    await redis.del(`qb:oauth:state:${state}`);

    // Exchange code for tokens
    const clientId = process.env.QB_CLIENT_ID;
    const clientSecret = process.env.QB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        return res.status(500).setHeader('Content-Type', 'text/html').send(
            htmlPage({ title: 'Not configured', accent: 'red', body: `
                <div class="badge">Server config missing</div><h1>QB_CLIENT_ID or QB_CLIENT_SECRET not set in Vercel.</h1>` }));
    }
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokRes = await fetch(QB_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${basicAuth}`,
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }).toString(),
    });
    if (!tokRes.ok) {
        const detail = await tokRes.text().catch(() => '');
        return res.status(500).setHeader('Content-Type', 'text/html').send(
            htmlPage({ title: 'Token exchange failed', accent: 'red', body: `
                <div class="badge">Failed</div><h1>Intuit rejected the code exchange.</h1>
                <p>${detail}</p>` }));
    }
    const tok = await tokRes.json();
    const now = Date.now();
    const expiresAt = now + (Number(tok.expires_in || 3600) * 1000);

    await redis.hset('qb:tokens', {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        access_expires_at: expiresAt,
        refresh_token_updated_at: now,
        connected_at: now,
        realm_id: realmId,
    });

    return res.status(200).setHeader('Content-Type', 'text/html').send(
        htmlPage({ title: 'QB connected', accent: 'green', body: `
            <div class="badge">✓ Connected</div>
            <h1>QuickBooks Online is wired up.</h1>
            <p>Refresh + access tokens are stored in Upstash and will auto-rotate.</p>
            <div class="label">Your QB Realm ID (paste into Vercel env as <code style="display:inline;padding:2px 6px;background:rgba(255,255,255,0.05);border-radius:4px;color:#fff;">QB_REALM_ID</code>):</div>
            <code>${realmId}</code>
            <p style="margin-top:18px;">After setting <strong>QB_REALM_ID</strong> in Vercel, configure the webhook subscription in Intuit Developer pointing to:</p>
            <code>https://www.gostaffify.com/api/quickbooks-webhook/</code>
            <p style="margin-top:18px;color:#86efac;"><strong>Next:</strong> Tell Claude "connected" and paste your Realm ID. He'll drive the rest.</p>
        `}));
}
