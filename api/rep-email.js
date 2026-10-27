// Email a prospect from the call workspace, as the signed-in rep, with their signature.
// ------------------------------------------------------------------
// Paul, 2026-10-27: "milton needs to be able to send emails from here, they should be made with
// his signature." What the email says, who it is from and how it is signed live in _rep-email.js;
// this file decides whether it may go, sends it through the rep's own Gmail, and keeps a receipt.
//
//   GET  /api/rep-email/                     the rep's mailbox, connection, signature, templates
//   GET  /api/rep-email/?email=<prospect>    ...plus what has already been emailed to that person
//   GET  /api/rep-email/?action=connect      one-time Google consent for the rep's OWN mailbox
//   POST /api/rep-email/ {action:'clean',email,subject,body} -> the AI-cleaned text and what changed
//   POST /api/rep-email/ {email,subject,body,nonce} -> { sent, at, from, to, ... } | { sent:false, reason }
//
// Paul, 2026-10-27: "it should always take an ai pass at it and clean up any issues". The send
// only goes if this exact subject and body came out of the cleanup (api/_email-cleanup.js) in the
// last six hours. Edit a word afterwards and it is cleaned again before it can go.
//
// The rules that protect the person on the other end, the same ones the overview button keeps:
//   * The recipient must be a prospect in the call queue. The address is matched there, so the
//     button cannot be pointed at somebody else.
//   * The do-not-contact list, by email and by phone, and the client guard. A client is never
//     pitched, and a client check that could not answer is not a pass (api/_client-guard.js).
//   * Each compose window carries a nonce, so a double click or a retry never sends twice. A send
//     Gmail did not confirm is held, not retried: the rep checks Sent first.
//   * A daily cap per mailbox. These are new mailboxes on a cold-outreach domain.
import { redis, requireAccess, SITE, readBody, newToken, adminAuthorized } from './_auth.js';
import { KEY, visibleState, canUseCallQueue } from './_outreach-queue.js';
import { isOptedOut } from './_optout.js';
import { clientCheck } from './_client-guard.js';
import { recordActivity, dayOf } from './_hub-activity.js';
import { SCOPES, clientId, access, gmail } from './_outreach-gmail.js';
import { loginAliases } from './_login-aliases.js';
import { mailboxFor, profileFor, signatureHtml, signatureText, lineFor, templatesFor, copyProblem, LIMITS, bodyHtml, buildMime, rawOf } from './_rep-email.js';
import { cleanEmail } from './_email-cleanup.js';
import { createHash } from 'node:crypto';

const CALLBACK = SITE + '/api/outreach-connect/?action=callback';   // the redirect URI Google already knows
export const K = {
    op: (box, nonce) => `staffify:rep-email:op:${box}:${nonce}`,
    count: (box, day) => `staffify:rep-email:count:${box}:${day}`,
    sent: email => `staffify:rep-email:sent:${String(email || '').toLowerCase()}`,
    line: box => `staffify:rep-email:line:${box}`,
    clean: (box, subject, body) => `staffify:rep-email:clean:${box}:` + createHash('sha256').update(subject + '\n\n' + body).digest('hex').slice(0, 40),
    cleans: (box, day) => `staffify:rep-email:cleans:${box}:${day}`,
    token: box => `outreach:oauth:${box}`,
};
const json = v => { if (v == null) return null; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } } return v; };
const safeBack = b => (/^\/(?!\/)[\w\-./?=&%]*$/.test(String(b || '')) ? String(b) : '/dialer/');

