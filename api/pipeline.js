// GET /api/pipeline/?status=upcoming|client-pending-payment|client-active|no-close
// Returns prospects in that pipeline bucket, ordered by call time (upcoming) or
// by most-recent-action (others). Requires Authorization: Bearer <ADMIN_TOKEN>.

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const STATUSES = ['upcoming', 'client-pending-payment', 'client-active', 'no-close'];

function authorized(req) {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken) return false;
    const header = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    const tokenFromHeader = m ? m[1] : null;
    const tokenFromQuery = (req.query.token || '').toString();
    const provided = tokenFromHeader || tokenFromQuery;
    return provided === adminToken;
}

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
    if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

    const status = (req.query.status || 'upcoming').toString();
    if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: 'bad_status', valid: STATUSES });
    }

    try {
        // Pull emails for this bucket in score order
        // For "upcoming", we want soonest calls first (ascending score)
        // For others, most-recent-action first (descending score)
        const reverse = status !== 'upcoming';
        const emails = reverse
            ? await redis.zrange(`pipeline:${status}`, 0, -1, { rev: true })
            : await redis.zrange(`pipeline:${status}`, 0, -1);

        const records = [];
        for (const email of emails) {
            const rec = await redis.hgetall(`subscriber:${email}`);
            if (rec) records.push(rec);
        }

        // Also return counts for all buckets so the UI can show tab badges
        const counts = {};
        for (const s of STATUSES) {
            counts[s] = await redis.zcard(`pipeline:${s}`);
        }

        return res.status(200).json({
            status,
            count: records.length,
            counts,
            prospects: records,
        });
    } catch (err) {
        console.error('pipeline list error', err);
        return res.status(500).json({ error: 'server_error' });
    }
}
