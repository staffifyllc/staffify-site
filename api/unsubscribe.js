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
function kickPage({ stage, email, action }) {
    const copy = {
        ask: { title: 'Kick rocks?', h1: 'Ready to tell us to kick rocks?', p: "One click and you're off every Staffify list. No more emails, texts or calls from anyone on our team." },
        done: { title: 'Rocks: kicked', h1: 'Rocks: kicked.', p: "You're off every Staffify list. No more emails, texts or calls from us. Sorry for the bother, and good luck out there." },
        err: { title: 'That rock did not budge', h1: "That rock didn't budge.", p: 'This link looks broken. Reply "kick rocks" to any of our emails and we will take you off by hand.' },
        fail: { title: 'That rock did not budge', h1: "That rock didn't budge.", p: 'Something broke on our side, so nothing changed yet. Press the button again, or reply "kick rocks" to any of our emails and we will take you off by hand.' },
    }[stage];
    const button = (stage === 'ask' || stage === 'fail') && action
        ? `<form method="post" action="${esc(action)}"><button type="submit">Kick the rocks</button></form><p class="small">Changed your mind? Just close this tab. No rocks were harmed.</p>` : '';
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${esc(copy.title)} | Staffify</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<style>
  :root{--ground:#f4f6f9;--card:#ffffff;--ink:#0c1118;--muted:#5b6472;--accent:#0d82b8;--accent-ink:#ffffff;--chip:#eef2f6;}
  @media (prefers-color-scheme: dark){:root{--ground:#0d0f14;--card:#171a21;--ink:#eef1f6;--muted:#a3abb8;--accent:#38b6e8;--accent-ink:#06121a;--chip:#232833;}}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:var(--ground);color:var(--ink);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;}
  .card{max-width:500px;width:100%;background:var(--card);border-radius:18px;padding:44px 36px 36px;box-shadow:0 18px 50px rgba(0,0,0,0.12);}
  .rock{font-size:44px;line-height:1;margin-bottom:18px;}
  .brand{font-size:12px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:var(--accent);margin-bottom:14px;}
  h1{font-size:26px;font-weight:800;letter-spacing:-0.02em;line-height:1.2;margin-bottom:12px;text-wrap:balance;}
  p{font-size:15px;line-height:1.6;color:var(--muted);margin-bottom:16px;}
  .email{display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;background:var(--chip);padding:6px 12px;border-radius:8px;color:var(--ink);margin-bottom:20px;word-break:break-all;}
  button{font:inherit;font-size:16px;font-weight:700;background:var(--accent);color:var(--accent-ink);border:0;border-radius:12px;padding:14px 22px;cursor:pointer;}
  button:focus-visible{outline:3px solid var(--ink);outline-offset:2px;}
  .small{font-size:13px;margin:14px 0 0;}
  a{color:var(--accent);font-weight:600;text-decoration:none;}
</style>
</head><body>
<main class="card">
  <div class="rock" aria-hidden="true">🪨</div>
  <div class="brand">Staffify</div>
  <h1>${esc(copy.h1)}</h1>
  <p>${esc(copy.p)}</p>
  ${email ? `<div class="email">${esc(email)}</div>` : ''}
  ${button}
  ${stage === 'done' ? '<p class="small">Want us back someday? Write to <a href="mailto:hello@gostaffify.com">hello@gostaffify.com</a>.</p>' : ''}
</main>
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