/** The rep's Quo line for the signature, cached. Null when Quo cannot say for certain. */
async function quoLine(box, rep, { kv = redis, fetchImpl = fetch } = {}) {
    const cached = json(await kv.get(K.line(box)).catch(() => null));
    if (cached) return cached.line || null;
    const key = process.env.QUO_API_KEY || process.env.OPENPHONE_API_KEY;
    if (!key) return null;
    try {
        const r = await fetchImpl('https://api.openphone.com/v1/phone-numbers', { headers: { Authorization: key }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) return null;
        const line = lineFor((await r.json()).data || [], [box, ...loginAliases(rep && rep.email)]);
        await kv.set(K.line(box), { line, at: new Date().toISOString() }, { ex: line ? 12 * 3600 : 3600 }).catch(() => {});
        return line;
    } catch { return null; }
}

async function queueRow(email, kv = redis) {
    const state = await kv.get(KEY);
    return visibleState(state, 'all').records.find(r => String(r.recipient || '').toLowerCase() === email) || null;
}

const CLIENT_REASON = {
    client: 'This address belongs to a Staffify client, so nothing was sent.',
    possible: 'The company name matches an existing client. Paul checks these before anyone emails them, so nothing was sent.',
    unknown: 'The client check could not finish just now, so nothing was sent. Try again in a few minutes.',
};

/**
 * One send, with every dependency passed in so the whole path runs in a test without Google.
 * Returns { status, body } for the handler to write.
 */
export async function sendRepEmail({ rep, input, deps, now = Date.now() }) {
    const out = (status, body) => ({ status, body });
    const box = mailboxFor(rep);
    if (!box) return out(403, { sent: false, reason: 'No sending mailbox is set up for you yet. Ask Paul.' });
    const profile = profileFor(box);
    const email = String(input.email || '').trim().toLowerCase();
    const subject = String(input.subject || '').trim();
    const body = String(input.body || '').replace(/\r\n/g, '\n').trim();
    const nonce = String(input.nonce || '');
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return out(400, { sent: false, reason: 'Which prospect?' });
    if (!/^[A-Za-z0-9-]{8,64}$/.test(nonce)) return out(400, { sent: false, reason: 'Reload the page and try again. Nothing was sent.' });
    const problem = copyProblem({ subject, body });
    if (problem) return out(400, { sent: false, reason: problem });
    if (!await deps.redis.get(K.clean(box, subject, body))) return out(409, { sent: false, review: true, reason: 'Every email is cleaned up before it goes. Press Send again to run it on this version.' });

    const row = await deps.findRow(email);
    if (!row) return out(404, { sent: false, reason: 'That prospect is not in the call queue, so nothing was sent.' });
    const phone = (row.callContact && row.callContact.phone) || row.phone || '';
    if (await deps.isOptedOut({ email, phone })) return out(200, { sent: false, reason: 'This person is on the do-not-contact list. Nothing was sent.' });
    const client = await deps.clientCheck({ email, company: row.company }).catch(() => ({ status: 'unknown' }));
    if (client.status !== 'clear') return out(200, { sent: false, reason: CLIENT_REASON[client.status] || CLIENT_REASON.unknown });

    const kv = deps.redis, day = dayOf(now);
    const today = Number(await kv.get(K.count(box, day))) || 0;
    if (today >= LIMITS.perDay) return out(200, { sent: false, reason: `You have sent ${today} emails today, the daily limit for a new mailbox. Nothing was sent.` });

    // One send per compose window, whatever the network does.
    const op = K.op(box, nonce);
    if (!await kv.set(op, { status: 'sending', at: new Date(now).toISOString() }, { nx: true, ex: 86400 })) {
        const prior = json(await kv.get(op));
        if (prior && prior.receipt) return out(200, { sent: true, repeat: true, ...prior.receipt });
        return out(200, { sent: false, reason: 'This email was already sent or is still sending. Check your Gmail Sent folder before trying again.' });
    }

    let token;
    try { token = await deps.access(box); }
    catch (e) {
        await kv.del(op);
        const missing = /missing/i.test(String(e && e.message));
        return out(200, { sent: false, connect: true, reason: missing ? `Connect your Gmail (${box}) once, then send. Your message is kept.` : `Your Gmail connection needs renewing. Reconnect ${box}, then send. Your message is kept.` });
    }
    const line = await deps.line(box, rep).catch(() => null);
    const signed = { phone: line };
    const mime = buildMime({ from: box, fromName: profile.name, to: email, subject, text: body + '\n\n-- \n' + signatureText(box, signed), html: bodyHtml(body, signatureHtml(box, signed)) });

    let draft;
    try { draft = await deps.gmail(token, 'drafts', { message: { raw: rawOf(mime) } }); }
    catch (e) { await kv.del(op); return out(502, { sent: false, reason: 'Gmail would not take the message, so nothing was sent. ' + String(e && e.message || '').slice(0, 140) }); }
    if (!draft || !draft.id) { await kv.del(op); return out(502, { sent: false, reason: 'Gmail did not return a draft, so nothing was sent.' }); }

    let sent;
    try { sent = await deps.gmail(token, 'drafts/send', { id: draft.id }); }
    catch (e) {
        // Gmail may or may not have sent it. Never retried automatically.
        await kv.set(op, { status: 'uncertain', at: new Date(now).toISOString(), draftId: draft.id }, { ex: 86400 });
        return out(502, { sent: false, uncertain: true, reason: 'Gmail did not confirm the send. Check your Sent folder before sending again.' });
    }
    let verified = false;
    try {
        const m = await deps.gmail(token, 'messages/' + encodeURIComponent(sent.id) + '?format=metadata&metadataHeaders=To');
        const to = ((m.payload && m.payload.headers) || []).filter(h => /^to$/i.test(h.name)).map(h => String(h.value).toLowerCase()).join(',');
        verified = (m.labelIds || []).includes('SENT') && to.includes(email);
    } catch { /* sent is what drafts/send returned; the read-back is extra proof */ }

    const receipt = { at: new Date(now).toISOString(), by: rep.name || rep.email, from: box, to: email, subject, messageId: sent.id || null, threadId: sent.threadId || null, verified, company: row.company || null, recordId: row.id || null };
    await kv.set(op, { status: 'sent', receipt }, { ex: 86400 });
    await kv.incr(K.count(box, day)).catch(() => {});
    await kv.expire(K.count(box, day), 3 * 86400).catch(() => {});
    await kv.lpush(K.sent(email), JSON.stringify(receipt)).catch(() => {});
    await kv.ltrim(K.sent(email), 0, 19).catch(() => {});
    await kv.expire(K.sent(email), 400 * 86400).catch(() => {});
    await recordActivity(kv, { email: rep.email, kind: 'email_sent', page: '/dialer/', detail: email, at: now });
    return out(200, { sent: true, ...receipt });
}

const CLEANS_PER_DAY = 200;   // past this a mailbox gets the rules only, which still cost nothing
/** The cleanup pass. Stores what it returned so the send can prove the text went through it. */
export async function cleanRepEmail({ rep, input, deps, now = Date.now() }) {
    const box = mailboxFor(rep);
    if (!box) return { status: 403, body: { reason: 'No sending mailbox is set up for you yet. Ask Paul.' } };
    const subject = String(input.subject || '').trim(), body = String(input.body || '').replace(/\r\n/g, '\n').trim();
    if (!subject) return { status: 400, body: { reason: 'Add a subject.' } };
    if (body.replace(/^hi\b[^,\n]*,?/i, '').trim().length < 2) return { status: 400, body: { reason: 'Write the message first.' } };
    if (subject.length > LIMITS.subject || body.length > LIMITS.body) return { status: 400, body: { reason: 'That is longer than an email from the dialer can be.' } };
    const day = dayOf(now), used = Number(await deps.redis.incr(K.cleans(box, day)).catch(() => 0)) || 0;
    if (used === 1) await deps.redis.expire(K.cleans(box, day), 3 * 86400).catch(() => {});
    const c = await deps.clean({ subject, body }, { ai: used <= CLEANS_PER_DAY });
    await deps.redis.set(K.clean(box, c.subject, c.body), { at: new Date(now).toISOString(), by: c.by }, { ex: 6 * 3600 });
    return { status: 200, body: { subject: c.subject, body: c.body, changes: c.changes || [], changed: c.subject !== subject || c.body !== body, by: c.by, note: c.note || null, problem: copyProblem(c) } };
}

/** What the composer needs to draw. */
export async function repEmailStatus({ rep, email = '', kv = redis, line = quoLine }) {
    const box = mailboxFor(rep);
    if (!box) return { mailbox: null, reason: 'No sending mailbox is set up for you yet.' };
    const p = profileFor(box);
    const phone = await line(box, rep).catch(() => null);
    const prospect = String(email || '').trim().toLowerCase();
    const history = prospect ? (await kv.lrange(K.sent(prospect), 0, 4).catch(() => [])).map(json).filter(Boolean).map(r => ({ at: r.at, by: r.by, from: r.from, subject: r.subject })) : [];
    return {
        mailbox: box, name: p.name, title: p.title, phone: phone ? phone.display : null,
        connected: !!await kv.get(K.token(box)).catch(() => null),
        connectUrl: '/api/rep-email/?action=connect',
        signatureHtml: signatureHtml(box, { phone }),
        templates: templatesFor(box),
        me: p.first,
        sentToday: Number(await kv.get(K.count(box, dayOf()))) || 0,
        perDay: LIMITS.perDay,
        history,
    };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
        const rep = await requireAccess(req);
        if (!rep || !rep.email) return res.status(401).json({ error: 'Sign in to the Sales Hub' });
        const action = String(req.query && req.query.action || '');
        // Owners only: run the cleanup on a fixed sample, to prove the AI pass is live. Sends nothing,
        // reads no prospect, touches no rep's mailbox.
        if (req.method === 'GET' && action === 'check-cleanup') {
            if (!adminAuthorized(req) && rep.role !== 'admin') return res.status(403).json({ error: 'Owners only' });
            const c = await cleanEmail({ subject: 'quick follow up', body: "hi there,\n\ni wanted to here your thoughts — thanks for you're time today.\n\nMilton" });
            return res.status(200).json({ by: c.by, subject: c.subject, body: c.body, changes: c.changes, note: c.note || null, error: c.error || null });
        }
        if (rep.email === 'admin' || !canUseCallQueue(rep)) return res.status(403).json({ error: 'Sign in as the caller who is sending' });

        if (req.method === 'GET' && action === 'connect') {
            const box = mailboxFor(rep);
            if (!box) return res.status(403).json({ error: 'No sending mailbox is set up for you yet.' });
            if (!clientId()) return res.status(503).json({ error: 'Google sign-in is not configured on the server.' });
            const state = newToken();
            await redis.set('outreach:oauth-state:' + state, { email: box, rep: rep.email, returnTo: safeBack(req.query.back) }, { ex: 600 });
            const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            Object.entries({ client_id: clientId(), redirect_uri: CALLBACK, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', login_hint: box, state }).forEach(([k, v]) => url.searchParams.set(k, v));
            res.writeHead(302, { Location: url.toString() });
            return res.end();
        }
        if (req.method === 'GET') return res.status(200).json(await repEmailStatus({ rep, email: req.query && req.query.email }));
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (req.headers.origin !== SITE) return res.status(403).json({ error: 'Invalid origin' });

        const input = readBody(req);
        if (input.action === 'clean') {
            const { status, body } = await cleanRepEmail({ rep, input, deps: { redis, clean: cleanEmail } });
            return res.status(status).json(body);
        }
        const { status, body } = await sendRepEmail({
            rep, input,
            deps: { redis, findRow: e => queueRow(e), isOptedOut, clientCheck, access, gmail, line: (box, r) => quoLine(box, r) },
        });
        return res.status(status).json(body);
    } catch (e) {
        return res.status(503).json({ sent: false, reason: 'The email could not be sent. ' + String((e && e.message) || e).slice(0, 140) });
    }
}
