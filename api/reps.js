// Admin-only rep management for the sales hub.
// GET    /api/reps?token=ADMIN_TOKEN                  -> list reps
// GET    /api/reps?token=ADMIN_TOKEN&invite=a@b.com   -> fresh one-time login link for that rep
// POST   /api/reps?token=ADMIN_TOKEN  {email,name,rate,role}
// DELETE /api/reps?token=ADMIN_TOKEN&email=a@b.com

import { adminAuthorized, createRep, listReps, getRep, createMagicLink, redis, normEmail, readBody } from './_auth.js';

export default async function handler(req, res) {
    if (!adminAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'GET') {
        const invite = normEmail(req.query.invite);
        if (invite) {
            const rep = await getRep(invite);
            if (!rep) return res.status(404).json({ error: 'no_such_rep' });
            const link = await createMagicLink(invite);
            return res.status(200).json({ ok: true, email: invite, link, expires_in: '20 minutes' });
        }
        return res.status(200).json({ reps: await listReps() });
    }

    if (req.method === 'POST') {
        const b = readBody(req);
        if (!b.email) return res.status(400).json({ error: 'email_required' });
        const rep = await createRep(b);
        return res.status(200).json({ ok: true, rep });
    }

    if (req.method === 'DELETE') {
        const e = normEmail(req.query.email);
        if (!e) return res.status(400).json({ error: 'email_required' });
        await redis.del(`rep:${e}`);
        await redis.srem('reps', e);
        return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
}
