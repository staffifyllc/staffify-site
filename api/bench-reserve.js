// POST /api/bench-reserve
// "Reserve interview" from the bench. This is the conversion event the whole
// browse experience exists to produce.
//
// Deliberately NOT a contact unlock. The buyer never receives the candidate's
// details from this endpoint — they get a scheduled conversation, and Staffify
// stays in the middle. That is the difference between this and OnlineJobs.ph,
// and it is the reason the placement fee survives.
//
// Drops into the same lead pool as /api/intake so reps work one queue.

import { redis, readBody, newToken } from './_auth.js';
import { slackNotify } from './_slack.js';
import { KEY, getProfileBySlug, isPubliclyVisible, clean, now } from './_bench.js';

const ALLOWED_ORIGINS = [
    'https://www.gostaffify.com',
    'https://gostaffify.com',
    'http://localhost:3000',
    'http://localhost:8899',
];

function cors(req, res) {
    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
}

const isEmail = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length < 254;

export default async function handler(req, res) {
    cors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    res.setHeader('Cache-Control', 'no-store');

    const b = readBody(req) || {};
    if (b.website) return res.status(200).json({ ok: true }); // honeypot

    const email = clean(b.email, 254).toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ error: 'valid_email_required' });

    const slug = clean(b.slug, 80);
    const profile = slug ? await getProfileBySlug(slug) : null;
    if (slug && (!profile || !isPubliclyVisible(profile))) {
        // Someone reserved a card that has since been taken. Say so plainly
        // rather than booking a call for a person who is no longer free.
        return res.status(409).json({ error: 'no_longer_available' });
    }

    const who = profile
        ? `${profile.first_name} · ${profile.headline || profile.role}`
        : 'No specific candidate';

    const reservation = {
        id: 'lead:' + Date.now() + ':' + newToken(4),
        name: clean(b.name, 120),
        email,
        phone: clean(b.phone, 40),
        company: clean(b.company, 160),
        source: 'bench-reserve',
        note: [
            `Bench: ${who}`,
            slug && `Profile: /bench/?p=${slug}`,
            b.role_need && `Hiring for: ${clean(b.role_need, 120)}`,
            b.timing && `Timing: ${clean(b.timing, 80)}`,
            b.notes && clean(b.notes, 600),
        ].filter(Boolean).join(' · '),
        status: 'new',
        owner: '',
        bench_slug: slug,
        created_at: String(now()),
    };

    try {
        await redis.hset(reservation.id, reservation);
        await redis.zadd('leads:by_date', { score: now(), member: reservation.id });
        await redis.zadd(KEY.reserves, { score: now(), member: reservation.id });
    } catch (e) {
        return res.status(500).json({ error: 'store_failed' });
    }

    slackNotify(
        `:seat: *Bench interview reserved* — *${reservation.company || reservation.name || email}*`
        + `\n:bust_in_silhouette: ${who}`
        + `\n:email: ${email}` + (reservation.phone ? `  ·  :telephone_receiver: ${reservation.phone}` : '')
        + (b.timing ? `\n:hourglass: ${clean(b.timing, 80)}` : '')
        + `\n:mag: Claim it in the hub: https://www.gostaffify.com/campaigns/  (Leads)`
    );

    return res.status(200).json({ ok: true });
}
