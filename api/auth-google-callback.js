// GET /api/auth-google-callback?code=...&state=...
//
// Google sends the browser back here. We swap the code for an id_token over a server-to-server call
// authenticated with our client secret, read the verified email off it, and mint the same session a
// magic link would. Anyone whose address has no rep record is refused: signing in with Google proves
// who you are, it does not decide whether you work here.

import { redis, getRep, createSession, setSessionCookie, normEmail } from './_auth.js';
import { REDIRECT_URI } from './auth-google-start.js';

function decodeJwtPayload(jwt) {
    // The token came straight from Google's token endpoint over TLS, authenticated with our client
    // secret, so it is trusted at this point and needs no separate signature check. Reading the
    // payload is all that is left.
    const part = String(jwt || '').split('.')[1] || '';
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
}

const bounce = (res, err) => { res.writeHead(302, { Location: `/hub/?e=${err}` }); res.end(); };

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const { code, state, error } = req.query || {};
    if (error) return bounce(res, 'google_denied');
    if (!code || !state) return bounce(res, 'google_incomplete');

    // Single use: consume the state so a callback URL cannot be replayed.
    try {
        const key = `oauth:state:${state}`;
        const found = await redis.get(key);
        if (!found) return bounce(res, 'expired');
        await redis.del(key);
    } catch (e) {
        return bounce(res, 'google_state');
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return bounce(res, 'google_unconfigured');

    let payload;
    try {
        const r = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code: String(code),
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization_code',
            }),
        });
        if (!r.ok) {
            console.error('[auth-google] token exchange failed:', r.status, (await r.text().catch(() => '')).slice(0, 300));
            return bounce(res, 'google_exchange');
        }
        payload = decodeJwtPayload((await r.json()).id_token);
    } catch (e) {
        console.error('[auth-google] token exchange threw:', (e && e.message) || e);
        return bounce(res, 'google_exchange');
    }

    const email = normEmail(payload && payload.email);
    if (!email || payload.email_verified === false) return bounce(res, 'google_unverified');

    // Google proves identity. The rep record is what grants access.
    const rep = await getRep(email).catch(() => null);
    if (!rep) return bounce(res, 'norep');

    const sid = await createSession(email);
    setSessionCookie(res, sid);
    res.writeHead(302, { Location: '/hub/' });
    return res.end();
}
