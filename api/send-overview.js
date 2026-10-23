// "Just send me something." One click sends the Staffify overview.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "when somebody that we reach out to on a call tells the person to just send
// them something. This is exactly what we should be sending them. It should be a button."
//
// That sentence on a call is the clearest consent a prospect ever gives: they asked for it, by
// name, out loud. So this sends without the hesitation the cold paths need, but it keeps the rules
// that protect the person on the other end.
//
//   * The prospect is looked up from the queue. Names, company and address are NEVER taken from
//     the browser, so the email cannot be pointed at somebody else or carry injected text.
//   * The do-not-contact list is checked by email AND by phone. A STOP by text arrives as a number,
//     and on 2026-10-22 eight people who had texted STOP were linked to no email at all.
//   * Once per person per 30 days. A second click is a no-op that says when it already went.
//   * The body carries no statistics. Paul's 2026-09-17 rule bans percentages and client counts
//     from outbound copy, so the email says what the document is and lets the document speak.
//
// Replies go to the mailbox the prospect has already been emailing with, so the outreach worker
// sees the reply and stops the sequence, exactly as it would for any other reply.
//
// POST /api/send-overview/ { email }  -> { sent, at, to, replyTo } or { sent:false, reason }
import { redis, requireAccess, SITE, readBody } from './_auth.js';
import { KEY, visibleState, canUseCallQueue } from './_outreach-queue.js';
import { isOptedOut } from './_optout.js';
import { recordActivity } from './_hub-activity.js';

export const OVERVIEW_PATH = '/assets/docs/staffify-overview.pdf';
export const OVERVIEW_URL = 'https://www.gostaffify.com' + OVERVIEW_PATH;
export const SENT = email => 'staffify:overview-sent:' + String(email || '').toLowerCase();
const ONCE_PER_MS = 30 * 86400000;
const FROM = 'Staffify <hello@gostaffify.com>';
const FALLBACK_REPLY_TO = 'hello@gostaffify.com';

const firstOf = s => String(s || '').trim().split(/\s+/)[0] || '';

/** The email, built only from the queue record and the caller's own name. */
export function composeOverview({ firstName, caller }) {
    const hi = firstName ? `Hi ${firstName},` : 'Hi,';
    const from = caller ? `the call from ${caller}` : 'our call';
    const sign = caller || 'The Staffify team';
    const text = [
        hi,
        '',
        `Thanks for taking ${from} today. Here's the overview you asked for. It's one page: the roles we place, how quickly, and how it works once someone starts.`,
        '',
        OVERVIEW_URL,
        '',
        `It's attached as well. If any of it fits something you're working on, reply with the role you have in mind and we'll take it from there.`,
        '',
        sign,
        'Staffify',
    ].join('\n');
    const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const html = `<p>${esc(hi)}</p>`
        + `<p>Thanks for taking ${esc(from)} today. Here's the overview you asked for. It's one page: the roles we place, how quickly, and how it works once someone starts.</p>`
        + `<p><a href="${OVERVIEW_URL}">Open the Staffify overview</a></p>`
        + `<p>It's attached as well. If any of it fits something you're working on, reply with the role you have in mind and we'll take it from there.</p>`
        + `<p>${esc(sign)}<br>Staffify</p>`;
    return { subject: "Here's the Staffify overview", text, html };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (req.headers.origin !== SITE) return res.status(403).json({ error: 'Invalid origin' });
    try {
        const rep = await requireAccess(req);
        if (!rep || !rep.email || !canUseCallQueue(rep)) return res.status(403).json({ error: 'Caller access required' });
        const email = String(readBody(req).email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'Which prospect?' });

        const state = await redis.get(KEY);
        const row = visibleState(state, 'all').records.find(r => String(r.recipient || '').toLowerCase() === email);
        if (!row) return res.status(404).json({ sent: false, reason: 'That prospect is not in the queue, so nothing was sent.' });

        const phone = (row.callContact && row.callContact.phone) || row.phone || '';
        if (await isOptedOut({ email, phone })) {
            return res.status(200).json({ sent: false, reason: 'This person is on the do-not-contact list. Nothing was sent.' });
        }

        const prior = await redis.get(SENT(email));
        if (prior && prior.at && Date.now() - Date.parse(prior.at) < ONCE_PER_MS) {
            return res.status(200).json({ sent: false, already: prior, reason: `Already sent ${new Date(prior.at).toLocaleString()} by ${prior.by}. Not sent again.` });
        }

        const apiKey = process.env.RESEND_API_KEY;
        if (!apiKey) return res.status(503).json({ sent: false, reason: 'Email sending is not configured on this project, so nothing was sent.' });

        // The document itself, read from the site so the attachment is always the current version.
        const pdf = await fetch(OVERVIEW_URL);
        if (!pdf.ok) return res.status(503).json({ sent: false, reason: `The overview could not be loaded (${pdf.status}), so nothing was sent.` });
        const content = Buffer.from(await pdf.arrayBuffer()).toString('base64');

        const caller = firstOf(rep.name) || null;
        const msg = composeOverview({ firstName: firstOf(row.verifiedFirstName), caller });
        const replyTo = /@[a-z0-9.-]+\.[a-z]{2,}$/i.test(row.sender || '') ? row.sender : FALLBACK_REPLY_TO;

        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: FROM, to: [email], reply_to: replyTo,
                subject: msg.subject, text: msg.text, html: msg.html,
                attachments: [{ filename: 'Staffify-Overview.pdf', content }],
            }),
        });
        if (!r.ok) {
            const detail = (await r.text().catch(() => '')).slice(0, 200);
            return res.status(502).json({ sent: false, reason: `The email service refused it (${r.status}). Nothing was sent.`, detail });
        }
        const out = await r.json().catch(() => ({}));
        const receipt = { at: new Date().toISOString(), by: rep.name || rep.email, to: email, replyTo, id: out.id || null, company: row.company || null };
        await redis.set(SENT(email), receipt, { ex: 400 * 86400 }).catch(() => {});
        await recordActivity(redis, { email: rep && rep.email, kind: 'overview_sent', page: '/dialer/', detail: receipt && receipt.to || null });
        return res.status(200).json({ sent: true, ...receipt });
    } catch (e) {
        return res.status(503).json({ sent: false, reason: 'The overview could not be sent. ' + String((e && e.message) || e).slice(0, 140) });
    }
}
