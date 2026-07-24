// GET /api/auth-me -> the signed-in rep, or 401.

import { currentRep } from './_auth.js';

export default async function handler(req, res) {
    const rep = await currentRep(req);
    res.setHeader('Cache-Control', 'no-store');
    if (!rep) return res.status(401).json({ error: 'unauthenticated' });
    return res.status(200).json({
        rep: { email: rep.email, name: rep.name, role: rep.role, rate: rep.rate },
    });
}
