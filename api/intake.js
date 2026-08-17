// POST /api/intake
// Public "Get to building" intake from the marketing site (/start/).
// Drops the lead straight into the sales-hub pool (leads:by_date) so a rep can
// claim it, and pings Slack so the team sees it the second it lands.
// No secret required (it's a public form), but a honeypot + email validation
// keep the noise down.

import { redis, readBody, newToken } from './_auth.js';
import { slackNotify } from './_slack.js';

const ALLOWED_ORIGINS = [
    'https://www.gostaffify.com',
    'https://gostaffify.com',
    'http://localhost:3000',
    'http://localhost:8899',
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

const isEmail = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length < 254;
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

export default async function handler(req, res) {
    const h = corsHeaders(req.headers.origin);
    for (const k in h) res.setHeader(k, h[k]);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    const b = readBody(req) || {};
    if (b.website) return res.status(200).json({ ok: true }); // honeypot: pretend success

    const email = clean(b.email, 254);
    if (!isEmail(email)) return res.status(400).json({ error: 'valid_email_required' });

    const note = [
        b.sell && `Sells: ${clean(b.sell, 400)}`,
        b.target && `Target: ${clean(b.target, 400)}`,
        b.stage && `Outbound now: ${clean(b.stage, 120)}`,
        b.notes && clean(b.notes, 600),
    ].filter(Boolean).join(' · ');

    const lead = {
        id: 'lead:' + Date.now() + ':' + newToken(4),
        name: clean(b.name, 120),
        email,
        phone: clean(b.phone, 40),
        company: clean(b.company, 160),
        source: clean(b.source, 60) || 'sales-intake',
        note,
        status: 'new',
        owner: '',
        created_at: String(Date.now()),
    };

    try {
        await redis.hset(lead.id, lead);
        await redis.zadd('leads:by_date', { score: Date.now(), member: lead.id });
    } catch (e) {
        return res.status(500).json({ error: 'store_failed' });
    }

    slackNotify(
        `:rocket: *New "Get to building" intake* — *${lead.company || lead.name || email}*`
        + `\n:email: ${email}` + (lead.phone ? `  ·  :telephone_receiver: ${lead.phone}` : '')
        + (lead.note ? `\n> ${lead.note.slice(0, 500)}` : '')
        + `\n:mag: Claim it in the hub: https://www.gostaffify.com/campaigns/  (Leads)`
    );

    return res.status(200).json({ ok: true });
}
