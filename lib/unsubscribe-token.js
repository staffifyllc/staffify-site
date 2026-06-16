// One-click unsubscribe tokens. Stable HMAC of the email so the same link
// works in every past email — no per-send database write needed.
//
// Signed with UNSUBSCRIBE_SECRET. Falls back to CRON_SECRET, then ADMIN_TOKEN
// so the system works without adding a new env var on day one. Either of
// those is sufficiently long and random and never leaves the server, so it's
// fine as an HMAC secret in practice.

import crypto from 'node:crypto';

const BASE_URL = process.env.UNSUBSCRIBE_BASE_URL || 'https://www.gostaffify.com';

function secret() {
    const s = process.env.UNSUBSCRIBE_SECRET
           || process.env.CRON_SECRET
           || process.env.ADMIN_TOKEN
           || '';
    if (!s) throw new Error('No unsubscribe secret configured');
    return s;
}

function normalize(email) {
    return String(email || '').trim().toLowerCase();
}

// URL-safe base64 (no padding) — shorter than hex and safe in query strings.
function urlSafe(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function sign(email) {
    const e = normalize(email);
    if (!e) throw new Error('email required');
    const mac = crypto.createHmac('sha256', secret()).update(e).digest();
    return urlSafe(mac).slice(0, 24); // 24 chars = 144 bits, plenty for an unsub link
}

export function verify(email, token) {
    const e = normalize(email);
    const t = String(token || '');
    if (!e || !t) return false;
    const expected = sign(e);
    if (expected.length !== t.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(t));
    } catch {
        return false;
    }
}

export function link(email) {
    const e = normalize(email);
    if (!e) return '';
    const t = sign(e);
    return `${BASE_URL}/api/unsubscribe?e=${encodeURIComponent(e)}&t=${t}`;
}
