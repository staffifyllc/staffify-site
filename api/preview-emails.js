// GET /api/preview-emails/?email=you@example.com
// Sends all 6 marketing emails (welcome + day 2/6/12/21/45) to a given inbox
// immediately, prefixed with [PREVIEW] in the subject. Lets you review the
// entire soft-yes sequence without waiting 45 days.
//
// Auth: Authorization: Bearer <ADMIN_TOKEN>
//
// Does NOT write to Upstash. Does NOT enroll the email. Pure preview.

const DELEGATE_URL      = 'https://www.gostaffify.com/delegate/';
const FLYLISTED_URL     = 'https://www.gostaffify.com/case-studies/flylisted/';
const ADMIN_CASE_URL    = 'https://www.gostaffify.com/case-studies/operator-time-reclaimed/';
const OPERATOR_TRAP_URL = 'https://www.gostaffify.com/blog/operator-trap/';
const BOOK_URL          = 'https://calendly.com/go-staffify/discovery-call?utm_content=softyes';

function authorized(req) {
    const token = process.env.ADMIN_TOKEN;
    if (!token) return false;
    const header = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    return !!m && m[1] === token;
}

function isValidEmail(s) {
    return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length < 254;
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

function shellHTML(bodyHTML, footer) {
    return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;">
      <tr><td style="padding:36px 36px 28px 36px;font-size:16px;line-height:1.6;color:#1a1a1a;">${bodyHTML}</td></tr>
      <tr><td style="padding:18px 36px 28px 36px;border-top:1px solid #eee;font-size:12px;color:#888;line-height:1.5;">
        ${footer || "PREVIEW. You're getting this because you triggered the preview endpoint."}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function btn(href, label) {
    return `<p style="margin:20px 0;"><a href="${href}" style="display:inline-block;background:#0c1118;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600;font-size:15px;">${label}</a></p>`;
}

function welcomeEmail(firstName) {
    const text = `Hey,

Here's what you signed up for. Ten specific things to move off your plate this month, ordered by ROI. Hours saved. Dollar value reclaimed per category. What "done" actually looks like.

Read it here: ${DELEGATE_URL}

The short version: across all ten, the average founder we work with reclaims 30 to 50 hours per week within 60 days. At $150 to $300 per hour of founder time, that's $18,000 to $60,000 per month of opportunity cost recaptured. The delegated headcount typically runs $2,000 to $4,500 per role.

The math, even ungenerously, is 4 to 15x ROI in month one.

The hard part isn't the math. It's picking which one to delegate first, finding the right person, and not blowing it on the handoff. That's what we do at Staffify.

If you want a second pair of eyes on which delegation pays back fastest in your specific business, my calendar:

${BOOK_URL}

Paul
Founder, Staffify`;
    const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;">
        <tr><td style="padding:36px 36px 28px 36px;font-size:16px;line-height:1.6;color:#1a1a1a;">
          <p style="margin:0 0 14px 0;">Hey,</p>
          <p style="margin:0 0 14px 0;">Here's what you signed up for. <strong>Ten specific things to move off your plate this month, ordered by ROI.</strong> Hours saved. Dollar value reclaimed per category. What "done" actually looks like.</p>
          <p style="margin:22px 0;">
            <a href="${DELEGATE_URL}" style="display:inline-block;background:#0c1118;color:#ffffff;text-decoration:none;padding:14px 26px;border-radius:10px;font-weight:700;font-size:15px;">Read the list →</a>
          </p>
          <p style="margin:0 0 14px 0;"><strong>The short version:</strong> across all ten, the average founder we work with reclaims <strong>30 to 50 hours per week within 60 days</strong>. At $150 to $300 per hour of founder time, that's $18,000 to $60,000 per month of opportunity cost recaptured. The delegated headcount typically runs $2,000 to $4,500 per role.</p>
          <p style="margin:0 0 14px 0;">The math, even ungenerously, is <strong>4 to 15x ROI in month one</strong>.</p>
          <p style="margin:0 0 14px 0;">The hard part isn't the math. It's picking which one to delegate first, finding the right person, and not blowing it on the handoff. That's what we do at Staffify.</p>
          <p style="margin:0 0 14px 0;">If you want a second pair of eyes on which delegation pays back fastest in your specific business:</p>
          <p style="margin:0 0 22px 0;"><a href="${BOOK_URL}" style="color:#0c1118;font-weight:600;">Book a 25-min call →</a></p>
          <p style="margin:0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>
        </td></tr>
        <tr><td style="padding:18px 36px 28px 36px;border-top:1px solid #eee;font-size:12px;color:#888;line-height:1.5;">
          PREVIEW. This is the welcome email. Real subscribers see this without the [PREVIEW] prefix.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
    return { subject: 'The 10 highest-ROI delegations, inside', text, html };
}

function day2Email(firstName) {
    return {
        subject: 'The first one to delegate, and how to start',
        text:
`Hey ${firstName},

If the list landed and you're wondering which one to actually delegate first, the answer is almost always inbox.

The math is brutal. Most founders spend 7 to 12 hours per week on email. At $200 per hour of founder time, that's $5,600 to $9,600 per month bleeding out on something a trained assistant handles for about $2,500 per month.

Here's how to start without a six-week training plan:

1. Pull a week of sent mail. Tag every thread: "decision needed from me" vs "informational" vs "templated reply."
2. The templated reply pile is what you delegate first. Pull the 8 to 12 most common patterns into one doc.
3. Hand off "categorize and draft, I approve in one click." Two weeks later, your assistant ships replies on the templated patterns directly.

The full breakdown (which delegations stack best, in what order) is in the list:
${DELEGATE_URL}

If you want a second pair of eyes on which delegation pays back fastest:
${BOOK_URL}

Paul
Founder, Staffify`,
        html: shellHTML(`
            <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 14px 0;">If the list landed and you're wondering which one to actually delegate first, the answer is almost always inbox.</p>
            <p style="margin:0 0 14px 0;"><strong>The math is brutal.</strong> Most founders spend 7 to 12 hours per week on email. At $200 per hour of founder time, that's $5,600 to $9,600 per month bleeding out on something a trained assistant handles for about $2,500 per month.</p>
            <p style="margin:0 0 10px 0;">Here's how to start without a six-week training plan:</p>
            <ol style="margin:0 0 14px 18px;padding:0;font-size:15px;line-height:1.7;">
                <li>Pull a week of sent mail. Tag every thread: "decision needed from me" vs "informational" vs "templated reply."</li>
                <li>The templated reply pile is what you delegate first. Pull the 8 to 12 most common patterns into one doc.</li>
                <li>Hand off "categorize and draft, I approve in one click." Two weeks later, your assistant ships replies directly.</li>
            </ol>
            <p style="margin:0 0 14px 0;">The full breakdown is in the list: <a href="${DELEGATE_URL}" style="color:#0c1118;">${DELEGATE_URL}</a></p>
            <p style="margin:0 0 6px 0;">If you want a second pair of eyes on which delegation pays back fastest:</p>
            ${btn(BOOK_URL, 'Book a 25-min call →')}
            <p style="margin:18px 0 0 0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>
        `, "PREVIEW. This is day 2 of the soft-yes sequence."),
    };
}

function day6Email(firstName) {
    return {
        subject: 'Why your first hire usually fails',
        text:
`Hey ${firstName},

Most founders, when they finally decide to hire, hire the wrong person first. It almost always plays out the same way.

You're drowning. You decide to hire someone "to help with everything." You make the offer. They start. You spend two months training them on every system, every client, every nuance. By month three you're doing more work than before because now you're a manager AND an operator.

The trap: trying to clone yourself instead of subtracting from yourself.

The fix is the inverse. Hire one person for one job. The job that costs the most time but takes the least judgment. Usually admin or editing. Get that handoff clean, then add the next.

Full breakdown: ${OPERATOR_TRAP_URL}

When you're ready to subtract the first job: ${BOOK_URL}

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
        `, "PREVIEW. This is day 6 of the soft-yes sequence."),
    };
}

function day12Email(firstName) {
    return {
        subject: 'How a real-estate marketing studio cut editing spend 60%',
        text:
`Hey ${firstName},

A real customer story.

Flylisted is a real-estate marketing studio working with brokerages in Boston and South Florida. Their service was video. Their bottleneck was the editing room.

Before: rotating freelance editors charging per video. As volume grew, the bill scaled linearly. Brand voice drifted between editors. Turnaround was unpredictable, sometimes two days, sometimes ten.

After: one dedicated Staffify editor on a flat monthly rate. Editing spend dropped 60%. Turnaround locked at 12 to 24 hours. Brand voice stabilized because the same editor cuts every video.

Full case study: ${FLYLISTED_URL}

If your situation rhymes with theirs: ${BOOK_URL}

Paul
Founder, Staffify`,
        html: shellHTML(`
            <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 14px 0;">A real customer story.</p>
            <p style="margin:0 0 14px 0;"><strong>Flylisted</strong> is a real-estate marketing studio working with brokerages in Boston and South Florida. Their service was video. Their bottleneck was the editing room.</p>
            <p style="margin:0 0 14px 0;"><strong>Before:</strong> rotating freelance editors charging per video. As volume grew, the bill scaled linearly. Brand voice drifted between editors. Turnaround was unpredictable, sometimes two days, sometimes ten.</p>
            <p style="margin:0 0 14px 0;"><strong>After:</strong> one dedicated Staffify editor on a flat monthly rate. Editing spend dropped 60%. Turnaround locked at 12 to 24 hours. Brand voice stabilized because the same editor cuts every video.</p>
            ${btn(FLYLISTED_URL, 'Read the full case study →')}
            <p style="margin:14px 0 0 0;">If your situation rhymes with theirs: <a href="${BOOK_URL}" style="color:#0c1118;">book a 25-min call</a>.</p>
            <p style="margin:18px 0 0 0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>
        `, "PREVIEW. This is day 12 of the soft-yes sequence."),
    };
}

function day21Email(firstName) {
    return {
        subject: '60 founder-hours, reclaimed',
        text:
`Hey ${firstName},

Another one, different shape.

A real-estate marketing studio running roughly $50K/month was operating with the founder doing every administrative function. Vendor coordination. Client invoicing. Inbox triage. Calendar control. Listing audits.

After bringing on a Staffify admin, within 30 days: 60 founder hours per month reclaimed. Roughly $10K of opportunity cost recaptured (those hours redirected to sales calls and product work).

The math is uncomfortable: most founders billing at $200 to $500 per hour are doing $15 to $25 per hour work for 25 to 30% of their week. The recapture pays for the hire inside the first week.

Full breakdown: ${ADMIN_CASE_URL}

If your week looks like that: ${BOOK_URL}

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
        `, "PREVIEW. This is day 21 of the soft-yes sequence."),
    };
}

