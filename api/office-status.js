// GET  /api/office-status              — return live status of all virtual employees
// POST /api/office-status               — internal: bump status for an agent (requires ADMIN_TOKEN)
//
// Each agent writes a JSON blob to Redis key `agent:status:<id>`:
//   { last_run_at, status, last_action, count_today, count_total, current_task, ... }
// The /office/ page polls this endpoint to render the team in real time.

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

// Static roster — avatars and roles. Live data merges in from Redis.
const ROSTER = [
    {
        id: 'email-marketing',
        name: 'Sofia',
        role: 'Email Marketing Specialist',
        team: 'Growth',
        avatar: '/assets/staff/email-marketing.jpg',
        responsibilities: 'Soft-yes drip · welcome emails · subscriber nurture',
        cron: 'Daily · 10:20am ET',
    },
    {
        id: 'post-call-nurture',
        name: 'Maya',
        role: 'Post-Call Nurture Lead',
        team: 'Sales Ops',
        avatar: '/assets/staff/post-call-nurture.jpg',
        responsibilities: 'Re-engages prospects after Not-a-fit dispositions',
        cron: 'Daily · 10:30am ET',
    },
    {
        id: 'disposition-coordinator',
        name: 'Jordan',
        role: 'Disposition Coordinator',
        team: 'Sales Ops',
        avatar: '/assets/staff/disposition-coordinator.jpg',
        responsibilities: 'Weekly Client/Not-a-fit triage emails to Paul',
        cron: 'Mondays · 10:00am ET',
    },
    {
        id: 'blog-publisher',
        name: 'Ash',
        role: 'Content Publisher',
        team: 'Content',
        avatar: '/assets/staff/blog-publisher.jpg',
        responsibilities: 'Generates and publishes a new blog post daily',
        cron: 'Daily · 10:00am ET (GitHub Actions)',
    },
    {
        id: 'calendly-webhook',
        name: 'Riley',
        role: 'Booking Triage',
        team: 'Sales Ops',
        avatar: '/assets/staff/calendly-webhook.jpg',
        responsibilities: 'Receives Calendly bookings, graduates from drip, logs disposition',
        cron: 'Real-time webhook',
    },
    {
        id: 'deploy-monitor',
        name: 'Quinn',
        role: 'Deploy Monitor',
        team: 'Engineering',
        avatar: '/assets/staff/deploy-monitor.jpg',
        responsibilities: 'Watches Vercel deploys, alerts on failure',
        cron: 'Real-time webhook',
    },
];

function describeStatus(s, cron) {
    if (!s || !s.last_run_at) {
        return { state: 'idle', label: 'Awaiting first run', minutes_since: null };
    }
    const minutes = Math.round((Date.now() - Number(s.last_run_at)) / 60000);
    // "Working" if last_run was within the last 90 seconds
    if (minutes < 2) return { state: 'working', label: 'Working now', minutes_since: minutes };
    // "On break" if expected next run hasn't fired yet but last run was recent
    if (minutes < 60 * 26) return { state: 'on-shift', label: `On shift · last ran ${formatAgo(minutes)} ago`, minutes_since: minutes };
    return { state: 'idle', label: `Idle · last ran ${formatAgo(minutes)} ago`, minutes_since: minutes };
}

function formatAgo(minutes) {
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.round(hours / 24);
    return `${days}d`;
}

async function readAllStatuses() {
    const out = [];
    for (const member of ROSTER) {
        try {
            const s = await redis.hgetall(`agent:status:${member.id}`);
            const status = describeStatus(s, member.cron);
            out.push({
                ...member,
                status,
                last_action: s?.last_action || null,
                count_today: Number(s?.count_today || 0),
                count_total: Number(s?.count_total || 0),
                last_run_at: s?.last_run_at ? Number(s.last_run_at) : null,
            });
        } catch {
            out.push({ ...member, status: { state: 'idle', label: 'No data', minutes_since: null } });
        }
    }
    return out;
}

function authorized(req) {
    const token = process.env.ADMIN_TOKEN;
    if (!token) return false;
    const header = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    return !!m && m[1] === token;
}

async function readRawBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');

    if (req.method === 'GET') {
        const team = await readAllStatuses();
        return res.status(200).json({ generated_at: new Date().toISOString(), team });
    }

    if (req.method === 'POST') {
        if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
        const raw = await readRawBody(req);
        let body;
        try { body = JSON.parse(raw); } catch { return res.status(400).json({ error: 'invalid_json' }); }
        const id = String(body.id || '').toLowerCase();
        if (!ROSTER.find(r => r.id === id)) return res.status(400).json({ error: 'unknown_agent' });
        const key = `agent:status:${id}`;
        const now = Date.now();
        // Get current to compute count_total
        const current = await redis.hgetall(key);
        const updates = {
            last_run_at: String(now),
            last_action: String(body.last_action || ''),
            count_today: String(Number(body.count_today || 0)),
            count_total: String((Number(current?.count_total || 0)) + Number(body.delta_count || body.count_today || 0)),
        };
        await redis.hset(key, updates);
        return res.status(200).json({ ok: true, id, updated: updates });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
}
