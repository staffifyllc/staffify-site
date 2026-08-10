// Shared QuickBooks Online helper. Reuses the SAME token store (Upstash hash `qb:tokens`)
// and Intuit app credentials as api/quickbooks-webhook.js, so there is exactly one
// production QBO connection and one refresher. Do not add a second token lineage.
//
// Env: QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REALM_ID, KV_REST_API_URL, KV_REST_API_TOKEN

import { Redis } from '@upstash/redis';

const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

const QB_API_BASE = 'https://quickbooks.api.intuit.com';
const QB_OAUTH_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// True once the OAuth callback has stored a refresh token.
export async function qboConnected() {
    const cached = await redis.hgetall('qb:tokens');
    return !!(cached && cached.refresh_token);
}

export async function getAccessToken() {
    const cached = await redis.hgetall('qb:tokens');
    const now = Date.now();
    if (cached && cached.access_token && cached.access_expires_at && Number(cached.access_expires_at) > now + 60000) {
        return cached.access_token;
    }
    const refreshToken = cached && cached.refresh_token;
    if (!refreshToken) throw new Error('qb_not_connected');

    const basicAuth = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
    const res = await fetch(QB_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${basicAuth}`,
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`qb_refresh_failed ${res.status}: ${detail.slice(0, 160)}`);
    }
    const j = await res.json();
    const accessToken = j.access_token;
    const newRefreshToken = j.refresh_token || refreshToken; // QB rotates sometimes
    const expiresAt = now + (Number(j.expires_in || 3600) * 1000);
    await redis.hset('qb:tokens', {
        access_token: accessToken,
        access_expires_at: expiresAt,
        refresh_token: newRefreshToken,
        refresh_token_updated_at: now,
    });
    return accessToken;
}

// Run a QBO SQL-ish query against the company realm. Returns the parsed JSON body.
export async function qboQuery(sql) {
    const token = await getAccessToken();
    const realmId = process.env.QB_REALM_ID;
    const url = `${QB_API_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
    if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new Error(`qb_query ${r.status}: ${detail.slice(0, 200)}`);
    }
    return r.json();
}
