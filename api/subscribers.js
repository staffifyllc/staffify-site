// GET    /api/subscribers?token=YOUR_ADMIN_TOKEN&format=csv|json   — export the list
// DELETE /api/subscribers?token=YOUR_ADMIN_TOKEN&email=foo@bar.com — prune one
//
// Env vars required:
//   ADMIN_TOKEN              — long random string; pass as ?token=...
//   KV_REST_API_URL / KV_REST_API_TOKEN — auto-injected by Vercel Upstash integration

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

function toCSV(rows) {
    const cols = [
        'email', 'source', 'signed_up_at', 'last_seen_at',
        'playbook_sent_at', 'decision',
        'softyes_stage', 'softyes_enrolled_at', 'softyes_graduated_reason',
        'last_booking_at',
    ];
    const header = cols.join(',');
    const lines = rows.map(r =>
        cols.map(c => {
            const v = r[c] == null ? '' : String(r[c]);
            return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(',')
    );
    return [header, ...lines].join('\n');
}

function softyesStage(softyes) {
    if (!softyes || !softyes.enrolled_at) return '';
    if (softyes.graduated_at) return `graduated (${softyes.graduated_reason || 'unknown'})`;
    if (softyes.day45_sent_at) return 'completed (day 45 sent)';
    if (softyes.day21_sent_at) return 'day 21 sent';
    if (softyes.day12_sent_at) return 'day 12 sent';
    if (softyes.day6_sent_at) return 'day 6 sent';
    if (softyes.day2_sent_at) return 'day 2 sent';
    return 'enrolled (waiting day 2)';
}

function authorized(req) {
    const adminToken = process.env.ADMIN_TOKEN;
    const provided = (req.query.token || '').toString();
    return !!adminToken && !!provided && provided === adminToken;
}

export default async function handler(req, res) {
    if (!authorized(req)) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    if (req.method === 'DELETE') {
        const email = (req.query.email || '').toString().trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'email_required' });
        try {
            const existed = await redis.del(`subscriber:${email}`);
            await redis.zrem('subscribers:by_date', email);
            return res.status(200).json({ ok: true, deleted: !!existed });
        } catch (err) {
            console.error('delete error', err);
            return res.status(500).json({ error: 'server_error' });
        }
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const emails = await redis.zrange('subscribers:by_date', 0, -1);
        const rows = [];
        for (const email of emails) {
            const rec = await redis.hgetall(`subscriber:${email}`);
            if (!rec) continue;
            const softyes = await redis.hgetall(`softyes:${email}`);
            rec.softyes_stage = softyesStage(softyes);
            rec.softyes_enrolled_at = (softyes && softyes.enrolled_at) || '';
            rec.softyes_graduated_reason = (softyes && softyes.graduated_reason) || '';
            rows.push(rec);
        }

        const format = (req.query.format || 'json').toString().toLowerCase();
        if (format === 'csv') {
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="staffify-subscribers-${new Date().toISOString().slice(0,10)}.csv"`);
            return res.status(200).send(toCSV(rows));
        }
        return res.status(200).json({ count: rows.length, subscribers: rows });
    } catch (err) {
        console.error('subscribers error', err);
        return res.status(500).json({ error: 'server_error' });
    }
}
