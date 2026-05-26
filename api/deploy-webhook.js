// POST /api/deploy-webhook
// Receives Vercel webhook events and emails hello@gostaffify.com on
// deployment.error / deployment.canceled. Lets you know within seconds
// when a production deploy breaks instead of finding out by accident.
//
// Set up via Vercel API:
//   vercel api /v1/webhooks -X POST --input - <<EOF
//   { "url": "https://www.gostaffify.com/api/deploy-webhook/",
//     "events": ["deployment.error", "deployment.canceled"],
//     "projectIds": ["prj_J4FaeeIYGKs4KcoLR3nUCGa4jvoY"] }
//   EOF
//
// Vercel signs webhooks with HMAC-SHA1 using the secret returned at
// webhook creation. Store as VERCEL_WEBHOOK_SECRET env var; if unset,
// signature verification is skipped (acceptable — the URL is obscure).

import crypto from 'node:crypto';

const ALERT_TO = process.env.ALERT_TO || 'hello@gostaffify.com';
const FROM = process.env.FROM_EMAIL || 'Staffify <hello@gostaffify.com>';

function verifySignature(rawBody, signatureHeader, secret) {
    if (!secret) return true;
    if (!signatureHeader) return false;
    const expected = crypto.createHmac('sha1', secret).update(rawBody).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
    } catch {
        return false;
    }
}

async function sendAlert({ subject, html, text }) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY not set');
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: ALERT_TO, subject, html, text }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text().catch(() => '')}`);
    return r.json();
}

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const rawBody = await readRawBody(req);
    const signature = req.headers['x-vercel-signature'];
    const secret = process.env.VERCEL_WEBHOOK_SECRET;

    if (!verifySignature(rawBody, signature, secret)) {
        return res.status(401).json({ error: 'invalid_signature' });
    }

    let payload;
    try { payload = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'invalid_json' }); }

    const event = payload.type || 'unknown';
    const p = payload.payload || {};
    const project = p.project?.name || 'staffify-site';
    const deployUrl = p.deployment?.url ? `https://${p.deployment.url}` : 'unknown';
    const inspectorUrl = p.deployment?.inspectorUrl || `https://vercel.com/staffifyllcs-projects/${project}/deployments`;
    const commitMsg = p.deployment?.meta?.githubCommitMessage || '(no commit message)';
    const commitSha = p.deployment?.meta?.githubCommitSha?.slice(0, 7) || 'unknown';
    const branch = p.deployment?.meta?.githubCommitRef || 'main';

    if (event === 'deployment.error' || event === 'deployment.canceled') {
        const label = event === 'deployment.error' ? 'FAILED' : 'CANCELED';
        const subject = `🚨 Vercel deploy ${label}: ${project} (${commitSha})`;
        const text =
`Vercel deploy ${label.toLowerCase()}.

Project: ${project}
Branch:  ${branch}
Commit:  ${commitSha}
Message: ${commitMsg}

Deploy URL:  ${deployUrl}
Logs:        ${inspectorUrl}

The previous successful deploy is still serving production until this is resolved.`;

        const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;border-left:4px solid #dc2626;">
<tr><td style="padding:32px 36px;font-size:15px;line-height:1.6;color:#1a1a1a;">
  <div style="font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#dc2626;margin-bottom:10px;">Deploy ${label}</div>
  <h1 style="font-size:22px;font-weight:800;margin:0 0 18px 0;letter-spacing:-0.02em;">Vercel deploy ${label.toLowerCase()} on ${project}.</h1>
  <table style="border-collapse:collapse;font-size:14px;margin-bottom:24px;">
    <tr><td style="padding:6px 16px 6px 0;color:#666;">Branch</td><td style="padding:6px 0;font-family:monospace;">${branch}</td></tr>
    <tr><td style="padding:6px 16px 6px 0;color:#666;">Commit</td><td style="padding:6px 0;font-family:monospace;">${commitSha}</td></tr>
    <tr><td style="padding:6px 16px 6px 0;color:#666;vertical-align:top;">Message</td><td style="padding:6px 0;">${commitMsg.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</td></tr>
  </table>
  <p style="margin:0 0 18px 0;"><a href="${inspectorUrl}" style="display:inline-block;background:#0c1118;color:#fff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600;font-size:14px;">View deploy logs →</a></p>
  <p style="margin:0;font-size:13px;color:#666;">The previous successful deploy is still serving production until this is resolved.</p>
</td></tr></table>
</td></tr></table>
</body></html>`;

        try {
            await sendAlert({ subject, html, text });
            return res.status(200).json({ ok: true, alerted: true, event });
        } catch (err) {
            console.error('alert send failed', err);
            return res.status(500).json({ ok: false, error: String(err.message || err) });
        }
    }

    // Other events (deployment.succeeded etc) — acknowledge but don't alert
    return res.status(200).json({ ok: true, alerted: false, event });
}
