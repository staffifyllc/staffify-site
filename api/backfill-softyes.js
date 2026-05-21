// POST /api/backfill-softyes/
// One-shot enrollment of existing subscribers into the soft-yes nurture track.
// Skips anyone who: is already in softyes:active, is in nurture:active, has a
// decision recorded, or is currently in disposition:pending (booked a call).
//
// Auth: Authorization: Bearer <ADMIN_TOKEN>
//
// Query params:
//   dry=1      preview without enrolling (default behavior is dry-run for safety)
//   commit=1   actually enroll
//   stagger=N  spread enrollments over N days starting tomorrow (default 1 = all enrolled now)
//   limit=N    max accounts to process this run

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const DAY = 86400 * 1000;

function authorized(req) {
    const token = process.env.ADMIN_TOKEN;
    if (!token) return false;
    const header = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    return m && m[1] === token;
}

export default async function handler(req, res) {
    if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
    if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    const url = new URL(req.url, `https://${req.headers.host}`);
    const commit = url.searchParams.get('commit') === '1';
    const dry = !commit;
    const stagger = Math.max(1, Math.min(14, parseInt(url.searchParams.get('stagger') || '1', 10)));
    const limit = Math.max(1, parseInt(url.searchParams.get('limit') || '10000', 10));

    const now = Date.now();
    const result = {
        dry,
        scanned: 0,
        skipped_already_softyes: 0,
        skipped_in_postcall_nurture: 0,
        skipped_decision_set: 0,
        skipped_disposition_pending: 0,
        skipped_calendly_source: 0,
        enrolled: 0,
        sample: [],
    };

    try {
        // Get all subscriber emails from the by-date zset (most recent first)
        const emails = await redis.zrange('subscribers:by_date', 0, -1, { rev: true });
        const toProcess = emails.slice(0, limit);

        for (let i = 0; i < toProcess.length; i++) {
            const email = toProcess[i];
            result.scanned++;

            // Skip if already in softyes track
            const alreadyEnrolled = await redis.hget(`softyes:${email}`, 'enrolled_at');
            if (alreadyEnrolled) { result.skipped_already_softyes++; continue; }

            // Skip if in post-call nurture (they already had a call)
            const inPostCallNurture = await redis.hget(`nurture:${email}`, 'enrolled_at');
            if (inPostCallNurture) { result.skipped_in_postcall_nurture++; continue; }

            // Pull subscriber record
            const sub = await redis.hgetall(`subscriber:${email}`);
            if (!sub) continue;

            // Skip if decision already set (client or nope)
            if (sub.decision && String(sub.decision).length) { result.skipped_decision_set++; continue; }

            // Skip if currently in disposition queue
            const dispositionPending = await redis.zscore('disposition:pending', email);
            if (dispositionPending) { result.skipped_disposition_pending++; continue; }

            // Skip if their source indicates they came via calendly (not a soft-yes signup)
            const source = String(sub.source || '');
            if (source === 'discovery-call-booked' || source.startsWith('calendly')) {
                result.skipped_calendly_source++;
                continue;
            }

            // Stagger: distribute enrollments evenly across `stagger` days starting now
            const offsetMs = stagger > 1 ? Math.floor((i / toProcess.length) * stagger * DAY) : 0;
            const enrolledAt = now + offsetMs;

            if (!dry) {
                await redis.hset(`softyes:${email}`, {
                    email,
                    source: source || 'backfill',
                    enrolled_at: enrolledAt,
                    backfilled: 1,
                    backfilled_at: now,
                    day2_sent_at: '',
                    day6_sent_at: '',
                    day12_sent_at: '',
                    day21_sent_at: '',
                    day45_sent_at: '',
                });
                await redis.zadd('softyes:active', { score: enrolledAt, member: email });
            }

            result.enrolled++;
            if (result.sample.length < 20) result.sample.push({ email, source, enrolledAt });
        }

        return res.status(200).json({ ok: true, ts: now, ...result });
    } catch (err) {
        console.error('backfill-softyes fatal', err);
        return res.status(500).json({ error: 'server_error', detail: String(err.message || err) });
    }
}
