// GET  /api/hot-leads            -> { leads:[...newest first, still open] }
// POST /api/hot-leads {id, outcome}  -> logs outcome, removes from the hot queue
//   outcomes: won | callback | not_interested | no_answer | bad_number
// Auth: logged-in rep (session) or admin token.

import { requireAccess, redis, readBody } from './_auth.js';
import { slackNotify } from './_slack.js';

const OUTCOMES = ['won', 'callback', 'not_interested', 'no_answer', 'bad_number'];

export default async function handler(req, res) {
    const who = await requireAccess(req);
    if (!who) return res.status(401).json({ error: 'unauthorized' });
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'GET') {
        const ids = (await redis.zrange('hotleads', 0, 99, { rev: true })) || [];
        const leads = [];
        for (const id of ids) {
            const h = await redis.hgetall(id);
            if (h && h.phone && h.status !== 'done') leads.push(h);
        }
        return res.status(200).json({ count: leads.length, leads });
    }

    if (req.method === 'POST') {
        const b = readBody(req);
        const id = (b.id || '').toString();
        if (!id.startsWith('hot:')) return res.status(400).json({ error: 'bad_id' });
        if (!OUTCOMES.includes(b.outcome)) return res.status(400).json({ error: 'bad_outcome', outcomes: OUTCOMES });
        const h = await redis.hgetall(id);
        if (!h || !h.phone) return res.status(404).json({ error: 'no_such_lead' });
        await redis.hset(id, { status: 'done', outcome: b.outcome, closedBy: who.name || who.email, closedAt: String(Date.now()) });
        await redis.zrem('hotleads', id);
        if (b.outcome === 'won') slackNotify(`:tada: *${who.name || who.email}* CLOSED a hot lead: *${h.company || h.name || h.phone}*`);
        return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
}
