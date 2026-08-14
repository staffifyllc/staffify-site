// No-answer follow-up text, sent from the sales hub through OpenPhone.
//
// POST /api/send-text/  { phone, first, role, rep, leadId }
//   -> { ok:true, sent:true }            text delivered
//   -> { ok:true, sent:false, reason }   deliberately skipped (already texted, no role, already replied...)
//   -> { ok:false, error }               misconfigured or OpenPhone rejected it
//
// The copy is built HERE, never passed in by the client, so the message cannot be tampered with
// and stays exactly what Paul approved:
//   "Hey {first}, it's {rep}. Just tried you about the {role} role you posted. Still hiring for it?"
// No company name, no pitch, no CTA beyond the question. Do not add any.
//
// Env: OPENPHONE_API_KEY (required), OPENPHONE_PHONE_NUMBER_ID (the number to send FROM).
//   That var accepts either an OpenPhone id ("PNxxxxxxxx") or the plain number ("(561) 617-9973"),
//   whichever is easier to hand over. A plain number is normalised to E.164 before sending.

import { openIdentity, redis, readBody } from './_auth.js';
import { slackNotify } from './_slack.js';
import { configured as hsReady, findOrCreateContact, logText } from './_hubspot.js';

const OP_API = 'https://api.openphone.com/v1/messages';
const SENT_KEY = 'text:sent';        // hash phone -> when/who, so a lead is never texted twice
const HOURLY_CAP = Number(process.env.TEXT_HOURLY_CAP || 60);

