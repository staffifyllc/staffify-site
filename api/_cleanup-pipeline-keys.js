// One-shot cleanup. Deletes orphaned pipeline:* sorted sets.
// Auth: ?token=<ADMIN_TOKEN>. Will be removed in the next commit.

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const KEYS = [
    'pipeline:upcoming',
    'pipeline:client-pending-payment',
    'pipeline:client-active',
    'pipeline:no-close',
    'nurture:active',
];

export default async function handler(req, res) {
    if ((req.query.token || '') !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    const result = {};
    for (const k of KEYS) {
        const n = await redis.del(k);
        result[k] = n;
    }
    return res.status(200).json({ ok: true, deleted: result });
}
