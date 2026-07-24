// GET /api/auth-logout -> clears the session cookie.

import { clearSessionCookie } from './_auth.js';

export default async function handler(req, res) {
    clearSessionCookie(res);
    res.setHeader('Location', '/hub/');
    return res.status(302).end();
}
