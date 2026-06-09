// POST /api/backfill-nurture
//
// One-shot enrollment for a list of people who already booked sales calls
// but never made it into the post-call nurture (cron-nurture.js) drip.
// Writes `nurture:${email}` hash + adds to `nurture:active` sorted set.
//
// Auth: Authorization: Bearer <CRON_SECRET or ADMIN_TOKEN>
//
// Body: { emails: [{ email, name?, call_date? }, ...], dry?: boolean, commit?: boolean }
// Defaults to dry-run. Set commit=true to actually write.

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

function authorized(req) {
    const admin = process.env.ADMIN_TOKEN || '';
    const cron  = process.env.CRON_SECRET || '';
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    return (admin && m[1] === admin) || (cron && m[1] === cron);
}

function isValidEmail(s) {
    return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length < 254;
}

export default async function handler(req, res) {
    if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const emails = Array.isArray(body.emails) ? body.emails : [];
    const commit = body.commit === true;
    if (emails.length === 0) {
        return res.status(400).json({ error: 'no_emails' });
    }

    const now = Date.now();
    const enrolled = [];
    const already = [];
    const invalid = [];

    for (const entry of emails) {
        const email = String(entry.email || '').trim().toLowerCase();
        if (!isValidEmail(email)) { invalid.push(email); continue; }

        // Skip if already in nurture
        const existing = await redis.hget(`nurture:${email}`, 'enrolled_at');
        if (existing) { already.push(email); continue; }

        if (!commit) {
            enrolled.push({ email, name: entry.name || '', source: 'backfill-booked-calls' });
            continue;
        }

        await redis.hset(`nurture:${email}`, {
            email,
            name: String(entry.name || ''),
            enrolled_at: now,
            enrolled_source: 'backfill-booked-calls',
            historical_call_date: String(entry.call_date || ''),
            day3_sent_at: '',
            day14_sent_at: '',
            day45_sent_at: '',
        });
        await redis.zadd('nurture:active', { score: now, member: email });
        enrolled.push({ email, name: entry.name || '', source: 'backfill-booked-calls' });
    }

    return res.status(200).json({
        ok: true,
        dry: !commit,
        scanned: emails.length,
        enrolled: enrolled.length,
        already_in_nurture: already.length,
        invalid: invalid.length,
        sample_enrolled: enrolled.slice(0, 8),
        sample_already: already.slice(0, 5),
    });
}
