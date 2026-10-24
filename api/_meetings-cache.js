// Meetings by prospect email, with their dates, cached for an hour.
// ------------------------------------------------------------------
// The opener table used to borrow the lost-deals cache, which by design leaves out the last 14
// days and carries no dates, so a meeting could be credited to an opener sent after it. This reads
// Calendly directly over a long window, keeps the earliest start per invitee, and lets the
// attribution credit a meeting only when it was booked after the opener went out. A failed read
// returns null, and the table shows the column as unknown rather than zero.
import { calendlyConfigured, whoAmI, pastEvents, invitees } from './_calendly.js';

export const MEETINGS_KEY = 'staffify:meetings:by-email:v1';
const LOOKBACK_DAYS = 150, AHEAD_DAYS = 90, TTL = 3600;

/** @returns {Map<string,string>|null} email -> earliest ISO start, or null when unknown */
export async function meetingsByEmail(redis, { now = Date.now(), force = false } = {}) {
    try {
        if (!force) { const c = await redis.get(MEETINGS_KEY); if (c && c.byEmail && typeof c.byEmail === 'object') return new Map(Object.entries(c.byEmail)); }
    } catch { /* fall through to a live read */ }
    if (!calendlyConfigured()) return null;
    try {
        const me = await whoAmI();
        const scope = me && me.organization ? { organization: me.organization } : me && me.uri ? { user: me.uri } : null;
        if (!scope) return null;
        const { items, complete } = await pastEvents({ since: new Date(now - LOOKBACK_DAYS * 86400000).toISOString(), until: new Date(now + AHEAD_DAYS * 86400000).toISOString(), ...scope, maxPages: 30 });
        const byEmail = {};
        for (const ev of items || []) {
            let people = []; try { people = await invitees(ev.uri); } catch { continue; }
            for (const p of people) { if (!p.email) continue; const prior = byEmail[p.email]; if (!prior || ev.start_time < prior) byEmail[p.email] = ev.start_time; }
        }
        try { await redis.set(MEETINGS_KEY, { byEmail, complete: complete !== false, builtAt: new Date(now).toISOString() }, { ex: TTL }); } catch { /* still answer */ }
        return new Map(Object.entries(byEmail));
    } catch { return null; }
}
