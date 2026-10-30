// GET /api/unsubscribe?e=foo@bar.com&t=<hmac>            the website drips' link: the same page with one button
// GET /kick-rocks/?e=...&t=...  (rewrite, style=kick)      a prospect's way out: a page with one button
// POST either address                                      the button, or a mail client's List-Unsubscribe one-click
//
// One-click unsubscribe. Validates the HMAC token (so attackers can't
// unsubscribe arbitrary emails), then removes the subscriber from every
// active queue and writes a tombstone to `unsubscribed:set` so future
// enrollment paths (subscribe, calendly-webhook, backfill) skip them.
//
// Returns an HTML confirmation page on success.

import { Redis } from '@upstash/redis';
import { verify as verifyToken } from '../lib/unsubscribe-token.js';
import { redis as kv } from './_auth.js';
import { optOut, optOutEverywhere } from './_optout.js';
import { requestStop } from './_outreach-stops.js';
import { stopHiringCards } from './_hiring-calls.js';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

function isValidEmail(s) {
    return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length < 254;
}


// Paul, 2026-10-30: "did we end up making an unsubscribe option, should it be a link, but make it funny?" Opening the
// link only asks; a scanner that opens every link in an email never unsubscribes anyone. The button (or a mail client's
// one-click POST) does it, everywhere.
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Paul, 2026-10-30, of the first version: "this is too much, its just at the bottom of the email". One line and one button.
function kickPage({ stage, email, action }) {
    const line = {
        ask: `Unsubscribe ${esc(email)} from all Staffify emails, texts and calls?`,
        done: 'Done. You are unsubscribed. Rocks: kicked.',
        err: 'That link did not work. Reply "kick rocks" to any of our emails and we will take you off by hand.',
        fail: 'Something went wrong, so nothing changed yet. Try again, or reply "kick rocks" to any of our emails.',
    }[stage];
    const button = (stage === 'ask' || stage === 'fail') && action ? `<form method="post" action="${esc(action)}"><button type="submit">Yes, kick rocks</button></form>` : '';
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Unsubscribe | Staffify</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<style>
  :root{--ground:#ffffff;--ink:#1f2328;--button:#1f2328;--button-ink:#ffffff;}
  @media (prefers-color-scheme: dark){:root{--ground:#16181d;--ink:#e6e8eb;--button:#e6e8eb;--button-ink:#16181d;}}
  body{margin:0;padding:48px 16px;background:var(--ground);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;}
  main{max-width:480px;margin:0 auto;}
  p{margin:0 0 16px;word-break:break-word;}
  button{font:inherit;font-weight:600;background:var(--button);color:var(--button-ink);border:0;border-radius:8px;padding:9px 16px;cursor:pointer;}
  button:focus-visible{outline:2px solid var(--ink);outline-offset:2px;}
</style>
</head><body>
<main><p>${line}</p>${button}</main>
</body></html>`;
}

/** Off everything: the website drips (as before), the stop list with the CRM marked, every email-queue row, the call list. */
async function stopEverything(email, source) {
    // Tombstone first so any race with a concurrent enrollment loses.
    await redis.sadd('unsubscribed:set', email);
    await redis.hset(`unsubscribed:${email}`, { email, unsubscribed_at: Date.now(), source });
    // Pull out of every active queue + delete drip records.
    await redis.zrem('softyes:active', email);
    await redis.zrem('nurture:active', email);
    await redis.zrem('disposition:pending', email);
    await redis.del(`softyes:${email}`);
    await redis.del(`nurture:${email}`);
    // Wipe the subscriber row + master index so future re-signups go through
    // the normal flow and bounce off the tombstone.
    await redis.del(`subscriber:${email}`);
    await redis.zrem('subscribers:by_date', email);
    // Everything else a prospect could hear from: the stop list, every email-queue row, the call list (quick writes,
    // first), then the CRM marked do not contact, last and best effort, since HubSpot can be slow.
    const stop = await optOut({ email, reason: 'Unsubscribed by link', source });
    if (!stop.ok) throw Error('Stop list write failed');
    await requestStop(kv, { email, by: source, why: 'Unsubscribed by link' }).catch(() => {});
    await stopHiringCards(kv, { email }, { why: 'Unsubscribed by link', by: source }).catch(() => {});
    await optOutEverywhere({ email, reason: 'Unsubscribed by link', source }).catch(() => {});
}

export default async function handler(req, res) { return unsubscribe(req, res); }

/** The handler, with the stop injectable for tests. */
export async function unsubscribe(req, res, { stop = stopEverything } = {}) {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const rawEmail = (url.searchParams.get('e') || '').toString();
    const token = (url.searchParams.get('t') || '').toString();
    const email = rawEmail.trim().toLowerCase();
    const kick = url.searchParams.get('style') === 'kick' || url.pathname.startsWith('/kick-rocks');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');

    // Every link asks first, the website drips' older one included: a mail scanner opens every link it sees, and a stop
    // that acted on open would take off people who never clicked (booked leads among them). The button, or a mail
    // client's one-click POST, does it.
    const ok = isValidEmail(email) && token && verifyToken(email, token);
    if (!ok) return res.status(400).send(kickPage({ stage: 'err' }));
    const action = '/kick-rocks/?e=' + encodeURIComponent(email) + '&t=' + encodeURIComponent(token);
    if (req.method !== 'POST') return res.status(200).send(kickPage({ stage: 'ask', email, action }));
    try { await stop(email, kick ? 'kick-rocks-link' : 'one-click-link'); }
    catch (err) { console.error('unsubscribe error', err); return res.status(500).send(kickPage({ stage: 'fail', email, action })); }
    return res.status(200).send(kickPage({ stage: 'done', email }));
}