function e164(p) {
    const d = String(p || '').replace(/[^0-9]/g, '');
    if (!d) return '';
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    return String(p).trim().startsWith('+') ? '+' + d : '';
}
const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || '';
// Trim a posted job title down to something that reads naturally mid-sentence.
const cleanRole = (s) => String(s || '').split(/[-–—|(]/)[0].replace(/\s+/g, ' ').trim().slice(0, 60);

// One template per motion. Both open the same way (name, no company, no pitch) and end on a single
// question the prospect can answer in a word. Never add a claim, a rate, or a CTA to these.
function buildMessage({ first, rep, role, company, motion, priorCall, lastCall }) {
    // Foundry is Paul's brand and its threads already run under his name, so a websites text always
    // signs as him no matter which rep is on the dialer. Staffing signs as the rep who made the call.
    const who = (motion === 'websites') ? (process.env.FOUNDRY_SENDER_NAME || 'Paul') : firstName(rep);
    const hey = first ? `Hey ${first}, ` : 'Hey, ';
    if (motion === 'websites') {
        // Foundry has no "open role" hook, so the curiosity is whether they show up in AI search.
        // Nobody knows the answer to this, which is exactly why it gets a reply.
        return `${hey}it's ${who}. Just tried you. Random question, do you know if ${company} comes up when someone asks ChatGPT to find one nearby?`;
    }
    // A missed sales call NEVER posted a job. They told US what they wanted, on our own
    // booking form. Sending them the cold "the role you posted" line is a claim we cannot
    // back, and on 2026-08-12 Jackie Jaramillo replied "where for you see the role posted"
    // within a minute of getting it. Say the true thing instead: our team talked to them.
    if (priorCall) {
        const when = monthOf(lastCall);
        // "about the X you were looking for" reads right for every role we have on file.
        // "about a Executive Admin / Assistant" does not, so no bare article.
        const about = role ? ` about the ${role} you were looking for` : '';
        return `${hey}it's ${who} at Staffify. Just tried you. Our team spoke with you${when ? ' back in ' + when : ''}${about} and we never closed the loop with you. Did that ever get sorted?`;
    }
    return `${hey}it's ${who}. Just tried you about the ${role} role you posted. Still hiring for it?`;
}

// "2026-06-09" -> "June". Blank if we do not have a date, so the text never invents one.
function monthOf(iso) {
    const d = new Date(String(iso || '') + 'T12:00:00Z');
    return isNaN(d) ? '' : d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const who = await openIdentity(req).catch(() => null);
    const b = readBody(req);
    const to = e164(b.phone);
    const role = cleanRole(b.role);
    const first = firstName(b.first);
    const rep = (b.rep || (who && who.name) || '').toString();
    const motion = (b.motion === 'websites') ? 'websites' : 'staffing';
    const company = String(b.company || '').trim().slice(0, 60);

    if (!to) return res.status(200).json({ ok: true, sent: false, reason: 'no_valid_number' });
    // Each motion needs its own specific hook. Without it the text is generic, which is what reads as spam.
    if (motion === 'websites') {
        if (!company) return res.status(200).json({ ok: true, sent: false, reason: 'no_company' });
    } else if (!role) {
        return res.status(200).json({ ok: true, sent: false, reason: 'no_role' });
    }
    if (motion !== 'websites' && !firstName(rep)) return res.status(200).json({ ok: true, sent: false, reason: 'no_rep_name' });

    // Never text the same lead twice.
    try {
        const already = await redis.hget(SENT_KEY, to);
        if (already) return res.status(200).json({ ok: true, sent: false, reason: 'already_texted' });
    } catch (e) { /* if the check fails, fall through to the cap below */ }

    // Hourly cap as a runaway backstop.
    try {
        const bucket = 'text:rl:' + Math.floor(Date.now() / 3600000);
        const n = await redis.incr(bucket);
        if (n === 1) await redis.expire(bucket, 3700);
        if (n > HOURLY_CAP) return res.status(200).json({ ok: true, sent: false, reason: 'rate_limited' });
    } catch (e) { /* do not block on counter failure */ }

    const apiKey = process.env.OPENPHONE_API_KEY;
    const fromRaw = (process.env.OPENPHONE_PHONE_NUMBER_ID || '').trim();
    if (!apiKey || !fromRaw) return res.status(200).json({ ok: false, error: 'not_configured', detail: 'OPENPHONE_API_KEY / OPENPHONE_PHONE_NUMBER_ID not set' });
    // Accept a PN id as-is; anything else is treated as a phone number and normalised.
    // Foundry can send from its own line if one is configured, otherwise it shares the default number.
    const foundryRaw = (process.env.OPENPHONE_FOUNDRY_NUMBER_ID || '').trim();
    const pick = (motion === 'websites' && foundryRaw) ? foundryRaw : fromRaw;
    const from = /^PN/i.test(pick) ? pick : (e164(pick) || pick);

    const content = buildMessage({ first, rep, role, company, motion, priorCall: !!b.priorCall, lastCall: b.lastCall || '' });
    try {
        const r = await fetch(OP_API, {
            method: 'POST',
            headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to: [to], content }),
        });
        if (!r.ok) {
            const detail = (await r.text().catch(() => '')).slice(0, 200);
            return res.status(200).json({ ok: false, error: 'openphone_' + r.status, detail });
        }
        // Record it so the lead is never texted again, and so it can be audited later.
        try {
            await redis.hset(SENT_KEY, { [to]: JSON.stringify({ at: Date.now(), rep: firstName(rep), role, company, motion, by: (who && who.email) || 'guest', content }) });
        } catch (e) { /* the text went out; logging is best effort */ }
        // Mirror the text onto the HubSpot contact so the CRM shows the full thread. Never block on it.
        if (hsReady()) {
            try {
                const parts = String(b.first || '').trim().split(/\s+/);
                const c = await findOrCreateContact({ phone: to, firstname: parts[0] || '', lastname: parts.slice(1).join(' '), company });
                if (c.ok) await logText({ contactId: c.id, body: content, direction: 'OUTBOUND', at: Date.now() });
            } catch (e) { /* the text already went out; CRM logging is best effort */ }
        }
        slackNotify(':speech_balloon: *' + firstName(rep) + '* texted a no-answer lead: *' + (motion === 'websites' ? company : role) + '*');
        return res.status(200).json({ ok: true, sent: true, content });
    } catch (e) {
        return res.status(200).json({ ok: false, error: 'network', detail: String((e && e.message) || e).slice(0, 160) });
    }
}
