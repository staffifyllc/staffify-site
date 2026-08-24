// Break-glass sign-in for an admin when email delivery is down.
//
// The hub and the commissions page need a real session cookie, and the only way to get one was a
// magic link. That makes the mail provider a single point of failure for getting into your own
// system: if sending breaks, everyone is locked out and the sign-in page cannot say why.
//
// GET /api/auth-admin-signin/?token=ADMIN_TOKEN&email=you@gostaffify.com
//   -> mints the same session the magic link would and redirects to the hub.
//
// This grants no access the token did not already grant: ADMIN_TOKEN already authorizes every admin
// endpoint on this site. It only converts that token into the session cookie the hub pages expect.
// It still refuses any address that is not already a rep, so it cannot create an account.

import { adminAuthorized, getRep, createSession, setSessionCookie, normEmail } from './_auth.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!adminAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

    const email = normEmail(req.query.email || '');
    if (!email) return res.status(400).json({ error: 'add &email=you@gostaffify.com' });

    const rep = await getRep(email);
    if (!rep) {
        return res.status(404).json({
            error: 'no rep record for that address',
            hint: 'This endpoint signs in an existing rep. It does not create one.',
        });
    }

    const sid = await createSession(email);
    setSessionCookie(res, sid);

    // Straight to the hub, so the token never has to be pasted anywhere else.
    res.writeHead(302, { Location: '/hub/' });
    return res.end();
}