function day45Email(firstName) {
    return {
        subject: 'One last note from me',
        text:
`Hey ${firstName},

Last note from this sequence. You grabbed the list six weeks back and I've sent you a handful of emails. I'd rather not keep going if nothing's landed.

If you're still in the same spot (running flat out, no leverage hire yet, knowing it's costing you), here's the door, one more time:
${BOOK_URL}

If you'd rather just keep building the list yourself, that works too. The 30-Day ROI list is yours to keep:
${DELEGATE_URL}

Either way, good luck with what you're building.

Paul
Founder, Staffify`,
        html: shellHTML(`
            <p style="margin:0 0 14px 0;">Hey ${firstName},</p>
            <p style="margin:0 0 14px 0;">Last note from this sequence. You grabbed the list six weeks back and I've sent you a handful of emails. I'd rather not keep going if nothing's landed.</p>
            <p style="margin:0 0 14px 0;">If you're still in the same spot (running flat out, no leverage hire yet, knowing it's costing you), here's the door, one more time:</p>
            ${btn(BOOK_URL, 'Book a 25-min call →')}
            <p style="margin:14px 0 0 0;">If you'd rather just keep building the list yourself, that works too. The 30-Day ROI list is yours to keep: <a href="${DELEGATE_URL}" style="color:#0c1118;">${DELEGATE_URL}</a></p>
            <p style="margin:14px 0 0 0;">Either way, good luck with what you're building.</p>
            <p style="margin:18px 0 0 0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>
        `, 'PREVIEW. This is day 45 (last touch) of the soft-yes sequence.'),
    };
}

export default async function handler(req, res) {
    if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

    const url = new URL(req.url, `https://${req.headers.host}`);
    const email = (url.searchParams.get('email') || '').toString().trim().toLowerCase();
    const firstName = (url.searchParams.get('name') || email.split('@')[0] || 'there').toString();

    if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' });

    const sequence = [
        welcomeEmail(firstName),
        day2Email(firstName),
        day6Email(firstName),
        day12Email(firstName),
        day21Email(firstName),
        day45Email(firstName),
    ];

    const sent = [];
    const errors = [];
    for (const tmpl of sequence) {
        try {
            const subject = `[PREVIEW] ${tmpl.subject}`;
            const r = await sendViaResend({ to: email, subject, html: tmpl.html, text: tmpl.text });
            sent.push({ subject, id: r.id });
            // Tiny pause to keep ordering deterministic in the inbox
            await new Promise(rs => setTimeout(rs, 400));
        } catch (err) {
            errors.push({ subject: tmpl.subject, error: String(err.message || err) });
        }
    }

    return res.status(200).json({ ok: errors.length === 0, to: email, sent_count: sent.length, sent, errors });
}
