// GET /api/cron-nurture/  (scheduled daily by Vercel cron)
// Walks the nurture:active queue and sends day-3, day-14, day-45 emails to
// anyone whose enrollment time hits those thresholds.
//
// Auth: Vercel cron requests carry a unique x-vercel-cron header, OR we accept
// Authorization: Bearer <CRON_SECRET> for manual triggers.

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const DAY = 86400 * 1000;

const PLAYBOOK_URL = 'https://www.gostaffify.com/playbook/';
const FLYLISTED_URL = 'https://www.gostaffify.com/case-studies/flylisted/';
const REOPEN_URL = 'https://calendly.com/go-staffify/discovery-call?utm_content=reengagement';

// ─── Email helpers ──────────────────────────────────────────────
function shellHTML(bodyHTML, unsubLine) {
    return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;">
      <tr><td style="padding:36px 36px 28px 36px;font-size:16px;line-height:1.55;color:#1a1a1a;">${bodyHTML}</td></tr>
      <tr><td style="padding:18px 36px 28px 36px;border-top:1px solid #eee;font-size:12px;color:#888;line-height:1.5;">
        ${unsubLine || "You're receiving this because we spoke about staffing recently."}
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

// ─── Nurture templates ──────────────────────────────────────────
const TEMPLATES = {
    day3: ({ firstName }) => ({
        subject: "Even if the timing wasn't right",
        text:
`Hey ${firstName},

Following up on our recent conversation. Even if the timing wasn't right for us to work together now, you'll probably want this somewhere you can find it.

The Operator's Playbook: ${PLAYBOOK_URL}

Six chapters on the operational moves that separate the $300K service businesses from the $3M ones. Whether you build a team yourself or work with us later, the frameworks land either way.

If anything changes on your end, my calendar is here:
${REOPEN_URL}

— Paul`,
        html: shellHTML(`
            <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 14px 0;">Following up on our recent conversation. Even if the timing wasn't right for us to work together now, you'll probably want this somewhere you can find it.</p>
            <p style="margin:0 0 14px 0;"><strong>The Operator's Playbook</strong> — six chapters on the operational moves that separate the $300K service businesses from the $3M ones. Whether you build a team yourself or work with us later, the frameworks land either way.</p>
            ${btn(PLAYBOOK_URL, 'Read the Playbook →')}
            <p style="margin:14px 0 0 0;">If anything changes on your end, my calendar is here: <a href="${REOPEN_URL}" style="color:#0c1118;">book a follow-up call</a>.</p>
            <p style="margin:18px 0 0 0;">— Paul</p>
        `),
    }),

    day14: ({ firstName }) => ({
        subject: "How Flylisted cut their editing spend 60%",
        text:
`Hey ${firstName},

One real customer story while you're thinking through your options.

Flylisted, a real estate marketing company in Boston and South Florida, was paying per video to a rotating cast of freelance editors. As volume grew, the bill scaled linearly, brand voice drifted between editors, and turnaround was unpredictable.

They swapped to a dedicated Staffify editor on a flat monthly rate. Editing spend dropped 60%, turnaround locked at 12-24 hours, brand voice stabilized.

Full case study: ${FLYLISTED_URL}

If your situation rhymes with theirs, my calendar:
${REOPEN_URL}

— Paul`,
        html: shellHTML(`
            <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 14px 0;">One real customer story while you're thinking through your options.</p>
            <p style="margin:0 0 14px 0;"><strong>Flylisted</strong>, a real estate marketing company in Boston and South Florida, was paying per video to a rotating cast of freelance editors. As volume grew, the bill scaled linearly, brand voice drifted between editors, and turnaround was unpredictable.</p>
            <p style="margin:0 0 14px 0;">They swapped to a dedicated Staffify editor on a flat monthly rate. <strong>Editing spend dropped 60%</strong>, turnaround locked at 12-24 hours, brand voice stabilized.</p>
            ${btn(FLYLISTED_URL, 'Read the full case study →')}
            <p style="margin:14px 0 0 0;">If your situation rhymes with theirs, my calendar: <a href="${REOPEN_URL}" style="color:#0c1118;">book a follow-up call</a>.</p>
            <p style="margin:18px 0 0 0;">— Paul</p>
        `),
    }),

    day45: ({ firstName }) => ({
        subject: "Checking in",
        text:
`Hey ${firstName},

Quick check-in. It's been about six weeks since we talked. A few things might have shifted on your end:

— Hiring pressure moved up the priority list
— Margins got tighter (busy season pricing, freelancer rates climbing)
— A team member left and you're not eager to replace locally
— Or none of the above and life is great — in which case ignore this

If any of those are landing, the 25-minute call is still open:
${REOPEN_URL}

Either way, the playbook and case study are yours to keep:
${PLAYBOOK_URL}

— Paul`,
        html: shellHTML(`
            <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 14px 0;">Quick check-in. It's been about six weeks since we talked. A few things might have shifted on your end:</p>
            <ul style="margin:0 0 14px 18px;padding:0;font-size:15px;line-height:1.6;color:#1a1a1a;">
                <li>Hiring pressure moved up the priority list</li>
                <li>Margins got tighter (busy season pricing, freelancer rates climbing)</li>
                <li>A team member left and you're not eager to replace locally</li>
                <li>Or none of the above and life is great — in which case ignore this</li>
            </ul>
            <p style="margin:14px 0 0 0;">If any of those are landing, the 25-minute call is still open:</p>
            ${btn(REOPEN_URL, 'Book a follow-up call →')}
            <p style="margin:14px 0 0 0;">Either way, <a href="${PLAYBOOK_URL}" style="color:#0c1118;">the playbook</a> is yours to keep.</p>
            <p style="margin:18px 0 0 0;">— Paul</p>
        `, 'Last automated touch from this drip. You can unsubscribe anytime by replying.'),
    }),
};

// ─── Auth check ─────────────────────────────────────────────────
function authorized(req) {
    if (req.headers['x-vercel-cron']) return true;
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return false;
    const header = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    return m && m[1] === cronSecret;
}

// ─── Handler ────────────────────────────────────────────────────
export default async function handler(req, res) {
    if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

    const now = Date.now();
    const results = { processed: 0, day3_sent: 0, day14_sent: 0, day45_sent: 0, removed: 0, errors: 0 };

    try {
        const emails = await redis.zrange('nurture:active', 0, -1);
        for (const email of emails) {
            results.processed++;
            try {
                const rec = await redis.hgetall(`nurture:${email}`);
                if (!rec || !rec.enrolled_at) continue;

                const enrolledAt = Number(rec.enrolled_at);
                const ageDays = (now - enrolledAt) / DAY;

                const subscriber = await redis.hgetall(`subscriber:${email}`);
                const firstName = (subscriber && subscriber.first_name) || (email.split('@')[0] || 'there');

                // Don't keep nurturing someone who got reopened/converted
                if (subscriber && subscriber.status && subscriber.status !== 'no-close') {
                    await redis.zrem('nurture:active', email);
                    results.removed++;
                    continue;
                }

                // Day 3 email
                if (ageDays >= 3 && !rec.day3_sent_at) {
                    const t = TEMPLATES.day3({ firstName });
                    await sendViaResend({ to: email, ...t });
                    await redis.hset(`nurture:${email}`, { day3_sent_at: Date.now() });
                    results.day3_sent++;
                    continue; // one email per prospect per cron run is plenty
                }

                // Day 14 email
                if (ageDays >= 14 && !rec.day14_sent_at) {
                    const t = TEMPLATES.day14({ firstName });
                    await sendViaResend({ to: email, ...t });
                    await redis.hset(`nurture:${email}`, { day14_sent_at: Date.now() });
                    results.day14_sent++;
                    continue;
                }

                // Day 45 (final) email, then remove from queue
                if (ageDays >= 45 && !rec.day45_sent_at) {
                    const t = TEMPLATES.day45({ firstName });
                    await sendViaResend({ to: email, ...t });
                    await redis.hset(`nurture:${email}`, { day45_sent_at: Date.now() });
                    await redis.zrem('nurture:active', email);
                    results.day45_sent++;
                    results.removed++;
                }
            } catch (err) {
                console.error(`nurture error for ${email}`, err);
                results.errors++;
            }
        }

        return res.status(200).json({ ok: true, ts: now, ...results });
    } catch (err) {
        console.error('cron-nurture fatal', err);
        return res.status(500).json({ error: 'server_error', detail: String(err.message || err) });
    }
}
