// Proxy to the lead-gen sales portal so the token stays server-side and there is no CORS.
// GET  /api/call-queue?action=list[&n=25]  -> { date, websites:[...], staffing:[...], total }
// GET  /api/call-queue?action=training      -> per-motion call scripts
// GET  /api/call-queue?action=scoreboard    -> dials / answers / interested
// POST /api/call-queue?action=log  { id, outcome, motion }  -> logs + removes the lead (dedup)
// Auth: logged-in rep (session) or admin token. Env: SALES_PORTAL_BASE, SALES_PORTAL_TOKEN.

import { openIdentity, readBody } from './_auth.js';

const BASE = process.env.SALES_PORTAL_BASE;
const TOKEN = process.env.SALES_PORTAL_TOKEN;
const OUTCOMES = ['interested', 'callback', 'not_interested', 'gatekeeper', 'no_answer', 'voicemail', 'bad_number'];

export default async function handler(req, res) {
    const who = await openIdentity(req); // open-share: identify by name if given, else Guest
    if (!BASE || !TOKEN) return res.status(500).json({ error: 'portal_not_configured' });
    res.setHeader('Cache-Control', 'no-store');

    const action = (req.query.action || 'list').toString();

    try {
        if (req.method === 'POST' && action === 'log') {
            const b = readBody(req);
            if (!b.id) return res.status(400).json({ error: 'id_required' });
            if (!OUTCOMES.includes(b.outcome)) return res.status(400).json({ error: 'bad_outcome', outcomes: OUTCOMES });
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
        return res.status(r.status).json(j);
    } catch (e) {
        return res.status(502).json({ error: 'portal_error', detail: String(e.message || e) });
    }
}
