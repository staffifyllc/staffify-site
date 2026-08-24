// Proxy to the lead-gen sales portal so the token stays server-side and there is no CORS.
// GET  /api/call-queue?action=list[&n=25]  -> { date, websites:[...], staffing:[...], total }
// GET  /api/call-queue?action=training      -> per-motion call scripts
// GET  /api/call-queue?action=scoreboard    -> dials / answers / interested
// POST /api/call-queue?action=log    { id, outcome, motion } -> logs it and takes the lead out of
//      EVERY rep's queue, not just the caller's browser.
// POST /api/call-queue?action=claim  { id }                  -> holds a lead briefly while a rep has
//      it open, so two reps are never handed the same prospect at once.
// Auth: logged-in rep (session) or admin token. Env: SALES_PORTAL_BASE, SALES_PORTAL_TOKEN.

import { openIdentity, readBody } from './_auth.js';
import { optedOutSet, last10 } from './_optout.js';
import { redis } from './_auth.js';

// A lead someone has already worked. The queue is shared, so without this a lead a rep dispositioned
// stays in every other rep's list and the prospect gets called a second time by someone else. Logging
// an outcome only removed it from that one browser's copy, and a reload brought it straight back.
const WORKED = 'queue:worked';
// The hub's warm-lead list and the dialer queue are two views of the same prospects, and each kept
// its own idea of "already worked": the queue by lead id, the hub by phone. So a lead Madison
// dispositioned in the dialer stayed on Paul's dashboard and the prospect got called twice. The phone
// number is the one identifier both sides share, so it is the one that decides.
const HANDLED = 'hot:handled';
const digits10 = (p) => String(p || '').replace(/[^0-9]/g, '').slice(-10);
// A lead currently on someone's screen. The queue is shared and every rep starts at the top, so
// without this Paul and Madison dial the same prospect within seconds of each other. Short lived on
// purpose: a rep who closes their laptop should not hold a lead hostage, so the claim simply expires
// and the lead comes back to the pool.
const CLAIM = (id) => `queue:claim:${id}`;
const CLAIM_TTL = Number(process.env.QUEUE_CLAIM_TTL || 900);   // 15 minutes

async function claimsHeldByOthers(me) {
    try {
        const keys = await redis.keys('queue:claim:*');
        if (!keys || !keys.length) return new Set();
        const vals = await Promise.all(keys.map(k => redis.get(k).catch(() => null)));
        const out = new Set();
        keys.forEach((k, i) => {
            const holder = String(vals[i] || '');
            // A rep always keeps sight of their own claim, or refreshing would lose their place.
            if (holder && holder !== me) out.add(k.replace('queue:claim:', ''));
        });
        return out;
    } catch (e) { return new Set(); }
}

async function workedIds() {
    try { return new Set(Object.keys((await redis.hgetall(WORKED)) || {})); }
    catch (e) { return new Set(); }   // never block the queue on this
}

// Everything worked on either surface, keyed by phone so both agree.
async function handledPhones() {
    try {
        const raw = (await redis.smembers(HANDLED)) || [];
        return new Set(raw.map(digits10).filter(Boolean));
    } catch (e) { return new Set(); }
}

const BASE = process.env.SALES_PORTAL_BASE;
const TOKEN = process.env.SALES_PORTAL_TOKEN;
const OUTCOMES = ['interested', 'callback', 'not_interested', 'gatekeeper', 'no_answer', 'voicemail', 'bad_number'];

