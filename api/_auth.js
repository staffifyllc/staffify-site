// Shared auth + rep helpers for the Staffify sales hub.
// Files in /api starting with "_" are not routed as endpoints.
// Env: KV_REST_API_URL, KV_REST_API_TOKEN, RESEND_API_KEY, FROM_EMAIL, ADMIN_TOKEN/CRON_SECRET

import { Redis } from '@upstash/redis';
import { randomBytes } from 'node:crypto';

export const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

export const SESSION_COOKIE = 'sfy_sess';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const MAGIC_TTL = 60 * 20;             // 20 minutes
export const SITE = 'https://www.gostaffify.com';

export const newToken = (n = 24) => randomBytes(n).toString('hex');
export const normEmail = (e) => (e || '').toString().trim().toLowerCase();

export function adminAuthorized(req) {
    const valid = [process.env.ADMIN_TOKEN, process.env.CRON_SECRET].filter(Boolean);
    if (!valid.length) return false;
    const provided = (req.query?.token || '').toString();
    if (provided && valid.includes(provided)) return true;
    const hdr = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(hdr);
    return !!m && valid.includes(m[1]);
}

function parseCookies(req) {
    const out = {};
    (req.headers.cookie || '').split(';').forEach(part => {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
    return out;
}

export async function currentRep(req) {
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (!sid) return null;
    const email = await redis.get(`sess:${sid}`);
    if (!email) return null;
    return getRep(email);
}

// Either a logged-in rep OR an admin token. Returns the rep (or a synthetic admin).
export async function requireAccess(req) {
    const rep = await currentRep(req);
    if (rep) return rep;
    if (adminAuthorized(req)) return { email: 'admin', name: 'Admin', role: 'admin' };
    return null;
}

// OPEN-SHARE identity. Never blocks. Order of preference:
//   1) a signed-in rep (session cookie)  2) an admin token  3) a name the visitor typed
//   (rep/name/email on the query or POST body)  4) a generic "Guest".
// Use this on read + attribution endpoints so a shared link works with no login, while
// still crediting calls/quizzes to whatever name the visitor set on the page.
export async function openIdentity(req) {
    const rep = await currentRep(req).catch(() => null);
    if (rep) return rep;
    if (adminAuthorized(req)) return { email: 'admin', name: 'Admin', role: 'admin' };
    const q = req.query || {};
    const b = (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') ? readBody(req) : {};
    const name = (q.rep || q.name || b.rep || b.name || '').toString().trim().slice(0, 80);
    const email = (q.email || b.email || '').toString().trim().toLowerCase().slice(0, 120);
    if (name || email) {
        const derived = name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/(^\.|\.$)/g, '') + '@rep.local';
        return { email: email || derived, name: name || email, role: 'rep' };
    }
    return { email: 'guest', name: 'Guest', role: 'rep' };
}

export function setSessionCookie(res, sid) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`);
}
export function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

export async function getRep(email) {
    const e = normEmail(email);
    if (!e) return null;
    const rep = await redis.hgetall(`rep:${e}`);
    return rep && rep.email ? rep : null;
}

export async function listReps() {
    const emails = (await redis.smembers('reps')) || [];
    const out = [];
    for (const e of emails) {
        const r = await getRep(e);
        if (r) out.push(r);
    }
    return out.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
}

// houseRate is optional: the rate a rep earns on leads the company hands them, when their plan splits
// by lead source (e.g. 20 on house leads, 35 on self-sourced). Omit it and the rep earns `rate` on everything.
export async function createRep({ email, name, rate, role, houseRate }) {
    const e = normEmail(email);
    const rep = {
        email: e,
        name: (name || e).toString().slice(0, 120),
        rate: String(rate || 35),
        role: role === 'admin' ? 'admin' : 'rep',
        createdAt: String(Date.now()),
    };
    if (houseRate != null && houseRate !== '') rep.houseRate = String(houseRate);
    await redis.hset(`rep:${e}`, rep);
    await redis.sadd('reps', e);
    return rep;
}

export async function createSession(email) {
    const sid = newToken(24);
    await redis.set(`sess:${sid}`, normEmail(email), { ex: SESSION_TTL });
    return sid;
}

export async function createMagicLink(email) {
    const t = newToken(24);
    await redis.set(`magic:${t}`, normEmail(email), { ex: MAGIC_TTL });
    return `${SITE}/api/auth-verify/?t=${t}`;
}

export async function consumeMagic(t) {
    const key = `magic:${t}`;
    const email = await redis.get(key);
    if (email) await redis.del(key);
    return email;
}

export async function sendMail({ to, subject, html, text }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.FROM_EMAIL || 'Staffify <hello@gostaffify.com>';
    if (!apiKey) throw new Error('RESEND_API_KEY not set');
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
}

export function readBody(req) {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    return b || {};
}
