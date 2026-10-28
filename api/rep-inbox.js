// My inbox: the rep's own Gmail, inside the Hub.
// ------------------------------------------------------------------
// Paul, 2026-10-27: "he should have an area where he can check his inbox, its only notifying him to
// check it if he has a notification". Milton's replies land in milton@trystaffify.com, and the Hub's
// Inbox tab is the outreach console for Paul's and Madison's sequence mailboxes, so the only way he
// learned a prospect had written back was his phone buzzing. This reads his mailbox through the same
// Gmail connection the composer sends with (read + compose; it cannot delete, archive or mark read).
//
//   GET  /api/rep-inbox/?view=count              { mailbox, owner, connected, unread }   (nav badge)
//   GET  /api/rep-inbox/?view=list[&prospects=1][&page=]  threads, newest first, prospects matched to cards
//   GET  /api/rep-inbox/?thread=<id>             the thread's messages as plain text
//   POST /api/rep-inbox/ {action:'clean', threadId, body}    the cleanup pass on a reply (body only)
//   POST /api/rep-inbox/ {action:'reply', threadId, body, nonce}
//
// A reply goes to whoever last wrote to him in that thread, worked out here from the thread, never
// from the browser. It passes the same cleanup as every other email (api/_email-cleanup.js), the
// do-not-contact list, the nonce and the daily cap. Replies keep the thread's own subject, so Gmail
// keeps them in the conversation; the first-name rule is for new emails.
import { redis, requireAccess, SITE, readBody } from './_auth.js';
import { KEY, visibleState, canUseCallQueue } from './_outreach-queue.js';
import { access, gmail, seal, unseal, headers as headersOf } from './_outreach-gmail.js';
import { messageText } from './_mail-text.js';
import { isOptedOut } from './_optout.js';
import { recordActivity, dayOf } from './_hub-activity.js';
import { financeAccess } from './_finance-access.js';
import { cleanEmail } from './_email-cleanup.js';
import { mailboxFor, profileFor, signatureHtml, signatureText, bodyHtml, buildMime, rawOf, LIMITS, copyProblem, routeCopy, ROUTE_TO, TEAM_MAILBOXES } from './_rep-email.js';
import { gateFor, maskPhoneRuns } from './_shift.js';
import { ownerFor } from './_outreach-queue.js';
import { K, canSendWith, settlePending, photoUrlFor } from './rep-email.js';
import { stopsFor } from './_rep-email-gates.js';
import { contact } from './_outreach-crm.js';

const isOwner = rep => !!rep && (rep.role === 'admin' || financeAccess(rep));   // as in api/daily-report.js
const ADDR = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// The angle address first ("Nick <nick@x.com>"), so a display name that looks like an address is not taken for it.
const addrOf = s => { const t = String(s || ''); const a = t.match(/<([^>]+)>/); return (((a ? a[1] : t).match(ADDR) || [])[0] || '').toLowerCase(); };
const notDraft = m => !((m && m.labelIds) || []).includes('DRAFT');
const nameOf = s => { const m = String(s || '').match(/^\s*"?([^"<]+?)"?\s*</); return m ? m[1].trim() : addrOf(s); };
// Sent by this mailbox, or a teammate's email routed into hello@ (hello@ in its Reply-To): either way it is ours, and
// the prospect stays the other party. A teammate writing to hello@ directly is still someone to answer.
const ours = (h, box) => {
    const from = addrOf(h.from);
    if (from === box) return true;
    return box === ROUTE_TO && TEAM_MAILBOXES.includes(from) && String(h['reply-to'] || '').split(',').some(a => addrOf(a) === box);
};
const IK = {
    access: box => 'staffify:rep-inbox:access:' + box,
    count: box => 'staffify:rep-inbox:count:' + box,
    seen: box => 'staffify:rep-inbox:seen:' + box,   // threads opened in the Hub (Gmail's unread mark cannot be changed from here)
};

/** An access token, kept sealed for 50 minutes so every page load is not a Google token refresh. */
export async function accessFor(box, { kv = redis, refresh = access, now = Date.now() } = {}) {
    try { const c = await kv.get(IK.access(box)); if (c) { const t = unseal(c); if (t.exp > now + 60000) return t.token; } } catch { /* refresh below */ }
    const token = await refresh(box);
    await kv.set(IK.access(box), seal({ token, exp: now + 50 * 60000 }), { ex: 50 * 60 }).catch(() => {});
    return token;
}

