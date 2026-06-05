// GET /api/office-status
// Returns the latest run timestamp + counters for any Staffify cron agent
// that writes to Redis under `agent:status:<id>`. Paul's local Virtual
// Office (~/Desktop/Claude Code/virtual-office/server.js) polls this to
// mark remote agents as "running" when they've fired recently.
//
// Response shape:
//   { generated_at, agents: { "<id>": { last_run_at, last_action, count_today, count_total } } }
//
// Public read-only (no PII, just counters + timestamps). 60s edge cache.

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

// IDs that match Paul's virtual-office roster.json keys.
// Add more here as additional crons write status hooks.
const KNOWN_AGENT_IDS = [
    'staffify-softyes-drip',
    // Future:
    // 'staffify-post-call-nurture',
    // 'staffify-disposition',
    // 'staffify-calendly-webhook',
    // 'staffify-deploy-monitor',
    // 'staffify-blog-publisher',
];

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');

    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    try {
        const agents = {};
        await Promise.all(KNOWN_AGENT_IDS.map(async id => {
            const s = await redis.hgetall(`agent:status:${id}`);
            if (!s || !s.last_run_at) return;
            agents[id] = {
                last_run_at: Number(s.last_run_at),
                last_action: String(s.last_action || ''),
                count_today: Number(s.count_today || 0),
                count_total: Number(s.count_total || 0),
            };
        }));

        return res.status(200).json({
            generated_at: Date.now(),
            agents,
        });
    } catch (err) {
        return res.status(500).json({ error: 'server_error', detail: String(err.message || err) });
    }
}
