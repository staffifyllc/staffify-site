// The reps' own inboxes, read for "please remove me".
// ------------------------------------------------------------------
// Joanna Johnson (Farmers, 2026-10-30) answered Milton's Hub email: "Please remove me from your mailing and texting
// list." It reached Milton and hello@, and nothing read either: the email worker scans only its sending inboxes, and only
// for rows in its own queue. Paul: "we need a really nice way for folks to unsubscribe ... have them tell me to kick
// rocks".
//
// Each run (api/rep-optout-sweep.js, its own cron) reads one rep inbox, Milton's, Madison's and Paul's Hub mailboxes in
// turn, from where it left off. A message from a prospect we have contacted that asks to be taken off (api/_kick-rocks.js
// asksToStop, on their own words only) takes them off everything: the stop list, every email-queue row
// (api/_outreach-stops.js), the CRM, and their Hiring now card. A message is marked read only once it is decided; one
// that could not be read or acted on goes on the box's retry list and is tried first next time, so the window moving on
// never loses it.
import { asksToStop } from './_kick-rocks.js';

const CURSOR = box => 'staffify:rep-optout:cursor:' + box;
const SEEN = id => 'staffify:rep-optout:seen:' + id;
const RETRY = box => 'staffify:rep-optout:retry:' + box;
export const LOG = 'staffify:rep-optout:log';
const INDEX = 'staffify:rep-optout:index';
// Our own mail, and machines, never ask anything of us.
const OURS = /@(?:gostaffify|trystaffify|staffifyhq|hirestaffify|tryfoundryhq|getfoundrybuilds|getfoundrysites|flylisted)\.com$/i;
const MACHINE = /^(?:mailer-daemon|postmaster|no-?reply|noreply|notifications?|bounce)@/i;
// A newsletter, a mailing list or an auto-responder is not a person answering us (its own "unsubscribe" is a footer).
const bulk = h => !!(h['list-unsubscribe'] || h['list-id'] || /\b(?:bulk|list|junk)\b/i.test(String(h.precedence || ''))
    || (h['auto-submitted'] && !/^no$/i.test(String(h['auto-submitted']).trim())) || h['x-autoreply'] || h['x-autorespond']);
const REPLY = /^\s*(?:re|fwd?|fw|aw)\s*:/i;
const addr = s => (String(s || '').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [])[0] || null;
const asList = v => (Array.isArray(v) ? v : (() => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } })());

/**
 * deps: { kv, boxes, access(box), gmail(token, path), headers(m), messageText(m), replyText(text),
 *         isProspect(email) -> bool, stop({ email, box, text, subject }) -> any, now }
 * opts: { max: messages listed per run, deadline: ms timestamp to stop working by }
 * Reads one box per call. Returns what it did.
 */
export async function sweepRepInboxes(deps, { max = 20, deadline = Infinity } = {}) {
    const { kv, boxes } = deps;
    const now = deps.now || Date.now();
    if (!boxes || !boxes.length) return { skipped: 'no rep inboxes' };
    const index = Number(await kv.get(INDEX) || 0) % boxes.length;
    const box = boxes[index];
    const out = { box, read: 0, asked: 0, stopped: [], retrying: 0 };
    const next = () => kv.set(INDEX, (index + 1) % boxes.length);
    let token;
    try { token = await deps.access(box); }
    catch (e) { await next(); return { ...out, error: 'mailbox not connected: ' + String(e && e.message || e).slice(0, 80) }; }

    // One message, decided once: 'done' (marked read) or 'retry' (left for the retry list).
    async function decide(id) {
        try {
            const m = await deps.gmail(token, 'messages/' + id + '?format=full');
            out.read++;
            const h = deps.headers(m), from = addr(h.from), subject = String(h.subject || '');
            let ask = false;
            if (from && !OURS.test(from) && !MACHINE.test(from) && !bulk(h)) {
                const text = deps.replyText(deps.messageText(m));
                // Their words, and a subject they wrote themselves ("Unsubscribe"), never "Re: <our subject>".
                ask = asksToStop(text) || (!REPLY.test(subject) && asksToStop(subject));
                if (ask) {
                    out.asked++;
                    if (await deps.isProspect(from)) {
                        await deps.stop({ email: from, box, text: text.slice(0, 200), subject: subject.slice(0, 120) });
                        out.stopped.push(from);
                        await kv.lpush(LOG, JSON.stringify({ at: new Date(now).toISOString(), email: from, box, subject: subject.slice(0, 120), text: text.slice(0, 200) }));
                        await kv.ltrim(LOG, 0, 499);
                    }
                }
            }
            await kv.set(SEEN(id), '1', { ex: 30 * 86400 });
            return 'done';
        } catch (e) { out.error = String(e && e.message || e).slice(0, 120); return 'retry'; }
    }

    const failed = [];
    let cut = false;
    for (const id of asList(await kv.get(RETRY(box)))) {
        if (Date.now() > deadline) { failed.push(id); continue; }
        if (await kv.get(SEEN(id))) continue;   // decided since, from another listing
        if (await decide(id) === 'retry') failed.push(id);
    }
    // First run: the last two weeks, so replies to the Hub emails reps have sent since it opened are honoured too.
    const cursor = (await kv.get(CURSOR(box))) || { after: Math.floor((now - 14 * 864e5) / 1000) };
    const until = cursor.until || Math.floor(now / 1000);
    // Anywhere but our own sent mail: a reply the rep already archived still counts.
    const q = 'in:anywhere -in:sent -in:drafts -in:chats -in:spam -in:trash -from:me after:' + Math.max(0, cursor.after - 300) + ' before:' + (until + 1);
    let list;
    try { list = await deps.gmail(token, 'messages?' + new URLSearchParams({ q, maxResults: String(max), ...(cursor.page ? { pageToken: cursor.page } : {}) })); }
    catch (e) {
        // A page Gmail no longer accepts starts the window over; the box's turn passes either way.
        if (cursor.page) await kv.set(CURSOR(box), { after: cursor.after });
        await kv.set(RETRY(box), [...new Set(failed)].slice(0, 200));
        await next();
        return { ...out, error: 'list failed: ' + String(e && e.message || e).slice(0, 80) };
    }
    for (const item of list.messages || []) {
        if (Date.now() > deadline) { cut = true; break; }
        if (await kv.get(SEEN(item.id))) continue;
        if (await decide(item.id) === 'retry') failed.push(item.id);
    }
    out.retrying = new Set(failed).size;
    await kv.set(RETRY(box), [...new Set(failed)].slice(0, 200));
    // Out of time: the window stays where it was and the next run lists it again (what was decided is skipped).
    if (cut) return { ...out, cut: true };
    await kv.set(CURSOR(box), list.nextPageToken ? { ...cursor, page: list.nextPageToken, until } : { after: until });
    if (!list.nextPageToken) await next();
    return out;
}
