// PUBLIC: someone on /real-estate-media/ asks Paul for a role map, or for 15 minutes.
//
//   POST /api/role-map-request  { name, email, company?, pain?, times?, website?, source?, path? }
//     -> 200 { ok:true, message }      the same answer every time, for everyone
//
// This endpoint is deliberately thin. The rules live in api/_rolemap.js so they can be tested without
// a network, and the tests mock both notification senders so a test never emails or pings a person.
//
// What it will not do, by construction: read anything back out to the caller, touch a prospect record
// in the REP pool or HubSpot, write any state past REQUESTED, or reopen something Paul has closed.
import { createHash } from 'node:crypto';
import { redis, readBody } from './_auth.js';
import { slackNotify } from './_slack.js';
import { parseRequest, saveRequest, withinRate, PUBLIC_MESSAGE } from './_rolemap.js';

const ALLOWED_ORIGINS = ['https://www.gostaffify.com', 'https://gostaffify.com', 'http://localhost:3000'];
const NOTIFY_TO = 'hello@gostaffify.com';
const hash = (s) => createHash('sha256').update(String(s).toLowerCase()).digest('hex').slice(0, 24);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function notifyEmail(r) {
    const key = process.env.RESEND_API_KEY;
    if (!key) return { ok: false, skipped: 'RESEND_API_KEY missing' };
    const from = process.env.FROM_EMAIL || 'Staffify <hello@gostaffify.com>';
    const text = [
        (r.reopened ? 'New submission on a request you already closed' : 'Role-map request') + ' from /real-estate-media/',
        '',
        'Name:     ' + r.name,
        'Email:    ' + r.email,
        'Company:  ' + (r.company || '(not given)'),
        '',
        'What still comes back to them:',
        r.pain || '(they did not say)',
        '',
        r.times ? ('They would talk, and suggested: ' + r.times) : 'They did not ask for a call.',
        '',
        'This is a REQUEST. Nothing is booked. Reply to them yourself and agree a time if there is one.',
        'Queue: https://www.gostaffify.com/pilot/',
    ].join('\n');
    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to: NOTIFY_TO, reply_to: r.email,
                subject: (r.reopened ? 'Reopened: ' : '') + 'Role map: ' + r.name + (r.company ? ' (' + r.company + ')' : ''),
                text, html: '<pre style="font:14px/1.6 ui-monospace,monospace">' + esc(text) + '</pre>' }),
            signal: AbortSignal.timeout(10000),
        });
        return res.ok ? { ok: true } : { ok: false, error: 'resend ' + res.status };
    } catch (e) { return { ok: false, error: 'send failed' }; }
}

async function notifySlackAlert(r) {
    return slackNotify((r.reopened ? 'New submission on a closed role-map request' : 'Role-map request')
        + ': ' + r.name + (r.company ? ' at ' + r.company : '')
        + '. Wants ' + (r.times ? 'the role map and a time' : 'the role map')
        + '. This is a request, not a booking. https://www.gostaffify.com/pilot/');
}

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

    const out = await saveRequest(parsed, { redis, hash, now: Date.now, notifyEmail, notifySlack: notifySlackAlert });
    if (!out.saved) {
        return res.status(503).json({ ok: false, error: 'We could not record that. Email hello@gostaffify.com and it reaches the same place.' });
    }
    // One answer, every time. No id, no hint about whether we had seen this address before.
    return res.status(200).json({ ok: true, message: PUBLIC_MESSAGE });
}
