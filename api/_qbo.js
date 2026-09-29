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

async function refreshAccessToken() {
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
        signal:AbortSignal.timeout(15000),
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

export async function getAccessToken(){
    const saved=await redis.hgetall('qb:tokens');
    if(saved?.access_token&&Number(saved.access_expires_at)>Date.now()+60000)return saved.access_token;
    const nonce=String(Date.now())+Math.random();
    if(!await redis.set('qb:refresh_lock',nonce,{nx:true,ex:30})){
        for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,250));const s=await redis.hgetall('qb:tokens');if(s?.access_token&&Number(s.access_expires_at)>Date.now()+60000)return s.access_token;}
        throw Error('QuickBooks token refresh busy; retry shortly');
    }
    try{return await refreshAccessToken();}
    finally{await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",['qb:refresh_lock'],[nonce]);}
}

// Realm (company) id. Prefer the env var, but fall back to what the OAuth callback captured
// into qb:tokens, so connecting is enough and QB_REALM_ID never has to be set by hand.
export async function getRealmId() {
    if (process.env.QB_REALM_ID) return process.env.QB_REALM_ID;
    const r = await redis.hget('qb:tokens', 'realm_id');
    return r || '';
}

// Run a QBO SQL-ish query against the company realm. Returns the parsed JSON body.
export async function qboQuery(sql) {
    const token = await getAccessToken();
    const realmId = await getRealmId();
    if (!realmId) throw new Error('qb_no_realm');
    const url = `${QB_API_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },signal:AbortSignal.timeout(15000) });
    if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new Error(`qb_query ${r.status}: ${detail.slice(0, 200)}`);
    }
    return r.json();
}
