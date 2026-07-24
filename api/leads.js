// Free-agent lead pool for the sales hub.
// GET  /api/leads                      -> { pool:[unclaimed], mine:[claimed by me], stats }
// POST /api/leads {action:'claim',  id}   -> claim a free agent (atomic; 409 if already taken)
// POST /api/leads {action:'release',id}   -> release one you own back to the pool
// POST /api/leads {action:'status', id, status}  -> new|contacted|qualified|won|lost
// Auth: logged-in rep (session) or admin token.

import { requireAccess, redis, readBody } from './_auth.js';
import { slackNotify } from './_slack.js';

const STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost'];

function shape(id, h) {
    return {
        id,
        name: h.name || '',
        email: h.email || '',
        phone: h.phone || '',
        company: h.company || '',
        source: h.source || '',
        note: h.note || h.intent || '',
        status: h.status || 'new',
        owner: h.owner || '',
        createdAt: Number(h.created_at || h.createdAt || 0),
        claimedAt: Number(h.claimed_at || 0),
    };
}

async function hydrate(ids) {
    const out = [];
    for (const id of ids) {
        const h = await redis.hgetall(id);
        if (h && (h.email || h.name)) out.push(shape(id, h));
    }
    return out;
}

export default async function handler(req, res) {
    const who = await requireAccess(req);
    if (!who) return res.status(401).json({ error: 'unauthorized' });
    res.setHeader('Cache-Control', 'no-store');
    const me = who.email;
    const isAdmin = who.role === 'admin';

    if (req.method === 'GET') {
        const ids = (await redis.zrange('leads:by_date', 0, 199, { rev: true })) || [];
        const all = await hydrate(ids);
        const pool = all.filter(l => !l.owner && l.status !== 'won' && l.status !== 'lost');
        const mine = all.filter(l => l.owner === me);
        const stats = {
            total: all.length,
            free: pool.length,
            mine: mine.length,
            claimed: all.filter(l => l.owner).length,
        };
        const payload = { pool, mine, stats };
        if (isAdmin) payload.all = all;
        return res.status(200).json(payload);
    }

    if (req.method === 'POST') {
        const b = readBody(req);
        const id = (b.id || '').toString();
        if (!id.startsWith('lead:')) return res.status(400).json({ error: 'bad_id' });
        const exists = await redis.exists(id);
        if (!exists) return res.status(404).json({ error: 'no_such_lead' });

        if (b.action === 'claim') {
            // atomic claim: owner field is set only if not already present
            const got = await redis.hsetnx(id, 'owner', me);
            if (!got) {
                const cur = await redis.hget(id, 'owner');
                return res.status(409).json({ error: 'already_claimed', owner: cur });
            }
            await redis.hset(id, { claimed_at: String(Date.now()), status: 'new' });
            const h = await redis.hgetall(id);
            slackNotify(`:dart: *${who.name || me}* claimed a lead: *${h.name || h.email || id}*${h.company ? ' (' + h.company + ')' : ''}`);
            return res.status(200).json({ ok: true, lead: shape(id, h) });
        }

        if (b.action === 'release') {
            const cur = await redis.hget(id, 'owner');
            if (cur !== me && !isAdmin) return res.status(403).json({ error: 'not_yours' });
            await redis.hdel(id, 'owner', 'claimed_at');
            return res.status(200).json({ ok: true });
        }

        if (b.action === 'status') {
            const status = (b.status || '').toString();
            if (!STATUSES.includes(status)) return res.status(400).json({ error: 'bad_status' });
            const cur = await redis.hget(id, 'owner');
            if (cur !== me && !isAdmin) return res.status(403).json({ error: 'not_yours' });
            await redis.hset(id, { status });
            if (status === 'won') slackNotify(`:tada: *${who.name || me}* marked a lead WON: *${(await redis.hget(id, 'name')) || id}*`);
            return res.status(200).json({ ok: true });
        }

        return res.status(400).json({ error: 'bad_action' });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
}
