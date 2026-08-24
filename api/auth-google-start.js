// GET /api/auth-google-start  -> sends the browser to Google's consent screen.
//
// Sign-in used to depend on email delivery, which meant an outage at the mail provider locked
// everyone out of their own hub with no way back in. Google sign-in takes that dependency out of the
// login path: the reps are already on Google Workspace, so this is the account they are signed into
// anyway. The magic link stays as a fallback for anyone without a Google account.
//
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET

import { redis, newToken, SITE } from './_auth.js';

export const REDIRECT_URI = `${SITE}/api/auth-google-callback`;

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
        return res.status(200).json({
            ok: false,
            reason: 'google_not_configured',
            hint: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel, then redeploy.',
        });
    }

    // A single-use state value, held server-side, so a callback cannot be forged or replayed.
    const state = newToken(16);
    try {
        await redis.set(`oauth:state:${state}`, '1', { ex: 600 });
    } catch (e) {
        return res.status(500).json({ ok: false, reason: 'state_store_failed' });
    }

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    // Which Google account to suggest. It is a hint for the account picker, never the access check:
    // the rep record is what actually decides who gets in.
    if (process.env.GOOGLE_WORKSPACE_DOMAIN) url.searchParams.set('hd', process.env.GOOGLE_WORKSPACE_DOMAIN);
    url.searchParams.set('prompt', 'select_account');

    res.writeHead(302, { Location: url.toString() });
    return res.end();
}
