// GET /api/cron-nurture/  (scheduled daily by Vercel cron)
// Sends day-3, day-14, day-45 emails to prospects in nurture.

import { Redis } from '@upstash/redis';
import { link as unsubscribeLink } from '../lib/unsubscribe-token.js';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const DAY = 86400 * 1000;
const PLAYBOOK_URL = 'https://www.gostaffify.com/playbook/';
const FLYLISTED_URL = 'https://www.gostaffify.com/case-studies/flylisted/';
const REOPEN_URL = 'https://calendly.com/go-staffify/discovery-call?utm_content=reengagement';

// "Sexier" 2026 email shell. Black band header with Staffify wordmark +
// cyan dot, white card body with cyan top accent strip, glowing brand-
// cyan CTA. Designed to render correctly in Gmail / Apple Mail / Outlook.
function shellHTML(bodyHTML, footer, unsubLink) {
    const footerText = footer || "You're receiving this because we spoke about staffing recently.";
    const unsubRow = unsubLink
        ? `<div style="margin-top:8px;"><a href="${unsubLink}" style="color:#9aa3ad;text-decoration:underline;">Unsubscribe in one click</a></div>`
        : '';
    return `<!doctype html>
<html><body style="margin:0;padding:0;background:#0d0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d0f14;">
  <tr><td align="center" style="padding:40px 16px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;">
      <tr><td style="padding:0 4px 18px 4px;text-align:left;">
        <span style="font-size:18px;font-weight:900;color:#ffffff;letter-spacing:-0.5px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">Staffify</span><span style="display:inline-block;width:7px;height:7px;background:#1abde1;border-radius:50%;margin-left:6px;vertical-align:middle;box-shadow:0 0 12px rgba(26,189,225,0.7);"></span>
      </td></tr>
    </table>
  </td></tr>
  <tr><td align="center" style="padding:0 16px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.4);">
      <tr><td style="background:linear-gradient(90deg,#1abde1 0%,#0fa3c5 55%,#0d82b8 100%);height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:42px 38px 30px 38px;font-size:16px;line-height:1.65;color:#1a1a1a;">${bodyHTML}</td></tr>
      <tr><td style="padding:18px 38px 28px 38px;border-top:1px solid #eee;font-size:11px;color:#9aa3ad;line-height:1.55;text-align:center;letter-spacing:0.02em;">
        ${footerText}
        ${unsubRow}
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="height:40px;font-size:0;line-height:0;">&nbsp;</td></tr>
</table>
</body></html>`;
}

function withUnsubFooter(text, unsubLink) {
    return unsubLink ? `${text}\n\n— Unsubscribe in one click: ${unsubLink}` : text;
}

function btn(href, label) {
    return `<p style="margin:24px 0 16px 0;"><a href="${href}" style="display:inline-block;background:#1abde1;background-image:linear-gradient(180deg,#1abde1 0%,#0fa3c5 100%);color:#000000;text-decoration:none;padding:15px 30px;border-radius:999px;font-weight:800;font-size:14px;letter-spacing:0.02em;box-shadow:0 8px 24px rgba(26,189,225,0.35);">${label}</a></p>`;
}

// Small inline accent helpers reusable in body copy.
function eyebrow(text) {
    return `<p style="margin:0 0 14px 0;font-size:11px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#1abde1;">${text}</p>`;
}
function pullStat(num, label) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;border-left:3px solid #1abde1;padding:8px 0 8px 18px;">` +
           `<tr><td style="font-size:24px;font-weight:900;color:#0c1118;letter-spacing:-0.02em;line-height:1;">${num}</td></tr>` +
           `<tr><td style="font-size:12px;color:#666;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;padding-top:6px;">${label}</td></tr>` +
           `</table>`;
}

let _lastResendCallAt = 0;
async function sendViaResend({ to, subject, html, text }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.FROM_EMAIL || 'Staffify <hello@gostaffify.com>';
    if (!apiKey) throw new Error('RESEND_API_KEY not set');
    // Throttle: at most 4 requests/sec to stay under Resend's 5/sec free-tier cap
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
        // Backoff once on 429 (rate limit) before giving up
        if (r.status === 429 && attempt === 0) {
            attempt++;
            await new Promise(r => setTimeout(r, 1200));
            _lastResendCallAt = Date.now();
            continue;
        }
        throw new Error(`Resend ${r.status}: ${await r.text().catch(() => '')}`);
    }
}

