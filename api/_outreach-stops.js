// A "Not interested / stop" pressed outside the email worker reaches it here.
// ------------------------------------------------------------------
// Paul, 2026-10-30: "when my sales person, Madison or Milton, are inside of the hub and they are hitting not interested,
// that person is not getting removed from our system. They need to make sure they're not only being removed from our
// view, but removed from any automated contact as well."
//
// A Hiring now card is saved in its own store (api/_hiring-calls.js), so its press never touched the email queue: the
// person's Hiring now drip row, and any other campaign's row for the same address, stayed "sent" with follow-ups due.
// The press now leaves a request here; the worker applies it under its own lock on its next run (a minute at most).
// Every row for the person becomes suppressed and the address joins the queue's suppressions, which the worker's
// existing sync writes to the stop list and to the CRM as do not contact. Until then a draft or send is already refused:
// the card is suppressed and the address is on the stop list.
export const STOPS = 'staffify:outreach:stop-requests';
const norm = e => String(e || '').trim().toLowerCase();
const parse = v => { if (v && typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

export async function requestStop(kv, { email, hiringId = null, by = null, why = null, at = new Date().toISOString() }) {
    const e = norm(email);
    if (!e && !hiringId) return { ok: false, reason: 'nothing to stop' };
    await kv.rpush(STOPS, JSON.stringify({ email: e || null, hiringId: hiringId || null, by, why, at }));
    return { ok: true };
}

/** The oldest waiting requests, in order. The worker trims them with doneStops only after its save landed. */
export async function takeStops(kv, max = 50) {
    return ((await kv.lrange(STOPS, 0, max - 1)) || []).map(parse);
}
export async function doneStops(kv, n) { if (n > 0) await kv.ltrim(STOPS, n, -1); }

/**
 * Applies requests to the queue state in place (the caller holds the worker's lock and saves). A row is the person's
 * when it carries their address or is their card's own drip row. Returns how many rows changed and the addresses that
 * matched no row, whose CRM contact the worker still marks do not contact.
 */
export function applyStops(state, requests, now = Date.now()) {
    state.suppressions ||= [];
    let rows = 0;
    const unmatched = [];
    const at = new Date(now).toISOString();
    for (const q of requests) {
        if (!q || (!q.email && !q.hiringId)) continue;
        const email = norm(q.email);
        const hits = state.records.filter(r => (email && norm(r.recipient) === email) || (q.hiringId && r.hiringId === q.hiringId));
        for (const r of hits) {
            if (r.status !== 'suppressed') { r.status = 'suppressed'; r.stopped = { by: q.by || null, why: q.why || null, at: q.at || at }; rows++; }
            const to = norm(r.recipient);
            if (to && !state.suppressions.includes(to)) state.suppressions.push(to);
        }
        if (email && !state.suppressions.includes(email)) state.suppressions.push(email);
        if (email && !hits.length) unmatched.push(email);
    }
    return { rows, unmatched: [...new Set(unmatched)] };
}
