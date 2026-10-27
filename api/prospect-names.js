// GET /api/prospect-names/  ->  { names: { <recordId>: "First Last" }, complete, why, at }
// ------------------------------------------------------------------
// Paul, 2026-10-27: "make it so we can search by name, company or phone number, any combo of those
// even just first names". A prospect card carries a first name on only 89 of 870 records; the names
// are in HubSpot (829 carry a contact id). This reads them in batches, keeps them for six hours, and
// hands the dialer one map so name search is instant and works with company and number words.
// Read-only: nothing is written to HubSpot.
import { redis, requireAccess } from './_auth.js';
import { KEY, visibleState, canUseCallQueue } from './_outreach-queue.js';
import { readContactNames } from './_hubspot.js';

export const NAMES_KEY = 'staffify:prospect-names:v1';
const FRESH_MS = 6 * 3600e3;
export const contactIdOf = r => String((r && ((r.callContact && r.callContact.crmContactId) || r.hubspotId || r.crmContactId)) || '') || null;

/** The map for these records, reading only what the cache lacks (or everything once it is stale). */
export async function namesFor(records, { kv = redis, read = readContactNames, now = Date.now() } = {}) {
    const cached = await kv.get(NAMES_KEY).catch(() => null);
    const fresh = cached && cached.at && now - Date.parse(cached.at) < FRESH_MS;
    const byContact = { ...((fresh && cached.byContact) || {}) };
    const ids = [...new Set(records.map(contactIdOf).filter(Boolean))];
    const missing = ids.filter(id => !(id in byContact));
    let complete = true, why = null;
    if (missing.length) {
        const r = await read(missing);
        Object.assign(byContact, r.names || {});
        complete = r.ok; why = r.why || null;
        // Only a complete read restarts the six hours; a partial one is retried on the next open.
        await kv.set(NAMES_KEY, { at: fresh ? cached.at : r.ok ? new Date(now).toISOString() : new Date(now - FRESH_MS + 600e3).toISOString(), byContact }, { ex: 24 * 3600 }).catch(() => {});
    }
    const names = {};
    for (const r of records) {
        const c = byContact[contactIdOf(r)];
        const full = c ? [c.first, c.last].filter(Boolean).join(' ') : '';
        if (full) names[r.id] = full;
    }
    return { names, complete, why, at: new Date(now).toISOString() };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
        const rep = await requireAccess(req);
        if (!rep || !canUseCallQueue(rep)) return res.status(401).json({ error: 'Sign in to the Hub' });
        const records = visibleState(await redis.get(KEY), 'all').records;
        return res.status(200).json(await namesFor(records));
    } catch (e) {
        return res.status(503).json({ error: 'Names could not be read: ' + String((e && e.message) || e).slice(0, 140) });
    }
}
