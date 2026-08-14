// GET /api/calendly-link/  -> { ok, events:[{name, url, duration}] }
// The rep's bookable meeting types, straight from Calendly, so the dialer can offer a real
// scheduling link instead of a hardcoded one that rots. Cached briefly: event types rarely change.
//
// Env: CALENDLY_API_TOKEN (already set), optional CALENDLY_SALES_LINK to pin one link.

import { redis } from './_auth.js';

const CACHE_KEY = 'calendly:eventtypes:v2';
const CACHE_TTL = 3600;

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    const pinned = process.env.CALENDLY_SALES_LINK;
    if (pinned) return res.status(200).json({ ok: true, events: [{ name: 'Book a call', url: pinned, duration: null }], pinned: true });

    const token = process.env.CALENDLY_API_TOKEN;
    if (!token) return res.status(200).json({ ok: false, reason: 'not_configured', events: [] });

    try {
        const cached = await redis.get(CACHE_KEY);
        if (cached) return res.status(200).json(typeof cached === 'string' ? JSON.parse(cached) : cached);
    } catch (e) { /* cache is optional */ }

    const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    try {
        const me = await fetch('https://api.calendly.com/users/me', { headers: h });
        if (!me.ok) return res.status(200).json({ ok: false, reason: 'calendly_' + me.status, events: [] });
        const uri = (await me.json()).resource.uri;

        const r = await fetch(`https://api.calendly.com/event_types?user=${encodeURIComponent(uri)}&active=true&count=25`, { headers: h });
        if (!r.ok) return res.status(200).json({ ok: false, reason: 'event_types_' + r.status, events: [] });
        const j = await r.json();
        const events = (j.collection || [])
            .filter(e => e.scheduling_url)
            .map(e => ({ name: e.name || 'Call', url: e.scheduling_url, duration: e.duration || null }))
            // Rank for the job: a rep booking off a COLD call wants a discovery/leads call, not a client
            // follow-up, an interview or a 2 hour strategy session. Then prefer the shorter meeting.
            .map(e => {
                const n = (e.name || '').toLowerCase();
                let rank = 2;
                if (/discovery|lead|intro|prospect/.test(n)) rank = 0;
                if (/follow.?up|client|onboard|interview|1 on 1|strategy/.test(n)) rank = 3;
                return { ...e, rank };
            })
            .sort((a, b) => (a.rank - b.rank) || ((a.duration || 999) - (b.duration || 999)))
            .map(({ rank, ...e }) => e);

        const payload = { ok: true, events };
        try { await redis.set(CACHE_KEY, JSON.stringify(payload), { ex: CACHE_TTL }); } catch (e) { /* ignore */ }
        return res.status(200).json(payload);
    } catch (e) {
        return res.status(200).json({ ok: false, reason: 'error', detail: String((e && e.message) || e).slice(0, 160), events: [] });
    }
}