/** Five at a time, so a page of threads does not burst Gmail's per-user limit. */
async function inBatches(items, fn, size = 5) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
    return out;
}

/** The other party in a thread: whoever last wrote that is not this mailbox, else who it went to. */
export function otherParty(messages, box) {
    const sent = (messages || []).filter(notDraft);   // an unsent draft is not a message
    for (const m of [...sent].reverse()) {
        const h = headersOf(m), from = addrOf(h.from);
        if (from && !ours(h, box)) { const rt = addrOf(h['reply-to']); return { addr: rt && rt !== box ? rt : from, name: nameOf(h.from), wrote: true }; }
    }
    const first = sent[0];
    const to = first ? addrOf(headersOf(first).to) : '';
    return to ? { addr: to, name: to, wrote: false } : null;
}

/** One row of the list. Pure, for tests. */
export function threadRow(thread, box, records) {
    const msgs = (thread.messages || []).filter(notDraft);
    const last = msgs[msgs.length - 1] || {};
    const h = headersOf(last);
    const other = otherParty(msgs, box);
    const rec = other ? (records || []).find(r => String(r.recipient || '').toLowerCase() === other.addr) : null;
    return {
        id: thread.id,
        subject: h.subject || '(no subject)',
        with: other ? other.name : null, withAddr: other ? other.addr : null,
        snippet: String(last.snippet || thread.snippet || '').slice(0, 200),
        at: last.internalDate ? new Date(Number(last.internalDate)).toISOString() : null,
        unread: msgs.some(m => (m.labelIds || []).includes('UNREAD')),
        count: msgs.length,
        lastFromMe: addrOf(h.from) === box,
        prospect: rec ? { recordId: rec.id, company: rec.company || rec.recipient } : null,
    };
}

async function context(req) {
    const rep = await requireAccess(req);
    if (!rep || !rep.email || rep.email === 'admin' || !canUseCallQueue(rep)) return { error: [401, 'Sign in to the Hub as yourself'] };
    const box = mailboxFor(rep);
    if (!box) return { error: [403, `No mailbox is set up for ${rep.email} yet. Ask Paul to add it.`] };
    return { rep, box };
}

