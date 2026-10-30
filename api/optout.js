// Do-not-contact management.
//   GET  /api/optout/                 -> { count, numbers, emails, recent }
//   GET  /api/optout/?check=+1555...  -> { optedOut: true|false }
//   GET  /api/optout/?scan=1          -> sweep Quo for inbound replies that say STOP and suppress them
//   POST /api/optout/ {phone,email,reason}       -> suppress by hand
//   POST /api/optout/ {phone, restore:true}      -> undo, if someone was suppressed in error
//
// The scan exists because opt-outs arrive as ordinary inbound texts. Carriers stop the SMS at their
// end, but nothing stops us CALLING them tomorrow, which is the part that gets a company in trouble.

import { adminAuthorized, currentRep, readBody, redis } from './_auth.js';
import { optOut, optOutEverywhere, isOptedOut, optOutList, looksLikeOptOut, last10 } from './_optout.js';
import { listMessages, quoConfigured } from './_quo.js';
import { requestStop } from './_outreach-stops.js';
import { stopHiringCards } from './_hiring-calls.js';

// How far back the first sweep looks, and the watermark it keeps afterwards. A date is a far
// better bookmark than a per-thread "have I read this" map: it cannot drift, and widening it is one
// query parameter rather than a cache to clear.
const WATERMARK = 'optout:scan:since';
const FIRST_RUN_DAYS = Number(process.env.OPTOUT_SCAN_BACKFILL_DAYS || 45);

/**
 * Sweep Quo for inbound texts that say STOP and suppress the sender everywhere.
 *
 * Rewritten 2026-10-22. The previous version walked conversations on the legacy /v1/messages
 * route, which requires a phoneNumberId AND one participant per request. It read 81 threads, found
 * ZERO incoming messages on an inbox that plainly contained an inbound "Stop", and returned
 * ok: true with an empty list. A compliance sweep that cannot see inbound mail reporting "nothing
 * to do" is worse than one that is switched off, because it looks like it is working.
 *
 * The 2026-03-30 route takes direction=incoming and a createdAt range directly, so there is nothing
 * to walk. If it cannot be read, this says so instead of returning an empty result.
 */
export async function scanOpenPhone(limit, debug) {
    const started = Date.now();
    if (!quoConfigured()) return { ok: false, reason: 'quo_not_configured' };

    let since = null;
    try { since = await redis.get(WATERMARK); } catch { since = null; }
    if (!since) since = new Date(Date.now() - FIRST_RUN_DAYS * 86400000).toISOString();
    // Overlap by an hour so a message that landed mid-sweep is never stranded between runs.
    const windowFrom = new Date(Date.parse(since) - 3600000).toISOString();

    let items = [], complete = true;
    try {
        ({ items, complete } = await listMessages({ direction: 'incoming', after: windowFrom }));
    } catch (e) {
        // Loud. A failed sweep must never read as "nobody opted out".
        return { ok: false, reason: 'quo_read_failed', detail: String((e && e.message) || e).slice(0, 200), scannedFrom: windowFrom };
    }

    const diag = { messages: items.length, incoming: items.length, samples: [], from: windowFrom };
    const found = [];
    for (const m of items) {
        const body = m.text || m.body || '';
        if (diag.samples.length < 8) diag.samples.push({ text: String(body).slice(0, 40), from: m.from || '', at: m.createdAt || '' });
        if (!looksLikeOptOut(body)) continue;
        found.push({ phone: m.from || '', text: String(body).slice(0, 120), at: m.createdAt || '' });
        if (limit && found.length >= limit) break;
    }

    const added = [], failed = [];
    for (const f of found) {
        if (!f.phone) continue;
        const already = await isOptedOut({ phone: f.phone });
        const r = await optOutEverywhere({ phone: f.phone, reason: 'replied stop', source: 'quo scan', text: f.text });
        if (!r.ok) { failed.push({ phone: f.phone, reason: r.reason }); continue; }
        // Off the call list too: the Hiring now card that rings this number (api/_hiring-calls.js).
        await stopHiringCards(redis, { phone: f.phone }, { why: 'Replied STOP to a text', by: 'quo scan' }).catch(() => {});
        if (!already) added.push({ phone: r.phone, text: f.text, at: f.at });
    }

    // Only move the watermark when the window was read in full and every suppression landed.
    // Moving it past a message we failed to act on would lose that opt-out for good.
    if (complete && !failed.length) {
        try { await redis.set(WATERMARK, new Date(started).toISOString()); } catch { /* re-reads next run */ }
    }

    return {
        ok: true,
        scannedFrom: windowFrom,
        messagesRead: items.length,
        optOutsFound: found.length,
        added,
        ...(failed.length ? { failed, note: 'Some suppressions did not store. The watermark was held back so the next run retries them.' } : {}),
        incomplete: !complete,
        ...(complete ? {} : { note: 'Page ceiling reached before the window was finished. Run again.' }),
        ...(debug ? { diag } : {}),
    };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const who = await currentRep(req).catch(() => null);
    const isAdmin = adminAuthorized(req) || (who && who.role === 'admin');

    if (req.method === 'POST') {
        if (!isAdmin) return res.status(401).json({ error: 'unauthorized' });
        const b = readBody(req);
        if (b.restore) {
            const d = last10(b.phone);
            if (d) await redis.srem('optout:numbers', d);
            if (b.email) await redis.srem('optout:emails', String(b.email).toLowerCase());
            return res.status(200).json({ ok: true, restored: d || b.email });
        }
        const r = await optOutEverywhere({ phone: b.phone, email: b.email, reason: b.reason || 'manual', source: 'manual' });
        if (r.ok) {
            // Every email-queue row for the address, and the Hiring now card, stop too (api/_outreach-stops.js).
            if (b.email) await requestStop(redis, { email: b.email, by: 'manual', why: b.reason || 'manual' }).catch(() => {});
            await stopHiringCards(redis, { email: b.email || null, phone: b.email ? null : b.phone || null }, { why: b.reason || 'Opted out', by: 'manual' }).catch(() => {});
        }
        return res.status(r.ok ? 200 : 400).json(r);
    }

    if (req.query.check) {
        return res.status(200).json({ optedOut: await isOptedOut({ phone: req.query.check, email: req.query.check }) });
    }

    if (req.query.scan) {
        if (!isAdmin) return res.status(401).json({ error: 'unauthorized' });
        return res.status(200).json(await scanOpenPhone(Number(req.query.limit) || 0, !!req.query.debug));
    }

    if (!isAdmin) return res.status(401).json({ error: 'unauthorized' });
    const list = await optOutList();
    return res.status(200).json({ count: list.numbers.length + list.emails.length, ...list });
}
