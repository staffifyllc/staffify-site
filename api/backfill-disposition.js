// One-shot: backfill call_ends_at + disposition:pending for existing bookings
// that pre-date the new disposition logic. Will be removed in next commit.

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
    if ((req.query.token || '') !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    const emails = await redis.zrange('subscribers:by_date', 0, -1);
    const result = { scanned: 0, backfilled: [] };

    for (const email of emails) {
        result.scanned++;
        const sub = await redis.hgetall(`subscriber:${email}`);
        if (!sub) continue;
        if (sub.source !== 'discovery-call-booked') continue;
        if (sub.decision) continue; // already decided
        if (sub.call_ends_at) continue; // already backfilled
        if (!sub.next_call_at) continue;

        const startMs = new Date(sub.next_call_at).getTime();
        if (!startMs) continue;
        const callEndsAt = startMs + 30 * 60 * 1000;

        await redis.hset(`subscriber:${email}`, {
            call_ends_at: callEndsAt,
            disposition_pending: 1,
            disposition_prompted_at: '',
        });
        await redis.zadd('disposition:pending', { score: callEndsAt, member: email });

        result.backfilled.push({ email, call_ends_at: callEndsAt });
    }

    return res.status(200).json({ ok: true, ...result });
}
