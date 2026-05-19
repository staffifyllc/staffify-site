// GET /api/cron-disposition/  (scheduled hourly by Vercel cron)
// Finds discovery calls that ended ~24h ago without a decision and emails Paul
// a "Client / Not a fit" prompt with signed magic links.
//
// Auth: x-vercel-cron header (set automatically by Vercel cron) OR
// Authorization: Bearer <CRON_SECRET> for manual triggers.

import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const HOUR = 3600 * 1000;
const DECISION_DELAY_MS = 24 * HOUR;   // wait 24h after call ends before prompting
const DECISION_TIMEOUT_MS = 21 * 24 * HOUR; // stop prompting after 21 days
const LINK_EXPIRY_MS = 14 * 24 * HOUR;  // magic links valid for 14 days

const NOTIFY_TO = process.env.NOTIFY_TO || 'hello@gostaffify.com';

function sign(email, decision, exp) {
    return crypto.createHmac('sha256', process.env.ADMIN_TOKEN || '')
        .update(`${email}|${decision}|${exp}`)
        .digest('hex');
}

function magicLink(email, decision) {
    const exp = Date.now() + LINK_EXPIRY_MS;
    const sig = sign(email, decision, exp);
    const params = new URLSearchParams({ email, decision, exp: String(exp), sig });
    return `https://www.gostaffify.com/api/decide/?${params.toString()}`;
}

function fmtDateShort(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
}

function btn(href, label, color) {
    return `<a href="${href}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px;margin-right:8px;margin-bottom:6px;">${label}</a>`;
}

function buildPromptEmail(prospects) {
    const lines = prospects.map(p => {
        const cliLink = magicLink(p.email, 'client');
        const nopeLink = magicLink(p.email, 'nope');
        const callTime = fmtDateShort(p.next_call_at_ms || p.call_ends_at);
        const role = p.role && p.role !== 'default' ? ` <span style="color:#888;">· ${p.role}</span>` : '';
        return `
        <div style="border:1px solid #eee;border-radius:10px;padding:18px 20px;margin-bottom:14px;">
          <div style="font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:4px;">${p.first_name || p.email.split('@')[0]}${role}</div>
          <div style="font-size:13px;color:#666;margin-bottom:14px;">${p.email}${callTime ? ` &middot; called ${callTime}` : ''}</div>
          ${btn(cliLink, '✓ Became a client', '#22c55e')}
          ${btn(nopeLink, '✗ Not a fit — nurture', '#6b6b6b')}
        </div>`;
    }).join('\n');

    const textLines = prospects.map(p => {
        const cliLink = magicLink(p.email, 'client');
        const nopeLink = magicLink(p.email, 'nope');
        return `${p.first_name || p.email.split('@')[0]} (${p.email})
  Client:        ${cliLink}
  Not a fit:     ${nopeLink}`;
    }).join('\n\n');

    const subject = prospects.length === 1
        ? `Disposition: how did the call with ${prospects[0].first_name || prospects[0].email.split('@')[0]} go?`
        : `Disposition: ${prospects.length} calls need a decision`;

    const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;">
      <tr><td style="padding:32px 36px 28px 36px;font-size:15px;line-height:1.55;color:#1a1a1a;">
        <p style="margin:0 0 14px 0;font-size:18px;font-weight:700;">${prospects.length === 1 ? 'How did the call go?' : `${prospects.length} calls need disposition`}</p>
        <p style="margin:0 0 22px 0;color:#555;">One click below dispositions each prospect. "Not a fit" auto-enrolls them in a 3-email nurture drip over the next six weeks.</p>
        ${lines}
        <p style="margin:22px 0 0 0;font-size:12px;color:#999;">If you're not ready to decide, ignore this email. We'll send a reminder in a few days.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    const text = `${prospects.length === 1 ? 'How did the call go?' : `${prospects.length} calls need disposition.`}\n\nOne click below dispositions each prospect.\n\n${textLines}\n\nIf you're not ready, ignore — we'll remind you.`;

    return { subject, html, text };
}

async function sendViaResend({ to, subject, html, text }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.FROM_EMAIL || 'Paul <paul@gostaffify.com>';
    if (!apiKey) throw new Error('RESEND_API_KEY not set');
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject, html, text }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text().catch(() => '')}`);
    return r.json();
}

function authorized(req) {
    if (req.headers['x-vercel-cron']) return true;
    const validSecrets = [process.env.CRON_SECRET, process.env.ADMIN_TOKEN].filter(Boolean);
    if (!validSecrets.length) return false;
    const header = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    return m && validSecrets.includes(m[1]);
}

export default async function handler(req, res) {
    if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

    const now = Date.now();
    const result = { found: 0, prompted: 0, skipped: 0, errors: 0 };

    try {
        // Pull everyone whose call ended at most (now - DECISION_DELAY) ago.
        // The sorted-set score is call_ends_at; we want score <= (now - 24h).
        const cutoff = now - DECISION_DELAY_MS;
        const candidates = await redis.zrange('disposition:pending', 0, cutoff, { byScore: true });
        result.found = candidates.length;

        const toPrompt = [];
        for (const email of candidates) {
            const sub = await redis.hgetall(`subscriber:${email}`);
            if (!sub) { result.skipped++; continue; }

            // Already decided? Should have been removed but defensive cleanup
            if (sub.decision) {
                await redis.zrem('disposition:pending', email);
                result.skipped++;
                continue;
            }

            const callEndsAt = Number(sub.call_ends_at || 0);
            const age = now - callEndsAt;
            if (age < DECISION_DELAY_MS) { result.skipped++; continue; }
            if (age > DECISION_TIMEOUT_MS) {
                // Too old — stop prompting, drop from queue
                await redis.zrem('disposition:pending', email);
                result.skipped++;
                continue;
            }

            // Already prompted recently? Cool off for 72h before reminder
            const lastPrompted = Number(sub.disposition_prompted_at || 0);
            if (lastPrompted && (now - lastPrompted < 72 * HOUR)) {
                result.skipped++;
                continue;
            }

            toPrompt.push({
                email,
                first_name: sub.first_name,
                role: sub.role,
                next_call_at_ms: callEndsAt - 30 * 60 * 1000, // start time
                call_ends_at: callEndsAt,
            });
        }

        if (toPrompt.length === 0) {
            return res.status(200).json({ ok: true, ts: now, ...result });
        }

        const { subject, html, text } = buildPromptEmail(toPrompt);
        await sendViaResend({ to: NOTIFY_TO, subject, html, text });
        result.prompted = toPrompt.length;

        // Stamp prompted timestamp on each
        for (const p of toPrompt) {
            await redis.hset(`subscriber:${p.email}`, { disposition_prompted_at: now });
        }

        return res.status(200).json({ ok: true, ts: now, ...result });
    } catch (err) {
        console.error('cron-disposition fatal', err);
        return res.status(500).json({ error: 'server_error', detail: String(err.message || err) });
    }
}
