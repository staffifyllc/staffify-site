// GET  /api/call-hold/                          { me, holds: { <recordId>: { by, name, kind, until } } }
// POST /api/call-hold/ { action:'hold', id, kind:'open'|'calling'|'called' }  -> { ok, hold } | { ok:false, heldBy }
// POST /api/call-hold/ { action:'release', id }
// ------------------------------------------------------------------
// Which cards other reps have open, are calling, or just called, so every dialer drops them within
// 30 seconds and two reps never dial the same person. See api/_call-holds.js.
import { redis, requireAccess, SITE, readBody } from './_auth.js';
import { canUseCallQueue } from './_outreach-queue.js';
import { takeHold, releaseHold, listHolds } from './_call-holds.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
        const rep = await requireAccess(req);
        if (!rep || !canUseCallQueue(rep)) return res.status(401).json({ error: 'Sign in to the Hub' });
        if (req.method === 'GET') return res.status(200).json({ me: String(rep.email || '').toLowerCase(), holds: await listHolds(redis) });
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (rep.email === 'admin') return res.status(403).json({ error: 'Sign in as yourself to hold a card' });
        if (req.headers.origin !== SITE) return res.status(403).json({ error: 'Invalid origin' });
        const body = readBody(req);
        const id = String(body.id || '');
        if (!/^[\w.:@-]{3,120}$/.test(id)) return res.status(400).json({ error: 'Which card?' });
        if (body.action === 'release') return res.status(200).json(await releaseHold(redis, id, rep));
        if (body.action === 'hold') {
            const kind = ['open', 'calling', 'called'].includes(body.kind) ? body.kind : 'open';
            return res.status(200).json(await takeHold(redis, id, rep, kind));
        }
        return res.status(400).json({ error: 'Unknown action' });
    } catch (e) {
        // A hold is coordination, not a gate: the dialer carries on when this cannot answer.
        return res.status(503).json({ error: 'Holds could not be read: ' + String((e && e.message) || e).slice(0, 120) });
    }
}
