// PUBLIC: someone on /real-estate-media/ asks Paul for a role map, or for 15 minutes.
//
//   POST /api/role-map-request/  { name, email, company?, pain?, times?, website?, source?, path? }
//     -> 200 { ok:true, message }      the same answer every time, for everyone
//
// This endpoint is deliberately thin. The rules live in api/_rolemap.js so they can be tested without
// a network, and the tests mock both notification senders, so a test never emails or pings a person.
//
// What it will not do, by construction: read anything back out to the caller, touch a prospect record
// in the REP pool or HubSpot, write any state past REQUESTED, or reopen something Paul has closed.
import { createHash } from 'node:crypto';
import { redis, readBody } from './_auth.js';
import { notifyEmail, notifySlack } from './_notify-request.js';
import { parseRequest, saveRequest, withinRate, PUBLIC_MESSAGE } from './_rolemap.js';

const ALLOWED_ORIGINS = ['https://www.gostaffify.com', 'https://gostaffify.com', 'http://localhost:3000'];
const hash = (s) => createHash('sha256').update(String(s).toLowerCase()).digest('hex').slice(0, 24);

export default async function handler(req, res) {
    const origin = (req.headers.origin || '').toString();
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

    const parsed = parseRequest(readBody(req) || {});
    // A bot in the honeypot gets exactly what a person gets, so it learns nothing.
    if (parsed.bot) return res.status(200).json({ ok: true, message: PUBLIC_MESSAGE });
    if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });

    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
    if (!(await withinRate(redis, ip ? hash(ip) : ''))) {
        return res.status(429).json({ ok: false, error: 'That is a few too many in an hour. Email hello@gostaffify.com instead.' });
    }

    const out = await saveRequest(parsed, { redis, hash, now: Date.now, notifyEmail, notifySlack });
    if (!out.saved) {
        return res.status(503).json({ ok: false, error: 'We could not record that. Email hello@gostaffify.com and it reaches the same place.' });
    }
    // One answer, every time. No id, no hint about whether we had seen this address before.
    return res.status(200).json({ ok: true, message: PUBLIC_MESSAGE });
}
