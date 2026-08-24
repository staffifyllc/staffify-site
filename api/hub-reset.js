// Clears the hub's own lead state so a fresh batch from the lead-gen engine arrives with no history
// attached to it.
//
// GET  /api/hub-reset/?token=ADMIN_TOKEN            -> dry run, counts only, changes nothing
// POST /api/hub-reset/ {confirm:true}               -> actually clear
//
// The queue itself is NOT touched and cannot be: those leads live in the lead-gen engine and the hub
// only proxies them. This clears what the hub remembers about them.
//
// Consent data is deliberately not clearable here. Someone who replied STOP has withdrawn consent
// permanently, and a "start fresh" that quietly re-enabled texting them would be the single most
// damaging thing this endpoint could do.

import { adminAuthorized, currentRep, readBody, redis } from './_auth.js';

// Cleared: what the hub remembers about the previous batch.
const CLEARS = [
    { key: 'hotleads',    kind: 'zset-or-list', what: 'hot leads shown on the hub and dialer' },
    { key: 'hot:handled', kind: 'set',          what: 'markers for hot leads already worked' },
    { key: 'text:sent',   kind: 'hash',         what: 'record of which numbers were already texted' },
    { key: 'sent:mockup', kind: 'hash',         what: 'record of which leads were sent a mockup' },
    { key: 'sent:audit',  kind: 'hash',         what: 'record of which leads were sent an audit' },
    { key: 'bad:numbers', kind: 'set',          what: 'numbers previously marked as bad data' },
];

// Never cleared, listed so it is obvious what survives and why.
const PRESERVED = [
    { key: 'optout:numbers',   why: 'people who replied STOP. Clearing this would start texting them again.' },
    { key: 'optout:emails',    why: 'email opt-outs, same reason.' },
    { key: 'unsubscribed:set', why: 'one-click email unsubscribes.' },
    { key: 'optout:scan:seen', why: 'how far the STOP sweep has read, so it does not restart from zero.' },
    { key: 'reps',             why: 'who can sign in.' },
    { key: 'crm:owners',       why: 'rep to HubSpot owner mapping, needed for commission attribution.' },
];

async function sizeOf(key) {
    for (const fn of ['zcard', 'scard', 'hlen', 'llen']) {
        try {
            const n = await redis[fn](key);
            if (typeof n === 'number' && n >= 0) return n;
        } catch (e) { /* wrong type for this key, try the next */ }
    }
    try { return (await redis.get(key)) == null ? 0 : 1; } catch (e) { return null; }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    // A signed-in admin or a machine token. Deliberately NOT openIdentity: this one deletes.
    const rep = await currentRep(req).catch(() => null);
    if (!((rep && rep.role === 'admin') || adminAuthorized(req))) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    const counts = {};
    for (const c of CLEARS) counts[c.key] = { holds: await sizeOf(c.key), what: c.what };

    const preserved = {};
    for (const p of PRESERVED) preserved[p.key] = { holds: await sizeOf(p.key), why: p.why };

    if (req.method !== 'POST' || !readBody(req).confirm) {
        return res.status(200).json({
            dryRun: true,
            note: 'Nothing was changed. POST {"confirm":true} to clear.',
            wouldClear: counts,
            keptOnPurpose: preserved,
            notTouched: 'The dialer queue itself. Those leads live in the lead-gen engine, not here.',
        });
    }

    const cleared = {};
    for (const c of CLEARS) {
        try {
            await redis.del(c.key);
            cleared[c.key] = { ok: true, hadHeld: counts[c.key].holds };
        } catch (e) {
            cleared[c.key] = { ok: false, error: String((e && e.message) || e).slice(0, 160) };
        }
    }

    return res.status(200).json({
        dryRun: false,
        cleared,
        keptOnPurpose: preserved,
        note: 'Hub state cleared. The queue is unchanged: new leads come from the lead-gen engine.',
    });
}
