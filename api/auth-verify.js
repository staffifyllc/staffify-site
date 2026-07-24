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
    res.setHeader('Location', '/hub/');
    return res.status(302).end();
}
