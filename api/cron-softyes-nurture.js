// GET /api/cron-softyes-nurture/  (scheduled daily by Vercel cron)
// Sends day-2, day-6, day-12, day-21, day-45 emails to soft-yes
// subscribers (people who downloaded the playbook but never booked a call).
//
// Auth: x-vercel-cron header (set automatically by Vercel cron) OR
// Authorization: Bearer <CRON_SECRET> for manual triggers.

import { Redis } from '@upstash/redis';
import { link as unsubscribeLink } from '../lib/unsubscribe-token.js';
import { optedOutSet } from './_optout.js';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const DAY = 86400 * 1000;
const DELEGATE_URL          = 'https://www.gostaffify.com/delegate/';
const FLYLISTED_URL         = 'https://www.gostaffify.com/case-studies/flylisted/';
const ADMIN_CASE_URL        = 'https://www.gostaffify.com/case-studies/operator-time-reclaimed/';
const OPERATOR_TRAP_URL     = 'https://www.gostaffify.com/blog/operator-trap/';
const BOOK_URL              = 'https://calendly.com/go-staffify/discovery-call?utm_content=softyes';

// "Sexier" 2026 email shell. Matches cron-nurture.js — black band header
// with Staffify wordmark + cyan dot, white card with cyan top accent,
// glowing brand-cyan CTA button.
function shellHTML(bodyHTML, footer, unsubLink) {
    const footerText = footer || "You grabbed the 30-Day ROI list at gostaffify.com.";
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

function btn(href, label) {
    return `<p style="margin:24px 0 16px 0;"><a href="${href}" style="display:inline-block;background:#1abde1;background-image:linear-gradient(180deg,#1abde1 0%,#0fa3c5 100%);color:#000000;text-decoration:none;padding:15px 30px;border-radius:999px;font-weight:800;font-size:14px;letter-spacing:0.02em;box-shadow:0 8px 24px rgba(26,189,225,0.35);">${label}</a></p>`;
}

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

function withUnsubFooter(text, unsubLink) {
    return unsubLink ? `${text}\n\n— Unsubscribe in one click: ${unsubLink}` : text;
}

export const TEMPLATES = {
    day2: ({ firstName, unsubLink }) => ({
        subject: 'Start with inbox. Here\'s the math.',
        text: withUnsubFooter(
`Hey ${firstName},

If the list landed, you're probably wondering which one to actually delegate first.

The answer is almost always inbox. Here's why.

  $9,600/mo — bleeding out on email at $200/hr founder time
  $2,500/mo — what a trained assistant costs to handle it
  $5K-9K/mo — recapture in month one

Three-step start. No six-week training plan:

1. Pull a week of sent mail. Tag every thread "decision needed" vs "informational" vs "templated reply."
2. The templated pile is what you delegate first. Eight to twelve patterns in one doc.
3. Hand off "categorize and draft, I approve in one click." Two weeks later your assistant ships the templated patterns directly.

The full breakdown (which delegations stack best, in what order):
${DELEGATE_URL}

If you want a second pair of eyes on yours specifically:
${BOOK_URL}

Paul
Founder, Staffify`, unsubLink),
        html: shellHTML(`
            ${eyebrow('The first delegation')}
            <p style="margin:0 0 16px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 18px 0;">If the list landed, you're probably wondering which one to actually delegate first.</p>
            <p style="margin:0 0 0 0;font-size:17px;font-weight:700;color:#0c1118;">The answer is almost always inbox. Here's why.</p>
            ${pullStat('$9,600/mo', 'Bleeding out on email at $200/hr')}
            ${pullStat('$2,500/mo', 'Trained assistant to handle it')}
            ${pullStat('$5K-9K/mo', 'Recapture in month one')}
            <p style="margin:0 0 10px 0;font-weight:700;">Three-step start. No six-week training plan:</p>
            <ol style="margin:0 0 18px 22px;padding:0;font-size:15px;line-height:1.75;color:#333;">
                <li>Pull a week of sent mail. Tag every thread "decision needed" vs "informational" vs "templated reply."</li>
                <li>The templated pile is what you delegate first. Eight to twelve patterns in one doc.</li>
                <li>Hand off <em>"categorize and draft, I approve in one click."</em> Two weeks later your assistant ships the templated patterns directly.</li>
            </ol>
            <p style="margin:0 0 4px 0;color:#444;">Want a second pair of eyes on yours specifically?</p>
            ${btn(BOOK_URL, 'Book a 25-min call →')}
            <p style="margin:18px 0 0 0;font-size:14px;color:#666;">Or skim the full breakdown: <a href="${DELEGATE_URL}" style="color:#0d82b8;font-weight:600;">the 30-day list</a>.</p>
            <p style="margin:22px 0 0 0;">Paul<br><span style="color:#888;font-size:14px;">Founder, Staffify</span></p>
        `, null, unsubLink),
    }),

    day6: ({ firstName, unsubLink }) => ({
        subject: 'Why most first hires fail (and what works)',
        text: withUnsubFooter(
`Hey ${firstName},

Most founders, when they finally decide to hire, hire the wrong person first. It almost always plays out the same way:

You're drowning. You hire someone "to help with everything." They start. You spend two months training them on every system, every client, every nuance. By month three you're doing more work than before — because now you're a manager AND an operator.

The trap: trying to clone yourself instead of subtracting from yourself.

The fix is the inverse. Hire one person for one job. The job that costs the most time but takes the least judgment. Usually admin or editing. Get that handoff clean, then add the next.

Full breakdown:
${OPERATOR_TRAP_URL}

When you're ready to subtract the first job:
${BOOK_URL}

Paul
Founder, Staffify`, unsubLink),
        html: shellHTML(`
            ${eyebrow('Most first hires fail')}
            <p style="margin:0 0 16px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 16px 0;">Most founders, when they finally decide to hire, hire the wrong person first. It almost always plays out the same way:</p>
            <p style="margin:0 0 16px 0;color:#444;">You're drowning. You hire someone "to help with everything." They start. You spend two months training them on every system, every client, every nuance. By month three you're doing more work than before — because now you're a manager AND an operator.</p>
            <p style="margin:0 0 16px 0;padding:14px 20px;background:#fff4f4;border-left:3px solid #dc2626;color:#7a1a1a;font-style:italic;">The trap: trying to clone yourself instead of subtracting from yourself.</p>
            <p style="margin:0 0 14px 0;color:#444;">The fix is the inverse. <strong>Hire one person for one job.</strong> The job that costs the most time but takes the least judgment. Usually admin or editing. Get that handoff clean, then add the next.</p>
            ${btn(OPERATOR_TRAP_URL, 'Read the full breakdown →')}
            <p style="margin:18px 0 0 0;font-size:14px;color:#666;">When you're ready to subtract the first job: <a href="${BOOK_URL}" style="color:#0d82b8;font-weight:600;">25-minute call</a>.</p>
            <p style="margin:22px 0 0 0;">Paul<br><span style="color:#888;font-size:14px;">Founder, Staffify</span></p>
        `, null, unsubLink),
    }),

    day12: ({ firstName, unsubLink }) => ({
        subject: '60% off editing. Same quality.',
        text: withUnsubFooter(
`Hey ${firstName},

Real story.

Flylisted is a real-estate marketing studio working with brokerages in Boston and South Florida. Service: video. Bottleneck: the editing room.

Before — rotating freelance editors charging per video. As volume grew:
  · The bill scaled linearly
  · Brand voice drifted between editors
  · Turnaround swung wildly. Two days, sometimes ten.

After — one dedicated Staffify editor on a flat monthly rate:

  60% lower    editing spend
  12-24hr     turnaround locked
  One voice   across every cut

Full case study with the numbers:
${FLYLISTED_URL}

If your volume is scaling faster than your bench:
${BOOK_URL}

Paul
Founder, Staffify`, unsubLink),
        html: shellHTML(`
            ${eyebrow('A real customer story')}
            <p style="margin:0 0 16px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 16px 0;"><strong>Flylisted</strong> is a real-estate marketing studio working with brokerages in Boston and South Florida. Service: video. Bottleneck: the editing room.</p>
            <p style="margin:0 0 8px 0;font-weight:700;">Before — rotating freelance editors charging per video.</p>
            <ul style="margin:0 0 16px 22px;padding:0;font-size:15px;line-height:1.7;color:#444;">
                <li>The bill scaled linearly</li>
                <li>Brand voice drifted between editors</li>
                <li>Turnaround swung wildly. Two days, sometimes ten.</li>
            </ul>
            <p style="margin:0 0 6px 0;font-weight:700;">After — one dedicated Staffify editor on a flat monthly rate:</p>
            ${pullStat('60% lower', 'Editing spend')}
            ${pullStat('12-24hr', 'Turnaround locked')}
            ${pullStat('One voice', 'Across every cut')}
            ${btn(FLYLISTED_URL, 'Read the case study →')}
            <p style="margin:18px 0 0 0;font-size:14px;color:#666;">If your volume is scaling faster than your bench: <a href="${BOOK_URL}" style="color:#0d82b8;font-weight:600;">25-minute call</a>.</p>
            <p style="margin:22px 0 0 0;">Paul<br><span style="color:#888;font-size:14px;">Founder, Staffify</span></p>
        `, null, unsubLink),
    }),

    day21: ({ firstName, unsubLink }) => ({
        subject: '60 founder-hours, gone. Here\'s where they went.',
        text: withUnsubFooter(
`Hey ${firstName},

Different shape, same shock.

A real-estate marketing studio doing $50K/month, founder doing every admin function. Vendor coordination. Client invoicing. Inbox triage. Calendar control. Listing audits.

Brought on one Staffify admin. Inside 30 days:

  60 hrs/mo   founder time reclaimed
  ~$10K/mo    opportunity cost recaptured
  $2K/mo      flat cost for the admin

The math is uncomfortable. Most founders billing at $200-500/hr are doing $15-25/hr work for 25-30% of their week. The recapture pays for the hire inside the first week.

Full breakdown:
${ADMIN_CASE_URL}

If your week looks like that:
${BOOK_URL}

Paul
Founder, Staffify`, unsubLink),
        html: shellHTML(`
            ${eyebrow('60 hours back')}
            <p style="margin:0 0 16px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 16px 0;color:#444;">Different shape, same shock. A real-estate marketing studio doing $50K/month, founder doing every admin function — vendor coordination, client invoicing, inbox triage, calendar control, listing audits.</p>
            <p style="margin:0 0 6px 0;font-weight:700;">Brought on one Staffify admin. Inside 30 days:</p>
            ${pullStat('60 hrs/mo', 'Founder time reclaimed')}
            ${pullStat('~$10K/mo', 'Opportunity cost recaptured')}
            ${pullStat('$2K/mo', 'Flat cost for the admin')}
            <p style="margin:0 0 16px 0;color:#444;font-style:italic;">The math is uncomfortable. Most founders billing at $200-500/hr are doing $15-25/hr work for 25-30% of their week. <strong style="font-style:normal;color:#0c1118;">The recapture pays for the hire inside the first week.</strong></p>
            ${btn(ADMIN_CASE_URL, 'Read the full breakdown →')}
            <p style="margin:18px 0 0 0;font-size:14px;color:#666;">If your week looks like that: <a href="${BOOK_URL}" style="color:#0d82b8;font-weight:600;">25-minute call</a>.</p>
            <p style="margin:22px 0 0 0;">Paul<br><span style="color:#888;font-size:14px;">Founder, Staffify</span></p>
        `, null, unsubLink),
    }),

    day45: ({ firstName, unsubLink }) => ({
        subject: 'Last one. Then I\'m out.',
        text: withUnsubFooter(
`Hey ${firstName},

Quick last note before I quiet down.

If you're still in the same spot — running flat out, no leverage hire yet, knowing it's costing you — the door's open one more time:

${BOOK_URL}

If you'd rather keep building it yourself, the list is yours to keep:
${DELEGATE_URL}

Either way, good luck with what you're building.

Paul
Founder, Staffify`, unsubLink),
        html: shellHTML(`
            ${eyebrow('One last thought')}
            <p style="margin:0 0 16px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 16px 0;color:#444;">Quick last note before I quiet down.</p>
            <p style="margin:0 0 16px 0;">If you're still in the same spot — <strong>running flat out, no leverage hire yet, knowing it's costing you</strong> — the door's open one more time:</p>
            ${btn(BOOK_URL, 'Book a 25-min call →')}
            <p style="margin:18px 0 0 0;font-size:14px;color:#666;">If you'd rather keep building it yourself, <a href="${DELEGATE_URL}" style="color:#0d82b8;font-weight:600;">the list</a> is yours to keep. Either way, good luck with what you're building.</p>
            <p style="margin:22px 0 0 0;">Paul<br><span style="color:#888;font-size:14px;">Founder, Staffify</span></p>
        `, "You requested the 30-Day ROI list at gostaffify.com.", unsubLink),
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
        graduated: 0, cycle_restarted: 0, errors: 0,
    };

    try {
        // Anyone who has opted out is dropped before a single send is attempted. This covers people who
        // replied STOP to a text as well as one-click email unsubscribes, because withdrawing consent
        // applies to every channel and not just the one they happened to use.
        const suppressed = await optedOutSet();
        const emails = await redis.zrange('softyes:active', 0, -1);
        for (const email of emails) {
            result.processed++;
            try {
                if (suppressed.emails.has(String(email).trim().toLowerCase())) {
                    await redis.zrem('softyes:active', email);
                    result.suppressed = (result.suppressed || 0) + 1;
                    continue;
                }
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

                let enrolledAt = Number(rec.enrolled_at);
                let ageDays = (now - enrolledAt) / DAY;
                const firstName = subscriber.first_name || (email.split('@')[0] || 'there');
                const unsubLink = unsubscribeLink(email);

                // ── COOLDOWN RE-LOOP ──
                // After touch 5 we mark `cool_off_until = now + 30 days`. When the
                // cron sees a subscriber whose cool_off_until is in the past, we
                // reset the cycle: clear the touch flags, advance the cycle counter,
                // rebase enrolled_at to NOW, and they restart from touch 1 in 7 days.
                // No email this run. They get the loop going again on the next tick.
                const coolOffUntil = Number(rec.cool_off_until || 0);
                if (coolOffUntil && now >= coolOffUntil) {
                    const newCycle = Number(rec.cycle || 1) + 1;
                    await redis.hset(`softyes:${email}`, {
                        enrolled_at: now,
                        day2_sent_at: '',
                        day6_sent_at: '',
                        day12_sent_at: '',
                        day21_sent_at: '',
                        day45_sent_at: '',
                        cool_off_until: '',
                        completed_at: '',
                        cycle: newCycle,
                        last_cycle_started_at: now,
                    });
                    await redis.zadd('softyes:active', { score: now, member: email });
                    result.cycle_restarted = (result.cycle_restarted || 0) + 1;
                    continue;
                }

                // Weekly cadence: touches at day 7, 14, 21, 28, 35. The internal
                // flag names (day2_sent_at, etc.) are kept for backwards-compat with
                // existing Redis records. The "day" in the field name is the touch
                // number, not the actual day count.
                if (ageDays >= 7 && !rec.day2_sent_at) {
                    await sendViaResend({ to: email, ...TEMPLATES.day2({ firstName, unsubLink }) });
                    await redis.hset(`softyes:${email}`, { day2_sent_at: Date.now() });
                    result.day2_sent++;
                    continue;
                }
                if (ageDays >= 14 && !rec.day6_sent_at) {
                    await sendViaResend({ to: email, ...TEMPLATES.day6({ firstName, unsubLink }) });
                    await redis.hset(`softyes:${email}`, { day6_sent_at: Date.now() });
                    result.day6_sent++;
                    continue;
                }
                if (ageDays >= 21 && !rec.day12_sent_at) {
                    await sendViaResend({ to: email, ...TEMPLATES.day12({ firstName, unsubLink }) });
                    await redis.hset(`softyes:${email}`, { day12_sent_at: Date.now() });
                    result.day12_sent++;
                    continue;
                }
                if (ageDays >= 28 && !rec.day21_sent_at) {
                    await sendViaResend({ to: email, ...TEMPLATES.day21({ firstName, unsubLink }) });
                    await redis.hset(`softyes:${email}`, { day21_sent_at: Date.now() });
                    result.day21_sent++;
                    continue;
                }
                if (ageDays >= 35 && !rec.day45_sent_at) {
                    await sendViaResend({ to: email, ...TEMPLATES.day45({ firstName, unsubLink }) });
                    // Touch 5 sent. Don't remove from softyes:active — instead set a
                    // 30-day cooldown. After cool_off_until passes, the early
                    // cooldown-check block above resets the cycle and the drip
                    // restarts from touch 1 in another 7 days.
                    const COOLDOWN_DAYS = 30;
                    await redis.hset(`softyes:${email}`, {
                        day45_sent_at: Date.now(),
                        completed_at: Date.now(),
                        cool_off_until: Date.now() + (COOLDOWN_DAYS * DAY),
                    });
                    result.day45_sent++;
                }
            } catch (err) {
                console.error(`softyes-nurture error for ${email}`, err);
                result.errors++;
            }
        }

        // Write status for the Virtual Office (Paul's local office app polls this)
        // Key uses the same agent ID as the roster: staffify-softyes-drip
        const totalSent = result.day2_sent + result.day6_sent + result.day12_sent + result.day21_sent + result.day45_sent;
        const previous = await redis.hgetall('agent:status:staffify-softyes-drip').catch(() => ({}));
        const action = totalSent === 0
            ? `Checked ${result.processed} subscribers. No drips due.`
            : `Sent ${totalSent} drip emails (d2:${result.day2_sent} d6:${result.day6_sent} d12:${result.day12_sent} d21:${result.day21_sent} d45:${result.day45_sent})`;
        await redis.hset('agent:status:staffify-softyes-drip', {
            last_run_at: String(Date.now()),
            last_action: action,
            count_today: String(totalSent),
            count_total: String(Number(previous?.count_total || 0) + totalSent),
        });

        return res.status(200).json({ ok: true, ts: now, ...result });
    } catch (err) {
        console.error('cron-softyes-nurture fatal', err);
        return res.status(500).json({ error: 'server_error', detail: String(err.message || err) });
    }
}