const records = async () => visibleState(await redis.get(KEY), 'all').records;
const queueState = async () => { const s = visibleState(await redis.get(KEY), 'all'); return { records: s.records, suppressions: s.suppressions || [] }; };

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
        const ctx = await context(req);
        if (ctx.error) return res.status(ctx.error[0]).json({ error: ctx.error[1] });
        const { rep, box } = ctx;
        const connected = canSendWith(await redis.get(K.token(box)).catch(() => null));
        const q = req.query || {};
        const connectUrl = back => '/api/rep-email/?action=connect&back=' + encodeURIComponent(back || '/inbox/');
        // A grant Google no longer honours (password change, access removed) reads as not connected,
        // with the way back, never as "try again" for ever.
        const lapsed = e => /authorization (?:expired|missing)/i.test(String(e && e.message));
        // Off shift, a caller does not see phone numbers here either (the shift gate, as in the queue).
        const gated = !ownerFor(rep) && !(await gateFor(redis, rep, ownerFor).catch(() => ({ allowed: false }))).allowed;
        const mask = s => (gated ? maskPhoneRuns(String(s || '')) : s);

        if (req.method === 'GET' && q.view === 'count') {
            const base = { mailbox: box, owner: isOwner(rep), connected, unread: null };
            if (!connected) return res.status(200).json(base);
            const cached = await redis.get(IK.count(box)).catch(() => null);
            if (cached && typeof cached.unread === 'number') return res.status(200).json({ ...base, unread: cached.unread });
            try {
                const token = await accessFor(box);
                // A teammate's routed copy is not a reply to read: only a thread where someone else wrote counts.
                const copies = box === ROUTE_TO ? TEAM_MAILBOXES.map(b => ' -from:' + b).join('') : '';
                const r = await gmail(token, 'threads?' + new URLSearchParams({ q: 'in:inbox is:unread newer_than:30d' + copies, maxResults: '50' }));
                // Opened in the Hub counts as read here, so the badge goes down when he reads a reply.
                const seen = new Set((await redis.smembers(IK.seen(box)).catch(() => [])) || []);
                const unread = (r.threads || []).filter(t => !seen.has(t.id)).length;
                await redis.set(IK.count(box), { unread }, { ex: 60 }).catch(() => {});
                return res.status(200).json({ ...base, unread });
            } catch (e) { return res.status(200).json(lapsed(e) ? { ...base, connected: false } : { ...base, error: 'Gmail could not be read just now' }); }
        }

        if (!connected) return res.status(200).json({ mailbox: box, connected: false, connectUrl: connectUrl('/inbox/') });

        if (req.method === 'GET' && q.view === 'list') {
            let token;
            try { token = await accessFor(box); } catch (e) { if (lapsed(e)) return res.status(200).json({ mailbox: box, connected: false, connectUrl: connectUrl('/inbox/') }); throw e; }
            const recs = await records();
            const seen = new Set((await redis.smembers(IK.seen(box)).catch(() => [])) || []);
            // The Prospects view reads up to four pages so an older prospect reply is not missed behind
            // notifications; All mail reads one page at a time with Load more.
            let page = q.page ? String(q.page) : null, rows = [], unreadable = 0, pages = 0;
            do {
                const r = await gmail(token, 'threads?' + new URLSearchParams({ q: 'in:inbox newer_than:60d', maxResults: '25', ...(page ? { pageToken: page } : {}) }));
                const threads = await inBatches(r.threads || [], t => gmail(token, 'threads/' + encodeURIComponent(t.id) + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Date').then(th => threadRow({ ...th, snippet: t.snippet }, box, recs)).catch(() => null));
                unreadable += threads.filter(x => !x).length;
                rows.push(...threads.filter(Boolean).filter(t => !q.prospects || t.prospect));
                page = r.nextPageToken || null; pages++;
            } while (q.prospects && page && pages < 4);
            rows = rows.map(t => ({ ...t, unread: t.unread && !seen.has(t.id), snippet: mask(t.snippet) }));
            return res.status(200).json({ mailbox: box, connected: true, threads: rows, nextPage: page, unreadable, complete: !page });
        }

        if (req.method === 'GET' && q.thread) {
            let token;
            try { token = await accessFor(box); } catch (e) { if (lapsed(e)) return res.status(200).json({ mailbox: box, connected: false, connectUrl: connectUrl('/inbox/?thread=' + String(q.thread)) }); throw e; }
            const th = await gmail(token, 'threads/' + encodeURIComponent(String(q.thread)) + '?format=full');
            const recs = await records();
            const row = threadRow(th, box, recs);
            await redis.sadd(IK.seen(box), String(th.id)).catch(() => {}); await redis.expire(IK.seen(box), 60 * 86400).catch(() => {}); await redis.del(IK.count(box)).catch(() => {});
            const messages = (th.messages || []).filter(notDraft).map(m => { const h = headersOf(m); return { id: m.id, from: nameOf(h.from), fromAddr: addrOf(h.from), mine: addrOf(h.from) === box, to: h.to || '', at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null, subject: h.subject || '', text: mask(messageText(m).slice(0, 20000)) }; });
            row.snippet = mask(row.snippet); row.replyable = !!(otherParty(th.messages || [], box) || {}).wrote;
            return res.status(200).json({ mailbox: box, thread: row, messages, gmailUrl: 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(box) + '#all/' + encodeURIComponent(th.id) });
        }

        if (req.method === 'POST') {
            if (req.headers.origin !== SITE) return res.status(403).json({ error: 'Invalid origin' });
            const input = readBody(req);
            if (input.action === 'clean') {
                const { status, body } = await cleanReply({ box, input, deps: { redis, access: b => accessFor(b), gmail, clean: cleanEmail } });
                return res.status(status).json(body);
            }
            if (input.action !== 'reply') return res.status(400).json({ error: 'Unknown action' });
            const { status, body } = await sendReply({ rep, box, input, deps: { redis, access: b => accessFor(b), gmail, isOptedOut, records: queueState, photo: b => photoUrlFor(b),
                stops: (row, addr) => stopsFor(row, addr, { kv: redis, isOptedOut, contact, reply: true }) } });
            return res.status(status).json(body);
        }
        return res.status(405).json({ error: 'Method not allowed' });
    } catch (e) {
        return res.status(503).json({ error: 'Your inbox could not be read just now. ' + String((e && e.message) || e).slice(0, 140) });
    }
}

