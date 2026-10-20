import {miltonIdentity} from './_milton-plan.js';
// GET /api/auth-verify?t=TOKEN  -> consumes the magic token, sets the session cookie, redirects to the hub.

import { consumeMagic, createSession, setSessionCookie, getRep } from './_auth.js';

export default async function handler(req, res) {
    const t = (req.query.t || '').toString();
    const email = t ? await consumeMagic(t) : null;
    if (!email) {
        res.setHeader('Location', '/hub/?e=expired');
        return res.status(302).end();
    }
    const rep = await getRep(email);
    if (!rep) {
        res.setHeader('Location', '/hub/?e=norep');
        return res.status(302).end();
    }
    const sid = await createSession(email);
    setSessionCookie(res, sid);
    res.setHeader('Location', miltonIdentity(rep) ? '/sales-workspace/' : rep.role === 'admin' ? '/hub/' : '/my-day/');
    return res.status(302).end();
}