export const TEMPLATES = {
    day3: ({ firstName, unsubLink }) => ({
        subject: "About our call — the playbook I mentioned",
        text: withUnsubFooter(
`Hey ${firstName},

Quick one. The playbook I mentioned on our call is yours:

${PLAYBOOK_URL}

Six chapters on the operational moves that move a service business from $300K to $3M. The bottleneck audit, the delegation matrix, the hiring funnel that actually holds, pricing power, retention systems.

Whether you build the team yourself or end up working with us, the frameworks land either way.

If timing shifts on your end:
${REOPEN_URL}

Paul
Founder, Staffify`, unsubLink),
        html: shellHTML(`
            ${eyebrow('After our call')}
            <p style="margin:0 0 16px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 16px 0;">Quick one. The playbook I mentioned on our call is yours.</p>
            <p style="margin:0 0 8px 0;">Six chapters on the operational moves that move a service business from $300K to $3M. <strong>The bottleneck audit. The delegation matrix. The hiring funnel that actually holds. Pricing power. Retention systems.</strong></p>
            <p style="margin:0 0 16px 0;color:#444;">Whether you build the team yourself or end up working with us, the frameworks land either way.</p>
            ${btn(PLAYBOOK_URL, 'Read the playbook →')}
            <p style="margin:18px 0 0 0;font-size:14px;color:#666;">If timing shifts on your end, <a href="${REOPEN_URL}" style="color:#0d82b8;font-weight:600;">grab 25 minutes here</a>.</p>
            <p style="margin:22px 0 0 0;">Paul<br><span style="color:#888;font-size:14px;">Founder, Staffify</span></p>
        `, null, unsubLink),
    }),

    day14: ({ firstName, unsubLink }) => ({
        subject: "60% off editing. Same quality.",
        text: withUnsubFooter(
`Hey ${firstName},

Real story.

Flylisted, a real estate marketing studio working with brokerages in Boston and South Florida, was paying per video to a rotating bench of freelance editors. As volume scaled, three things happened:

  · The bill scaled linearly
  · Brand voice drifted between editors
  · Turnaround swung wildly — sometimes 2 days, sometimes 10

They swapped to one dedicated Staffify editor on a flat monthly rate.

  60%  editing spend cut
  12-24hr  turnaround locked
  1  voice across every cut

Full breakdown: ${FLYLISTED_URL}

If your situation rhymes:
${REOPEN_URL}

Paul`, unsubLink),
        html: shellHTML(`
            ${eyebrow('A real customer story')}
            <p style="margin:0 0 16px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 16px 0;"><strong>Flylisted</strong> is a real estate marketing studio working with brokerages in Boston and South Florida. They were paying per video to a rotating bench of freelance editors.</p>
            <p style="margin:0 0 14px 0;">Three things happened as volume scaled:</p>
            <ul style="margin:0 0 18px 22px;padding:0;font-size:15px;line-height:1.7;color:#444;">
                <li>The bill scaled linearly</li>
                <li>Brand voice drifted between editors</li>
                <li>Turnaround swung wildly — sometimes 2 days, sometimes 10</li>
            </ul>
            <p style="margin:0 0 6px 0;">Then they swapped to one dedicated Staffify editor on a flat monthly rate:</p>
            ${pullStat('60% lower', 'Editing spend cut')}
            ${pullStat('12-24hr', 'Turnaround locked')}
            ${pullStat('One voice', 'Across every cut')}
            ${btn(FLYLISTED_URL, 'Read the case study →')}
            <p style="margin:18px 0 0 0;font-size:14px;color:#666;">If your situation rhymes, my calendar: <a href="${REOPEN_URL}" style="color:#0d82b8;font-weight:600;">25-min follow-up</a>.</p>
            <p style="margin:22px 0 0 0;">Paul<br><span style="color:#888;font-size:14px;">Founder, Staffify</span></p>
        `, null, unsubLink),
    }),

    day45: ({ firstName, unsubLink }) => ({
        subject: "Anything shifted since we talked?",
        text: withUnsubFooter(
`Hey ${firstName},

Last note from me, then I'll leave the inbox quiet.

It's been a few weeks since we talked. Anything shifted on your end?

  · Hiring pressure climbed the priority list
  · Margins got tighter (freelancer rates, busy-season pricing)
  · A team member left and you're not eager to replace locally
  · Or none of the above. In which case ignore this.

If any of those landed:
${REOPEN_URL}

Either way, the playbook is yours to keep:
${PLAYBOOK_URL}

Good luck with what you're building.

Paul`, unsubLink),
        html: shellHTML(`
            ${eyebrow('Last note')}
            <p style="margin:0 0 16px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 16px 0;">Last note from me, then I'll leave the inbox quiet.</p>
            <p style="margin:0 0 14px 0;">It's been a few weeks since we talked. Anything shifted on your end?</p>
            <ul style="margin:0 0 18px 22px;padding:0;font-size:15px;line-height:1.7;color:#444;">
                <li>Hiring pressure climbed the priority list</li>
                <li>Margins got tighter (freelancer rates, busy-season pricing)</li>
                <li>A team member left and you're not eager to replace locally</li>
                <li>Or none of the above. In which case ignore this.</li>
            </ul>
            <p style="margin:0 0 4px 0;">If any of those landed:</p>
            ${btn(REOPEN_URL, 'Restart the conversation →')}
            <p style="margin:18px 0 0 0;font-size:14px;color:#666;">Either way, <a href="${PLAYBOOK_URL}" style="color:#0d82b8;font-weight:600;">the playbook</a> is yours to keep. Good luck with what you're building.</p>
            <p style="margin:22px 0 0 0;">Paul<br><span style="color:#888;font-size:14px;">Founder, Staffify</span></p>
        `, "You're receiving this because we spoke about staffing recently.", unsubLink),
    }),
};

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
    const result = { processed: 0, day3_sent: 0, day14_sent: 0, day45_sent: 0, removed: 0, errors: 0 };

    try {
        const emails = await redis.zrange('nurture:active', 0, -1);
        for (const email of emails) {
            result.processed++;
            try {
                const rec = await redis.hgetall(`nurture:${email}`);
                if (!rec || !rec.enrolled_at) continue;

                const enrolledAt = Number(rec.enrolled_at);
                const ageDays = (now - enrolledAt) / DAY;

                const subscriber = await redis.hgetall(`subscriber:${email}`);
                const firstName = (subscriber && subscriber.first_name) || (email.split('@')[0] || 'there');
                const unsubLink = unsubscribeLink(email);

                // If they've since converted (e.g. booked again and we flipped to client), stop the drip
                if (subscriber && subscriber.decision && subscriber.decision !== 'nope') {
                    await redis.zrem('nurture:active', email);
                    result.removed++;
                    continue;
                }

                // Weekly cadence: touches at day 7, 14, 21 (was day 3, 14, 45).
                // Internal flag names kept for backwards-compat with existing
                // Redis records.
                if (ageDays >= 7 && !rec.day3_sent_at) {
                    await sendViaResend({ to: email, ...TEMPLATES.day3({ firstName, unsubLink }) });
                    await redis.hset(`nurture:${email}`, { day3_sent_at: Date.now() });
                    result.day3_sent++;
                    continue;
                }
                if (ageDays >= 14 && !rec.day14_sent_at) {
                    await sendViaResend({ to: email, ...TEMPLATES.day14({ firstName, unsubLink }) });
                    await redis.hset(`nurture:${email}`, { day14_sent_at: Date.now() });
                    result.day14_sent++;
                    continue;
                }
                if (ageDays >= 21 && !rec.day45_sent_at) {
                    await sendViaResend({ to: email, ...TEMPLATES.day45({ firstName, unsubLink }) });
                    await redis.hset(`nurture:${email}`, { day45_sent_at: Date.now() });
                    await redis.zrem('nurture:active', email);
                    result.day45_sent++;
                    result.removed++;
                }
            } catch (err) {
                console.error(`nurture error for ${email}`, err);
                result.errors++;
            }
        }

        return res.status(200).json({ ok: true, ts: now, ...result });
    } catch (err) {
        console.error('cron-nurture fatal', err);
        return res.status(500).json({ error: 'server_error', detail: String(err.message || err) });
    }
}
