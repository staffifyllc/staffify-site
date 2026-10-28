// Booked leads: the sweep that takes anyone who booked a call off the lists, and its log.
// ------------------------------------------------------------------
//   GET  (cron, Bearer CRON_SECRET)   one sweep of Calendly's meetings (api/_booked-leads.js)
//   GET  ?view=log (owner)            the last removals: who, when, which records
// The webhook (api/calendly-webhook.js) does the same the moment someone books; this is the backstop
// for a webhook that never arrives, and it catches bookings made before either existed.
import { redis, requireAccess, adminAuthorized } from './_auth.js';
import { ownerFor } from './_outreach-queue.js';
import { calendlyConfigured, whoAmI, pastEvents, invitees } from './_calendly.js';
import { sweepBookings, LOG } from './_booked-leads.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const machine = adminAuthorized(req);
        if (req.query?.view === 'log') {
            if (!machine) { const rep = await requireAccess(req); if (!ownerFor(rep)) return res.status(403).json({ error: 'Owners only' }); }
            const rows = (await redis.lrange(LOG, 0, 49)) || [];
            return res.status(200).json({ removals: rows.map(x => (typeof x === 'string' ? JSON.parse(x) : x)) });
        }
        if (!machine) return res.status(401).json({ error: 'Unauthorized' });
        if (!calendlyConfigured()) return res.status(200).json({ status: 'skipped', reason: 'CALENDLY_API_TOKEN is not set' });
        const out = await sweepBookings(redis, { whoAmI, events: pastEvents, invitees });
        return res.status(200).json({ status: 'complete', ...out });
    } catch (e) {
        return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
    }
}