export default async function handler(req, res) {
    const who = await openIdentity(req); // open-share: identify by name if given, else Guest
    if (!BASE || !TOKEN) return res.status(500).json({ error: 'portal_not_configured' });
    res.setHeader('Cache-Control', 'no-store');

    const action = (req.query.action || 'list').toString();

    try {
        // A rep opened this lead. Held briefly so nobody else is handed the same prospect.
        if (req.method === 'POST' && action === 'claim') {
            const b = readBody(req);
            if (!b.id) return res.status(400).json({ error: 'id_required' });
            const me = ((who && who.email) || 'guest').toString();
            try {
                await redis.set(CLAIM(b.id), me, { ex: CLAIM_TTL });
                return res.status(200).json({ ok: true, heldFor: CLAIM_TTL });
            } catch (e) {
                return res.status(200).json({ ok: false, reason: 'claim_store_failed' });
            }
        }

        if (req.method === 'POST' && action === 'log') {
            const b = readBody(req);
            if (!b.id) return res.status(400).json({ error: 'id_required' });
            if (!OUTCOMES.includes(b.outcome)) return res.status(400).json({ error: 'bad_outcome', outcomes: OUTCOMES });
            // Recorded before the upstream call so a slow or failing engine cannot leave a worked lead
            // sitting in everyone else's queue.
            try {
                await redis.hset(WORKED, {
                    [String(b.id)]: JSON.stringify({
                        at: Date.now(), outcome: b.outcome,
                        rep: (b.rep || (who && who.name) || '').toString().slice(0, 80),
                    }),
                });
                // Also record it by phone. Without this the hub's warm-lead list, which keys off the
                // phone, keeps showing a prospect the dialer already worked.
                const d = digits10(b.phone);
                if (d) await redis.sadd(HANDLED, d);
                await redis.del(CLAIM(b.id));
            } catch (e) { /* non-fatal: the log itself still goes through */ }

            const r = await fetch(`${BASE}?action=log&t=${encodeURIComponent(TOKEN)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: b.id, outcome: b.outcome, motion: b.motion || '', rep: who.name || who.email }),
            });
            const j = await r.json().catch(() => ({}));
            return res.status(r.status).json(j);
        }

        // Rep data-quality verdict on the lead in front of them (Paul 2026-08-12).
        // Passthrough only: the portal owns the archive list, so a lead a rep kills here
        // is dead on every surface, not just this one.
        if (req.method === 'POST' && action === 'feedback') {
            const b = readBody(req);
            const r = await fetch(`${BASE}?action=feedback&t=${encodeURIComponent(TOKEN)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...b, rep: b.rep || who.name || who.email }),
            });
            const j = await r.json().catch(() => ({}));
            return res.status(r.status).json(j);
        }

        if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

        const n = req.query.n ? `&n=${encodeURIComponent(req.query.n)}` : '';
        const r = await fetch(`${BASE}?action=${encodeURIComponent(action)}&t=${encodeURIComponent(TOKEN)}${n}`);
        const j = await r.json().catch(() => ({}));

        // Someone who said STOP withdrew consent for every channel, not just texting, so they are
        // stripped out of the call lists before a rep ever sees them. Filtering here rather than in
        // the browser means it holds even if the page is stale or the engine serves them again.
        if (action === 'list' && j && (j.websites || j.staffing)) {
            try {
                const me = ((who && who.email) || 'guest').toString();
                const [{ numbers }, worked, handled, claimed] = await Promise.all([
                    optedOutSet(), workedIds(), handledPhones(), claimsHeldByOthers(me),
                ]);
                let removed = 0, alreadyWorked = 0, withAnotherRep = 0;
                for (const k of ['websites', 'staffing']) {
                    if (!Array.isArray(j[k])) continue;
                    const before = j[k].length;
                    j[k] = j[k].filter(l => !numbers.has(last10(l && l.phone)));
                    removed += before - j[k].length;

                    const mid = j[k].length;
                    j[k] = j[k].filter(l => !worked.has(String(l && l.id)) && !handled.has(digits10(l && l.phone)));
                    alreadyWorked += mid - j[k].length;

                    const afterWorked = j[k].length;
                    j[k] = j[k].filter(l => !claimed.has(String(l && l.id)));
                    withAnotherRep += afterWorked - j[k].length;
                }
                if (removed) j.suppressed = removed;
                if (alreadyWorked) j.alreadyWorked = alreadyWorked;
                if (withAnotherRep) j.withAnotherRep = withAnotherRep;
            } catch (e) { /* never block the queue on the consent check */ }
        }
        return res.status(r.status).json(j);
    } catch (e) {
        return res.status(502).json({ error: 'portal_error', detail: String(e.message || e) });
    }
}
