// Sales Live: the owner control tower on /hub/. Proxies the lead-gen engine's one-request summary
// (campaign-dashboard /api/sales-live-summary) so SALES_PORTAL_TOKEN stays server-side.
//
// GET /api/sales-live/                 -> the whole summary (engine caches it for 60 seconds)
// GET /api/sales-live/?drill=<name>    -> the people behind one number (madison, substantive, humans,
//                                         hungup, positive, newImport, emails; &id= opens one email)
//
// Unlike the open read endpoints, this one needs a signed-in rep or an admin token: the drill lists
// carry prospect names and call notes, and /hub/ itself is behind sign-in.
import { requireAccess } from './_auth.js';

const ENGINE = 'https://campaign-dashboard-green.vercel.app/api/sales-live-summary';
const DRILLS = new Set(['madison', 'substantive', 'humans', 'hungup', 'positive', 'newImport', 'emails']);

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    const who = await requireAccess(req).catch(() => null);
    if (!who) return res.status(401).json({ ok: false, error: 'Sign in to see Sales Live' });
    const token = process.env.SALES_PORTAL_TOKEN || '';
    if (!token) return res.status(500).json({ ok: false, error: 'Sales Live is not connected to the engine (SALES_PORTAL_TOKEN missing)' });

    const p = new URLSearchParams({ t: token });
    const drill = (req.query.drill || '').toString();
    if (drill) {
        if (!DRILLS.has(drill)) return res.status(400).json({ ok: false, error: 'Unknown list' });
        p.set('drill', drill);
        const id = (req.query.id || '').toString();
        if (id && /^[0-9a-f-]{36}$/i.test(id)) p.set('id', id);
    }
    try {
        const r = await fetch(ENGINE + '?' + p.toString(), { signal: AbortSignal.timeout(55000) });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j) return res.status(502).json({ ok: false, error: (j && j.error) || `the engine answered ${r.status}` });
        return res.status(200).json(j);
    } catch (e) {
        return res.status(502).json({ ok: false, error: 'the engine did not answer' });
    }
}
