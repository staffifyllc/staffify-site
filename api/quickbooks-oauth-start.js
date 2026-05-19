// GET /api/quickbooks-oauth-start/?token=<ADMIN_TOKEN>
// Kicks off the Intuit OAuth handshake. Redirects to Intuit's auth screen.
// After Paul approves, Intuit redirects to /api/quickbooks-oauth-callback/.

import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const REDIRECT_URI = 'https://www.gostaffify.com/api/quickbooks-oauth-callback/';
const SCOPE = 'com.intuit.quickbooks.accounting';

export default async function handler(req, res) {
    if ((req.query.token || '') !== process.env.ADMIN_TOKEN) {
        return res.status(401).send('unauthorized');
    }
    const clientId = process.env.QB_CLIENT_ID;
    if (!clientId) return res.status(500).send('QB_CLIENT_ID not set in Vercel env vars');

    // CSRF state — store with short TTL, verify in callback
    const state = crypto.randomBytes(24).toString('hex');
    await redis.set(`qb:oauth:state:${state}`, '1', { ex: 600 }); // 10 min

    const params = new URLSearchParams({
        client_id: clientId,
        scope: SCOPE,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        state,
    });

    res.writeHead(302, { Location: `https://appcenter.intuit.com/connect/oauth2?${params.toString()}` });
    res.end();
}
