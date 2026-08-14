// Map reps to HubSpot owners, which is what makes commission attribution work.
//
// GET  /api/crm-owners/?token=ADMIN   -> { owners:[{id,email,name}], map:{repName:ownerId}, reps:[...] }
// POST /api/crm-owners/?token=ADMIN   { rep:"Madison", ownerId:"123" }  -> saves the mapping
// POST with {auto:true}               -> matches every rep to an owner by email, and reports what it did
//
// The deal a rep's call creates is owned by whoever this map says, and the commission engine pays the
// deal owner. An unmapped rep means an unowned deal, which pays nobody.

import { adminAuthorized, currentRep, listReps, readBody, redis } from './_auth.js';

const KEY = 'crm:owners';

async function hsOwners() {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) return { ok: false, reason: 'no_token', owners: [] };
    try {
        const r = await fetch('https://api.hubapi.com/crm/v3/owners?limit=200', {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return { ok: false, reason: 'hubspot_' + r.status, detail: (await r.text().catch(() => '')).slice(0, 160), owners: [] };
        const j = await r.json();
        return { ok: true, owners: (j.results || []).map(o => ({
            id: String(o.id),
            email: (o.email || '').toLowerCase(),
            name: [o.firstName, o.lastName].filter(Boolean).join(' ').trim() || o.email || String(o.id),
        })) };
    } catch (e) { return { ok: false, reason: 'error', detail: String((e && e.message) || e).slice(0, 160), owners: [] }; }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const who = await currentRep(req).catch(() => null);
    if (!adminAuthorized(req) && !(who && who.role === 'admin')) return res.status(401).json({ error: 'unauthorized' });

    const map = (await redis.hgetall(KEY)) || {};

    if (req.method === 'POST') {
        const b = readBody(req);
        if (b.auto) {
            // Match each registered rep to a HubSpot owner with the same email. Exact matches only:
            // guessing by name would silently pay the wrong person.
            const [o, reps] = await Promise.all([hsOwners(), listReps()]);
            if (!o.ok) return res.status(200).json({ ok: false, ...o });
            const byEmail = {}; o.owners.forEach(x => { if (x.email) byEmail[x.email] = x; });
            const done = [], missed = [];
            for (const r of reps) {
                const hit = byEmail[(r.email || '').toLowerCase()];
                if (hit) {
                    await redis.hset(KEY, { [String(r.name || '').toLowerCase()]: hit.id });
                    const first = String(r.name || '').trim().split(/\s+/)[0].toLowerCase();
                    if (first) await redis.hset(KEY, { [first]: hit.id });
                    done.push({ rep: r.name, email: r.email, ownerId: hit.id });
                } else missed.push({ rep: r.name, email: r.email });
            }
            return res.status(200).json({ ok: true, mapped: done, unmatched: missed, owners: o.owners });
        }
        const rep = String(b.rep || '').trim().toLowerCase();
        const ownerId = String(b.ownerId || '').trim();
        if (!rep) return res.status(400).json({ error: 'bad_rep' });
        if (!ownerId) { await redis.hdel(KEY, rep); return res.status(200).json({ ok: true, cleared: rep }); }
        await redis.hset(KEY, { [rep]: ownerId });
        return res.status(200).json({ ok: true, saved: { rep, ownerId } });
    }

    const [o, reps] = await Promise.all([hsOwners(), listReps().catch(() => [])]);
    return res.status(200).json({
        ok: o.ok, reason: o.reason, detail: o.detail,
        owners: o.owners, map,
        reps: reps.map(r => ({ name: r.name, email: r.email, mappedTo: map[String(r.name || '').toLowerCase()] || null })),
    });
}
