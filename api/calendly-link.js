// GET /api/calendly-link/  -> { ok, events:[{name, url, duration}] }
// The rep's bookable meeting types, straight from Calendly, so the dialer can offer a real
// scheduling link instead of a hardcoded one that rots. Cached briefly: event types rarely change.
//
// Env: CALENDLY_API_TOKEN (already set), optional CALENDLY_SALES_LINK to pin one link.

import { redis } from './_auth.js';

const CACHE_KEY = 'calendly:eventtypes';
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
            // Shortest first: a rep booking off a cold call wants the 15 minute one, not the 2 hour one.
            .sort((a, b) => (a.duration || 999) - (b.duration || 999));

        const payload = { ok: true, events };
        try { await redis.set(CACHE_KEY, JSON.stringify(payload), { ex: CACHE_TTL }); } catch (e) { /* ignore */ }
        return res.status(200).json(payload);
    } catch (e) {
        return res.status(200).json({ ok: false, reason: 'error', detail: String((e && e.message) || e).slice(0, 160), events: [] });
    }
}