/** The subject a reply goes out under: the thread's own, with one "Re:". */
export const replySubject = s => { const t = String(s || '').trim() || '(no subject)'; return /^re:/i.test(t) ? t : 'Re: ' + t; };
async function threadMeta(deps, token, threadId) {
    return deps.gmail(token, 'threads/' + encodeURIComponent(threadId) + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References');
}

/**
 * The cleanup on a reply. Only the body is cleaned: the subject stays the thread's own so Gmail
 * keeps the reply in the conversation. Stores the proof the send checks, like a new email's.
 */
export async function cleanReply({ box, input, deps, now = Date.now() }) {
    const threadId = String(input.threadId || '');
    const body = String(input.body || '').replace(/\r\n/g, '\n').trim();
    if (!/^[A-Za-z0-9]{6,40}$/.test(threadId)) return { status: 400, body: { reason: 'Which conversation?' } };
    if (body.length < 2) return { status: 400, body: { reason: 'Write the reply first.' } };
    if (body.length > LIMITS.body) return { status: 400, body: { reason: `Keep the reply under ${LIMITS.body} characters.` } };
    let token;
    try { token = await deps.access(box); } catch { return { status: 200, body: { connect: true, reason: `Connect your Gmail (${box}) again, then reply. Your reply is kept.` } }; }
    const th = await threadMeta(deps, token, threadId);
    const msgs = (th.messages || []).filter(notDraft);
    const subject = replySubject(headersOf(msgs[msgs.length - 1] || {}).subject);
    const day = dayOf(now), used = Number(await deps.redis.incr(K.cleans(box, day)).catch(() => 0)) || 0;
    if (used === 1) await deps.redis.expire(K.cleans(box, day), 3 * 86400).catch(() => {});
    const c = await deps.clean({ subject, body }, { ai: used <= 200 });
    await deps.redis.set(K.clean(box, subject, c.body), { at: new Date(now).toISOString(), by: c.by }, { ex: 6 * 3600 });
    return { status: 200, body: { subject, body: c.body, changes: c.changes || [], changed: c.body !== body, by: c.by, note: c.note || null, problem: copyProblem({ subject: 'Re', body: c.body }) } };
}

/**
 * A reply in a thread, from the rep's mailbox, with the signature. Every dependency passed in so the
 * path runs in a test without Google. Returns { status, body }.
 */
export async function sendReply({ rep, box, input, deps, now = Date.now() }) {
    const out = (status, body) => ({ status, body });
    const threadId = String(input.threadId || '');
    const body = String(input.body || '').replace(/\r\n/g, '\n').trim();
    const nonce = String(input.nonce || '');
    if (!/^[A-Za-z0-9]{6,40}$/.test(threadId)) return out(400, { sent: false, reason: 'Which conversation?' });
    if (!/^[A-Za-z0-9-]{8,64}$/.test(nonce)) return out(400, { sent: false, reason: 'Reload the page and try again. Nothing was sent.' });
    if (body.length < 2) return out(400, { sent: false, reason: 'Write the reply first.' });
    if (body.length > LIMITS.body) return out(400, { sent: false, reason: `Keep the reply under ${LIMITS.body} characters.` });

    let token;
    try { token = await deps.access(box); }
    catch { return out(200, { sent: false, connect: true, reason: `Connect your Gmail (${box}) again, then reply. Your reply is kept.` }); }
    const th = await threadMeta(deps, token, threadId);
    const msgs = (th.messages || []).filter(notDraft);
    const other = otherParty(msgs, box);
    if (!other || other.addr === box) return out(400, { sent: false, reason: 'There is nobody else in that conversation to reply to.' });
    // A reply is for someone who wrote in. A thread with only his own email is a new email: use the dialer.
    if (!other.wrote) return out(400, { sent: false, reason: 'They have not written back in this conversation. Send a new email from their card in the dialer instead.' });
    const problem = copyProblem({ subject: 'Re', body });
    if (problem) return out(400, { sent: false, reason: problem });
    const last = msgs[msgs.length - 1] || {};
    const lh = headersOf(last);
    const subject = replySubject(lh.subject);
    // The cleanup has to have run on exactly this reply (same store and key as a new email).
    if (!await deps.redis.get(K.clean(box, subject, body))) return out(409, { sent: false, review: true, reason: 'Every email is cleaned up before it goes. Press Send again to run it on this version.' });
    if (await deps.isOptedOut({ email: other.addr })) return out(200, { sent: false, reason: 'This person is on the do-not-contact list. Nothing was sent.' });
    const st0 = await deps.records().catch(() => null);
    if (!st0) return out(200, { sent: false, reason: 'The do-not-contact checks could not run just now. Nothing was sent.' });
    const recs0 = Array.isArray(st0) ? st0 : st0.records || [];
    // The queue's own suppression list outlives a record leaving the snapshot.
    if (!Array.isArray(st0) && (st0.suppressions || []).map(x => String(x).toLowerCase()).includes(other.addr)) return out(200, { sent: false, reason: 'This person is excluded from all outreach (Not interested / stop). Nothing was sent.' });
    const row0 = recs0.find(r => String(r.recipient || '').toLowerCase() === other.addr) || null;
    const stop = deps.stops ? await deps.stops(row0, other.addr).catch(() => 'The do-not-contact checks could not run just now.') : null;
    if (stop) return out(200, { sent: false, reason: stop + ' Nothing was sent.' });

    const day = dayOf(now);
    const today = Number(await deps.redis.get(K.count(box, day))) || 0;
    if (today >= LIMITS.perDay) return out(200, { sent: false, reason: `You have sent ${today} emails today, the daily limit for a new mailbox. Nothing was sent.` });
    const op = K.op(box, nonce);
    if (!await deps.redis.set(op, { status: 'sending', at: new Date(now).toISOString() }, { nx: true, ex: 86400 })) {
        const prior = await deps.redis.get(op);
        if (prior && prior.receipt) return out(200, { sent: true, repeat: true, ...prior.receipt });
        return out(200, { sent: false, reason: 'This reply was already sent or is still sending. Check your Gmail Sent folder before trying again.' });
    }
    const pending = await settlePending({ kv: deps.redis, gmail: deps.gmail, token, box, email: other.addr, rep });
    if (pending) { await deps.redis.del(op); return out(200, { sent: false, ...pending }); }
    const p = profileFor(box);
    const messageId = lh['message-id'] || '';
    const references = [lh.references, messageId].filter(Boolean).join(' ').trim();
    const signed = { phone: p.phone || null, photo: deps.photo ? await deps.photo(box).catch(() => null) : null };
    let mime;
    try { mime = buildMime({ from: box, fromName: p.name, to: other.addr, subject, text: body + '\n\n-- \n' + signatureText(box, signed), html: bodyHtml(body, signatureHtml(box, signed)), ...routeCopy(box, p.name), inReplyTo: messageId, references }); }
    catch { await deps.redis.del(op); return out(400, { sent: false, reason: 'That conversation has a header the Hub cannot reply to. Use Gmail for this one.' }); }
    let draft;
    try { draft = await deps.gmail(token, 'drafts', { message: { raw: rawOf(mime), threadId } }); }
    catch (e) { await deps.redis.del(op); return out(/failed 403/.test(String(e && e.message)) ? 200 : 502, { sent: false, connect: /failed 403/.test(String(e && e.message)), reason: 'Gmail would not take the reply, so nothing was sent. ' + String(e && e.message || '').slice(0, 120) }); }
    let sent;
    try { sent = await deps.gmail(token, 'drafts/send', { id: draft.id }); }
    catch { await deps.redis.set(op, { status: 'uncertain', at: new Date(now).toISOString(), draftId: draft.id }, { ex: 86400 }); await deps.redis.set(K.uncertain(box, other.addr), { draftId: draft.id, at: new Date(now).toISOString(), subject }, { ex: 86400 }).catch(() => {}); return out(502, { sent: false, uncertain: true, reason: 'Gmail did not confirm the send. Check your Sent folder before replying again.' }); }
    const rec = row0;
    const receipt = { at: new Date(now).toISOString(), by: rep.name || rep.email, from: box, to: other.addr, subject, messageId: sent.id || null, threadId: sent.threadId || threadId, reply: true, company: rec ? rec.company : null, recordId: rec ? rec.id : null };
    await deps.redis.set(op, { status: 'sent', receipt }, { ex: 86400 });
    await deps.redis.incr(K.count(box, day)).catch(() => {});
    await deps.redis.expire(K.count(box, day), 3 * 86400).catch(() => {});
    await deps.redis.lpush(K.sent(other.addr), JSON.stringify(receipt)).catch(() => {});
    await deps.redis.ltrim(K.sent(other.addr), 0, 19).catch(() => {});
    await deps.redis.del(IK.count(box)).catch(() => {});
    await recordActivity(deps.redis, { email: rep.email, kind: 'email_sent', page: '/inbox/', detail: other.addr, at: now });
    return out(200, { sent: true, ...receipt });
}
