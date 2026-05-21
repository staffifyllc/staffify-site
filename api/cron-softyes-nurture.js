// GET /api/cron-softyes-nurture/  (scheduled daily by Vercel cron)
// Sends day-2, day-6, day-12, day-21, day-45 emails to soft-yes
// subscribers (people who downloaded the playbook but never booked a call).
//
// Auth: x-vercel-cron header (set automatically by Vercel cron) OR
// Authorization: Bearer <CRON_SECRET> for manual triggers.

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const DAY = 86400 * 1000;
const PLAYBOOK_URL          = 'https://www.gostaffify.com/playbook/';
const FLYLISTED_URL         = 'https://www.gostaffify.com/case-studies/flylisted/';
const ADMIN_CASE_URL        = 'https://www.gostaffify.com/case-studies/operator-time-reclaimed/';
const OPERATOR_TRAP_URL     = 'https://www.gostaffify.com/blog/operator-trap/';
const BOOK_URL              = 'https://calendly.com/go-staffify/discovery-call?utm_content=softyes';

function shellHTML(bodyHTML, footer) {
    return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;">
      <tr><td style="padding:36px 36px 28px 36px;font-size:16px;line-height:1.6;color:#1a1a1a;">${bodyHTML}</td></tr>
      <tr><td style="padding:18px 36px 28px 36px;border-top:1px solid #eee;font-size:12px;color:#888;line-height:1.5;">
        ${footer || "You're receiving this because you grabbed the Operator's Playbook at gostaffify.com. Reply with the word \"stop\" if you'd rather not get the rest."}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function btn(href, label) {
    return `<p style="margin:20px 0;"><a href="${href}" style="display:inline-block;background:#0c1118;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600;font-size:15px;">${label}</a></p>`;
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

const TEMPLATES = {
    day2: ({ firstName }) => ({
        subject: 'The 60-minute audit from chapter one',
        text:
`Hey ${firstName},

Quick note. The playbook you grabbed has six chapters but if you only do one thing this week, do the audit from chapter one.

It takes 60 minutes. Short version:

1. Pull your calendar from the last two weeks.
2. Color-code every block: green if it required your specific skill, yellow if a trained person could have done it, red if it shouldn't have happened at all.
3. Tally the yellow + red hours.

That number is your weekly bottleneck. Most founders we work with land between 18 and 28 hours per week of yellow + red. Three to four full work days. Reclaimed, that's a second product line, a sales sprint, or the strategic work the business actually needs from you.

The full chapter (and the workbook) is in the playbook:
${PLAYBOOK_URL}

If your number lands high and you want a second pair of eyes on what to delegate first, my calendar is here:
${BOOK_URL}

Paul
Founder, Staffify`,
        html: shellHTML(`
            <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 14px 0;">Quick note. The playbook you grabbed has six chapters but if you only do one thing this week, do the audit from chapter one.</p>
            <p style="margin:0 0 10px 0;">It takes 60 minutes. Short version:</p>
            <ol style="margin:0 0 14px 18px;padding:0;font-size:15px;line-height:1.7;">
                <li>Pull your calendar from the last two weeks.</li>
                <li>Color-code every block: green if it required your specific skill, yellow if a trained person could have done it, red if it shouldn't have happened at all.</li>
                <li>Tally the yellow + red hours.</li>
            </ol>
            <p style="margin:0 0 14px 0;">That number is your weekly bottleneck. Most founders we work with land between 18 and 28 hours per week of yellow + red. Three to four full work days. Reclaimed, that's a second product line, a sales sprint, or the strategic work the business actually needs from you.</p>
            <p style="margin:0 0 14px 0;">The full chapter (and the workbook) is in the playbook: <a href="${PLAYBOOK_URL}" style="color:#0c1118;">${PLAYBOOK_URL}</a></p>
            <p style="margin:0 0 6px 0;">If your number lands high and you want a second pair of eyes on what to delegate first:</p>
            ${btn(BOOK_URL, 'Book a 25-min call →')}
            <p style="margin:18px 0 0 0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>
        `),
    }),

    day6: ({ firstName }) => ({
        subject: 'Why your first hire usually fails',
        text:
`Hey ${firstName},

Most founders, when they finally decide to hire, hire the wrong person first. It almost always plays out the same way.

You're drowning. You decide to hire someone "to help with everything." You make the offer. They start. You spend two months training them on every system, every client, every nuance. By month three you're doing more work than before because now you're a manager AND an operator.

The trap: trying to clone yourself instead of subtracting from yourself.

The fix is the inverse. Hire one person for one job. The job that costs the most time but takes the least judgment. Usually admin or editing. Get that handoff clean, then add the next.

We wrote the full breakdown here:
${OPERATOR_TRAP_URL}

When you're ready to subtract the first job:
${BOOK_URL}

Paul
Founder, Staffify`,
        html: shellHTML(`
            <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 14px 0;">Most founders, when they finally decide to hire, hire the wrong person first. It almost always plays out the same way.</p>
            <p style="margin:0 0 14px 0;">You're drowning. You decide to hire someone "to help with everything." You make the offer. They start. You spend two months training them on every system, every client, every nuance. By month three you're doing more work than before because now you're a manager AND an operator.</p>
            <p style="margin:0 0 14px 0;"><strong>The trap: trying to clone yourself instead of subtracting from yourself.</strong></p>
            <p style="margin:0 0 14px 0;">The fix is the inverse. Hire one person for one job. The job that costs the most time but takes the least judgment. Usually admin or editing. Get that handoff clean, then add the next.</p>
            ${btn(OPERATOR_TRAP_URL, 'Read the full breakdown →')}
            <p style="margin:14px 0 0 0;">When you're ready to subtract the first job: <a href="${BOOK_URL}" style="color:#0c1118;">book a 25-min call</a>.</p>
            <p style="margin:18px 0 0 0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>
        `),
    }),

    day12: ({ firstName }) => ({
        subject: 'How a real-estate marketing studio cut editing spend 60%',
        text:
`Hey ${firstName},

A real customer story.

Flylisted is a real-estate marketing studio working with brokerages in Boston and South Florida. Their service was video. Their bottleneck was the editing room.

Before: rotating freelance editors charging per video. As volume grew, the bill scaled linearly. Brand voice drifted between editors. Turnaround was unpredictable, sometimes two days, sometimes ten.

After: one dedicated Staffify editor on a flat monthly rate. Editing spend dropped 60%. Turnaround locked at 12 to 24 hours. Brand voice stabilized because the same editor cuts every video.

Full case study with the numbers:
${FLYLISTED_URL}

If your situation rhymes with theirs (volume scaling faster than your bench), the 25-minute call is the right next step:
${BOOK_URL}

Paul
Founder, Staffify`,
        html: shellHTML(`
            <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 14px 0;">A real customer story.</p>
            <p style="margin:0 0 14px 0;"><strong>Flylisted</strong> is a real-estate marketing studio working with brokerages in Boston and South Florida. Their service was video. Their bottleneck was the editing room.</p>
            <p style="margin:0 0 14px 0;"><strong>Before:</strong> rotating freelance editors charging per video. As volume grew, the bill scaled linearly. Brand voice drifted between editors. Turnaround was unpredictable, sometimes two days, sometimes ten.</p>
            <p style="margin:0 0 14px 0;"><strong>After:</strong> one dedicated Staffify editor on a flat monthly rate. Editing spend dropped 60%. Turnaround locked at 12 to 24 hours. Brand voice stabilized because the same editor cuts every video.</p>
            ${btn(FLYLISTED_URL, 'Read the full case study →')}
            <p style="margin:14px 0 0 0;">If your situation rhymes with theirs (volume scaling faster than your bench), the 25-minute call is the right next step: <a href="${BOOK_URL}" style="color:#0c1118;">book here</a>.</p>
            <p style="margin:18px 0 0 0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>
        `),
    }),

    day21: ({ firstName }) => ({
        subject: '60 founder-hours, reclaimed',
        text:
`Hey ${firstName},

Another one, different shape.

A real-estate marketing studio running roughly $50K/month was operating with the founder doing every administrative function. Vendor coordination. Client invoicing. Inbox triage. Calendar control. Listing audits.

After bringing on a Staffify admin, within 30 days: 60 founder hours per month reclaimed. Roughly $10K of opportunity cost recaptured (those hours redirected to sales calls and product work).

The math is uncomfortable: most founders billing at $200 to $500 per hour are doing $15 to $25 per hour work for 25 to 30% of their week. The recapture pays for the hire inside the first week.

Full breakdown:
${ADMIN_CASE_URL}

If your week looks like that:
${BOOK_URL}

Paul
Founder, Staffify`,
        html: shellHTML(`
            <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 14px 0;">Another one, different shape.</p>
            <p style="margin:0 0 14px 0;">A real-estate marketing studio running roughly $50K/month was operating with the founder doing every administrative function. Vendor coordination. Client invoicing. Inbox triage. Calendar control. Listing audits.</p>
            <p style="margin:0 0 14px 0;">After bringing on a Staffify admin, within 30 days: <strong>60 founder hours per month reclaimed</strong>. Roughly $10K of opportunity cost recaptured (those hours redirected to sales calls and product work).</p>
            <p style="margin:0 0 14px 0;">The math is uncomfortable: most founders billing at $200 to $500 per hour are doing $15 to $25 per hour work for 25 to 30% of their week. The recapture pays for the hire inside the first week.</p>
            ${btn(ADMIN_CASE_URL, 'Read the full breakdown →')}
            <p style="margin:14px 0 0 0;">If your week looks like that: <a href="${BOOK_URL}" style="color:#0c1118;">book a 25-min call</a>.</p>
            <p style="margin:18px 0 0 0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>
        `),
    }),

    day45: ({ firstName }) => ({
        subject: 'One last note from me',
        text:
`Hey ${firstName},

Last note from this sequence. You grabbed the playbook six weeks back and I've sent you a handful of emails. I'd rather not keep going if nothing's landed.

If you're still in the same spot (running flat out, no leverage hire yet, knowing it's costing you), here's the door, one more time:
${BOOK_URL}

If you'd rather just keep building the frameworks yourself, that works too. The playbook is yours to keep:
${PLAYBOOK_URL}

Either way, good luck with what you're building.

Paul
Founder, Staffify`,
        html: shellHTML(`
            <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 14px 0;">Last note from this sequence. You grabbed the playbook six weeks back and I've sent you a handful of emails. I'd rather not keep going if nothing's landed.</p>
            <p style="margin:0 0 14px 0;">If you're still in the same spot (running flat out, no leverage hire yet, knowing it's costing you), here's the door, one more time:</p>
            ${btn(BOOK_URL, 'Book a 25-min call →')}
            <p style="margin:14px 0 0 0;">If you'd rather just keep building the frameworks yourself, that works too. The playbook is yours to keep: <a href="${PLAYBOOK_URL}" style="color:#0c1118;">${PLAYBOOK_URL}</a></p>
            <p style="margin:14px 0 0 0;">Either way, good luck with what you're building.</p>
            <p style="margin:18px 0 0 0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>
        `, 'Last automated touch from this sequence. You can reply with "stop" if you want to be removed entirely.'),
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
    const result = {
        processed: 0,
        day2_sent: 0, day6_sent: 0, day12_sent: 0, day21_sent: 0, day45_sent: 0,
        graduated: 0, errors: 0,
    };

    try {
        const emails = await redis.zrange('softyes:active', 0, -1);
        for (const email of emails) {
            result.processed++;
            try {
                const rec = await redis.hgetall(`softyes:${email}`);
                if (!rec || !rec.enrolled_at) continue;

                const subscriber = (await redis.hgetall(`subscriber:${email}`)) || {};

                // Graduate out if they've engaged any other way:
                //   1. Already in post-call nurture (means they booked + had a call + got marked nope)
                //   2. Decision recorded (client or nope)
                //   3. Currently in disposition:pending (call happened, awaiting Paul's decision)
                const inPostCallNurture = await redis.hget(`nurture:${email}`, 'enrolled_at');
                const dispositionPending = await redis.zscore('disposition:pending', email);
                if (inPostCallNurture || dispositionPending || (subscriber.decision && subscriber.decision.length)) {
                    await redis.zrem('softyes:active', email);
                    await redis.hset(`softyes:${email}`, { graduated_at: Date.now(), graduated_reason: 'engaged' });
                    result.graduated++;
                    continue;
                }

                const enrolledAt = Number(rec.enrolled_at);
                const ageDays = (now - enrolledAt) / DAY;
                const firstName = subscriber.first_name || (email.split('@')[0] || 'there');

                if (ageDays >= 2 && !rec.day2_sent_at) {
                    await sendViaResend({ to: email, ...TEMPLATES.day2({ firstName }) });
                    await redis.hset(`softyes:${email}`, { day2_sent_at: Date.now() });
                    result.day2_sent++;
                    continue;
                }
                if (ageDays >= 6 && !rec.day6_sent_at) {
                    await sendViaResend({ to: email, ...TEMPLATES.day6({ firstName }) });
                    await redis.hset(`softyes:${email}`, { day6_sent_at: Date.now() });
                    result.day6_sent++;
                    continue;
                }
                if (ageDays >= 12 && !rec.day12_sent_at) {
                    await sendViaResend({ to: email, ...TEMPLATES.day12({ firstName }) });
                    await redis.hset(`softyes:${email}`, { day12_sent_at: Date.now() });
                    result.day12_sent++;
                    continue;
                }
                if (ageDays >= 21 && !rec.day21_sent_at) {
                    await sendViaResend({ to: email, ...TEMPLATES.day21({ firstName }) });
                    await redis.hset(`softyes:${email}`, { day21_sent_at: Date.now() });
                    result.day21_sent++;
                    continue;
                }
                if (ageDays >= 45 && !rec.day45_sent_at) {
                    await sendViaResend({ to: email, ...TEMPLATES.day45({ firstName }) });
                    await redis.hset(`softyes:${email}`, { day45_sent_at: Date.now(), completed_at: Date.now() });
                    await redis.zrem('softyes:active', email);
                    result.day45_sent++;
                }
            } catch (err) {
                console.error(`softyes-nurture error for ${email}`, err);
                result.errors++;
            }
        }

        return res.status(200).json({ ok: true, ts: now, ...result });
    } catch (err) {
        console.error('cron-softyes-nurture fatal', err);
        return res.status(500).json({ error: 'server_error', detail: String(err.message || err) });
    }
}
