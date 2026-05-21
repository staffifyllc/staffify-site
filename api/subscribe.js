// POST /api/subscribe
// Stores the email in Upstash Redis and fires the playbook delivery via Resend.
// No external marketing tool. We own the list.
//
// Env vars required (set in Vercel project settings):
//   RESEND_API_KEY          — from https://resend.com/api-keys
//   UPSTASH_REDIS_REST_URL  — from Vercel → Storage → connected Upstash KV
//   UPSTASH_REDIS_REST_TOKEN
//   FROM_EMAIL              — verified sender (e.g. "Staffify <hello@gostaffify.com>")

import { Redis } from '@upstash/redis';

// Vercel's Upstash integration injects KV_REST_API_URL / KV_REST_API_TOKEN.
// Construct the client explicitly so it works without env var aliasing.
const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const DELEGATE_URL = 'https://www.gostaffify.com/delegate/';
const CALENDLY_URL = 'https://calendly.com/go-staffify/discovery-call?utm_content=delegate';

const ALLOWED_ORIGINS = [
    'https://www.gostaffify.com',
    'https://gostaffify.com',
    'http://localhost:3000',
];

function corsHeaders(origin) {
    const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin': allow,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
    };
}

function isValidEmail(s) {
    return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length < 254;
}

function renderEmail(email) {
    const text = `Hey,

Here's what you signed up for. Ten specific things to move off your plate this month, ordered by ROI. Hours saved. Dollar value reclaimed per category. What "done" actually looks like.

Read it here: ${DELEGATE_URL}

The short version: across all ten, the average founder we work with reclaims 30 to 50 hours per week within 60 days. At $150 to $300 per hour of founder time, that's $18,000 to $60,000 per month of opportunity cost recaptured. The delegated headcount typically runs $2,000 to $4,500 per role.

The math, even ungenerously, is 4 to 15x ROI in month one.

The hard part isn't the math. It's picking which one to delegate first, finding the right person, and not blowing it on the handoff. That's what we do at Staffify.

If you want a second pair of eyes on which delegation pays back fastest in your specific business, my calendar:

${CALENDLY_URL}

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
          <p style="margin:0 0 22px 0;"><a href="${CALENDLY_URL}" style="color:#0c1118;font-weight:600;">Book a 25-min call →</a></p>
          <p style="margin:0;">Paul<br><span style="color:#6b6b6b;">Founder, Staffify</span></p>
        </td></tr>
        <tr><td style="padding:18px 36px 28px 36px;border-top:1px solid #eee;font-size:12px;color:#888;line-height:1.5;">
          You're receiving this because you requested the 30-Day ROI List at gostaffify.com. Reply with the word "stop" if you'd rather not get the follow-ups.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

    return { text, html };
}

async function sendViaResend({ to, subject, html, text }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.FROM_EMAIL || 'Staffify <hello@gostaffify.com>';
    if (!apiKey) throw new Error('RESEND_API_KEY not set');

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to, subject, html, text, reply_to: 'hello@gostaffify.com' }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Resend ${res.status}: ${detail}`);
    }
    return res.json();
}

export default async function handler(req, res) {
    const origin = req.headers.origin || '';
    const cors = corsHeaders(origin);
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const email = (body.email || '').toString().trim().toLowerCase();
    const source = (body.source || 'unknown').toString().slice(0, 64);
    // Honeypot: if 'website' field is populated, silently accept and bail.
    if (body.website) return res.status(200).json({ ok: true });

    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'invalid_email' });
    }

    const now = Date.now();
    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 256);

    try {
        // Rate-limit by IP: 10 signups per hour
        if (ip) {
            const rlKey = `rl:subscribe:${ip}`;
            const count = await redis.incr(rlKey);
            if (count === 1) await redis.expire(rlKey, 3600);
            if (count > 10) return res.status(429).json({ error: 'rate_limited' });
        }

        // Has this email signed up before?
        const existing = await redis.hget(`subscriber:${email}`, 'signed_up_at');

        // Upsert subscriber record
        await redis.hset(`subscriber:${email}`, {
            email,
            source,
            signed_up_at: existing || now,
            last_seen_at: now,
            ip,
            ua,
        });
        await redis.zadd('subscribers:by_date', { score: existing ? Number(existing) : now, member: email });

        // Determine whether to send the playbook + enroll in soft-yes drip.
        // Rules:
        //   First signup ever                                          → send + enroll
        //   Returning signup, no prior soft-yes record                 → send + enroll
        //   Returning signup, soft-yes completed/graduated 90+ days ago AND no decision recorded → re-send + re-enroll
        //   Otherwise (active drip in progress, recent completion, decision set, in post-call nurture) → silent
        const REENROLL_AFTER_MS = 90 * 86400 * 1000;
        const subRec = await redis.hgetall(`subscriber:${email}`);
        const softyesRec = await redis.hgetall(`softyes:${email}`);
        const inPostCallNurture = await redis.hget(`nurture:${email}`, 'enrolled_at');

        const decisionSet = !!(subRec && subRec.decision && String(subRec.decision).length);
        const softyesEndedAt = softyesRec
            ? Number(softyesRec.graduated_at || softyesRec.completed_at || softyesRec.day45_sent_at || 0)
            : 0;
        const eligibleToReenroll = softyesEndedAt && (now - softyesEndedAt) >= REENROLL_AFTER_MS && !decisionSet;

        const isFirstSignup = !existing;
        const shouldEnroll =
            !inPostCallNurture && !decisionSet && (
                isFirstSignup ||
                !softyesRec || !softyesRec.enrolled_at ||  // had subscriber row but no prior drip
                eligibleToReenroll
            );

        if (isFirstSignup || eligibleToReenroll) {
            await sendViaResend({
                to: email,
                subject: "The 10 highest-ROI delegations, inside",
                ...renderEmail(email),
            });
            await redis.hset(`subscriber:${email}`, { playbook_sent_at: Date.now() });
        }

        if (shouldEnroll) {
            // Wipe prior stage timestamps so the new drip starts fresh from day 2.
            const reEnrolled = !!(softyesRec && softyesRec.enrolled_at);
            await redis.hset(`softyes:${email}`, {
                email,
                source,
                enrolled_at: Date.now(),
                day2_sent_at: '',
                day6_sent_at: '',
                day12_sent_at: '',
                day21_sent_at: '',
                day45_sent_at: '',
                graduated_at: '',
                graduated_reason: '',
                completed_at: '',
                ...(reEnrolled ? { reenroll_count: (Number(softyesRec.reenroll_count || 0) + 1), reenrolled_at: Date.now() } : {}),
            });
            await redis.zadd('softyes:active', { score: Date.now(), member: email });
        }

        return res.status(200).json({
            ok: true,
            returning: !!existing,
            re_enrolled: !!(eligibleToReenroll && shouldEnroll),
        });
    } catch (err) {
        console.error('subscribe error', err);
        return res.status(500).json({ error: 'server_error' });
    }
}
