// Payment welcome: the cloud port of the Mac job staffify-payment-welcome.
// ------------------------------------------------------------------
// The Mac job (staffify-payment-welcome.js, 9:00 / 13:00 / 18:00 ET) has failed every run since about
// 2026-10-14 with invalid_grant: it refreshed its own QuickBooks token while the cloud owns the live
// token lineage. This reads QuickBooks through api/_qbo.js (qb:tokens, the one refresher) instead.
//
// Detection is the desktop's, step for step:
//   1. Payments with TxnDate in the last 7 days (UTC date), newest first.
//   2. One look per customer. A customer with more than one payment in QuickBooks, ever, is an
//      existing client paying a bi-weekly invoice and is skipped. Only a FIRST payment counts.
//   3. The recipient is the paying customer's own QuickBooks email (Customer.PrimaryEmailAddr). Nobody
//      else is ever written to.
//   4. Skip anyone suppressed, and anyone already welcomed (the Mac's log, imported as hashes, this
//      ledger, or the webhook path's onboarding email).
//   5. First name: the customer's GivenName, else the first word of the customer name, else "there".
// Added here, all of them skips and never a different recipient: the email must be one clear address
// that belongs to one QuickBooks customer and not a sub-customer, the payment must be more than zero,
// and the count must read exactly one.
//
// Sending is off unless PAYMENT_WELCOME_SEND is 'on'. Off, every run records exactly what it would
// send (payment-welcome:pending, 36 hours) and returns it. On, it refuses to send while LEAD_ID_SALT or
// RESEND_API_KEY is missing, or while QB_WEBHOOK_VERIFIER_TOKEN is set (a second welcome path would be
// live). Each send takes the person's claim first (api/_welcome-ledger.js), and is marked sent only
// after Resend accepts it.
//
// Go-live: the first run that is allowed to send records payment-welcome:live-since. Live runs only
// welcome payments QuickBooks created after that moment. Everything older is backfill: listed by
// ?view=backfill and sent only for customer ids Paul names (sendBackfill). Never automatically.
import { welcomeEmail, KIND, SUBJECT, FROM, REPLY_TO, HUBSPOT_BCC } from './_payment-welcome-copy.js';
import { leadIdSalt } from './_staffify-utm.js';
import { welcomeRecord, claimWelcome, markWelcomed, failWelcome, importWelcomed, emailHash, isHash, normEmail, SENT } from './_welcome-ledger.js';

export const KEYS = {
    pending: 'payment-welcome:pending',
    lastRun: 'payment-welcome:last-run',
    watchSince: 'payment-welcome:watch-since',
    liveSince: 'payment-welcome:live-since',
    existing: 'payment-welcome:existing-customers',
    suppressed: 'payment-welcome:suppressed',
    substrings: 'payment-welcome:suppress-substrings',
    imports: 'payment-welcome:imports',
    log: 'payment-welcome:log',
    lock: 'payment-welcome:lock',
};
export const WINDOW_DAYS = 7;
export const BACKFILL_DAYS = 21;
export const BY = 'payment-welcome';
export const SEND_FLAG = 'PAYMENT_WELCOME_SEND';
const PENDING_TTL = 36 * 3600;
const LAST_RUN_TTL = 30 * 86400;
const LOCK_SECONDS = 150; // longer than the function's 120s maxDuration
const MAX_BACKFILL_IDS = 25;
const ONE_ADDRESS = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;
const parse = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return v; } };
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const msg = e => String((e && e.message) || e).slice(0, 200);

// The salt comes from the run's own env, so a test or a dry run never reads the wrong one.
const saltOf = env => String((env || process.env).LEAD_ID_SALT || '').trim();

export const hourET = now => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date(now))) % 24;
/** The desktop's own window start: N days back, as a UTC date. */
export const sinceDate = (now, days) => new Date(now - days * 86400000).toISOString().slice(0, 10);

/** Live or dry-run, and why live would refuse. Names only, never values. */
export function sendMode(env = process.env) {
    const live = String(env[SEND_FLAG] || '').trim().toLowerCase() === 'on';
    const missing = ['LEAD_ID_SALT', 'RESEND_API_KEY'].filter(k => !String(env[k] || '').trim());
    const blockers = env.QB_WEBHOOK_VERIFIER_TOKEN ? ['QB_WEBHOOK_VERIFIER_TOKEN is set, so the webhook welcome path is live too'] : [];
    const refused = !live ? null : missing.length ? 'missing ' + missing.join(', ') : blockers[0] || null;
    return { live, mode: live ? 'live' : 'dry-run', missing, blockers, refused };
}

async function pages(query, sql, type) {
    const rows = [];
    for (let start = 1; start <= 10001; start += 1000) {
        const j = await query(`${sql} STARTPOSITION ${start} MAXRESULTS 1000`);
        const page = (j && j.QueryResponse && j.QueryResponse[type]) || [];
        rows.push(...page);
        if (page.length < 1000) return rows;
    }
    throw Error(`${type} pagination exceeded its limit`);
}

const brief = r => ({ customerId: r.customerId, name: r.name, email: r.email || null, paymentId: r.paymentId, paymentDate: r.paymentDate, amount: r.amount, paymentCreatedAt: r.paymentCreatedAt });

// The person, from the payment's own customer. Anything short of one clear address is a manual flag.
function describe(pay, cust, emailOwners) {
    const name = String((pay.CustomerRef && pay.CustomerRef.name) || (cust && cust.DisplayName) || '');
    const row = {
        customerId: String(pay.CustomerRef.value), name, paymentId: String(pay.Id || ''), paymentDate: pay.TxnDate || null,
        amount: Number(pay.TotalAmt), paymentCreatedAt: (pay.MetaData && pay.MetaData.CreateTime) || null, email: '', firstName: '',
    };
    const flag = (code, reason, decision = 'manual') => Object.assign(row, { decision, code, reason });
    if (!(row.amount > 0)) return flag('zero-amount', 'the payment amount is not above zero', 'skip');
    if (!cust) return flag('no-customer', 'no active QuickBooks customer record for this payment');
    const raw = cust.PrimaryEmailAddr && cust.PrimaryEmailAddr.Address;
    if (!raw || !String(raw).trim()) return flag('no-email', 'FIRST payment but no email on QB customer - FLAG for manual');
    const email = normEmail(raw);
    row.email = email;
    if (!ONE_ADDRESS.test(email)) return flag('unclear-email', 'the QuickBooks email is not one clear address');
    if ((emailOwners.get(email) || 0) > 1) return flag('shared-email', 'this email is on more than one QuickBooks customer');
    if ((cust.ParentRef && cust.ParentRef.value) || cust.Job === true) return flag('sub-customer', 'the payer is a sub-customer of another QuickBooks customer');
    row.firstName = String(cust.GivenName || name.split(/[\s,]+/)[0] || 'there').trim() || 'there';
    return Object.assign(row, { decision: 'send', code: 'first-payment', reason: 'first payment ever in QuickBooks' });
}

async function suppressed(deps, email) {
    const { kv, optedOut } = deps;
    const domain = email.split('@')[1] || '';
    if (await kv.sismember(KEYS.suppressed, emailHash(email))) return true;
    if (domain && await kv.sismember(KEYS.suppressed, emailHash('@' + domain))) return true;
    const subs = (await kv.smembers(KEYS.substrings)) || [];
    if (subs.some(s => s && email.includes(String(s).toLowerCase()))) return true;
    // isOptedOut fails closed: an unreadable do-not-contact list reads as suppressed.
    return optedOut ? !!(await optedOut(email)) : false;
}

// Redis gates, in the desktop's order: suppression, then already welcomed. Then the go-live gate.
async function gate(deps, row, { goLive }) {
    const { kv } = deps;
    const set = (decision, code, reason, extra = {}) => Object.assign(row, { decision, code, reason }, extra);
    try {
        if (await suppressed(deps, row.email)) return set('skip', 'suppressed', 'suppressed');
        const rec = await welcomeRecord(kv, row.email, KIND);
        if (rec.sent) return set('skip', 'welcomed', `already welcomed (${rec.sent.by || rec.sent.source || 'on record'})`, { welcomedAt: rec.sent.at || null });
        if (rec.claim) {
            const state = rec.claim.state;
            if (state === 'sent') return set('skip', 'welcomed', `already welcomed (${rec.claim.by})`, { welcomedAt: rec.claim.sentAt || rec.claim.at || null });
            if (state === 'failed') return set('manual', 'failed', 'two sends failed; a person decides what happens next');
            return set('manual', 'in-flight', `a send by ${rec.claim.by} was claimed and never confirmed; check Resend before anything else`);
        }
        const sub = (await kv.hgetall('subscriber:' + row.email)) || {};
        if (sub.onboarding_email_sent_at) return set('skip', 'welcomed', 'already sent the onboarding email by the QuickBooks webhook path');
    } catch (e) { return set('manual', 'unreadable', 'the suppression list or welcome ledger could not be read: ' + msg(e)); }
    if (goLive) {
        const created = Date.parse(row.paymentCreatedAt || '');
        if (!(created >= Date.parse(goLive))) return set('held', 'before-go-live', 'QuickBooks created this payment before go-live, so it is backfill: it is sent only if Paul approves it');
    }
    return row;
}

/**
 * Who paid for the first time in the window, and what happens to each. Reads QuickBooks and Redis,
 * writes only the existing-client cache (a customer with two payments never becomes a first payer).
 */
export async function plan(deps, { windowDays = WINDOW_DAYS, goLive = null, onlyIds = null, salt = saltOf(deps.env) } = {}) {
    const { kv, query, now = Date.now() } = deps;
    const since = sinceDate(now, windowDays);
    const payments = await pages(query, `SELECT * FROM Payment WHERE TxnDate >= '${since}' ORDERBY TxnDate DESC`, 'Payment');
    const customers = await pages(query, 'SELECT * FROM Customer', 'Customer');
    const byId = new Map(customers.map(c => [String(c.Id), c]));
    const emailOwners = new Map();
    for (const c of customers) { const e = normEmail(c.PrimaryEmailAddr && c.PrimaryEmailAddr.Address); if (e) emailOwners.set(e, (emailOwners.get(e) || 0) + 1); }
    const known = new Set(((await kv.smembers(KEYS.existing)) || []).map(String));
    const seen = new Set(), rows = [];
    let existingClients = 0;
    for (const pay of payments) {
        const custId = String((pay.CustomerRef && pay.CustomerRef.value) || '');
        if (!custId || seen.has(custId)) continue;
        seen.add(custId);
        if (onlyIds && !onlyIds.has(custId)) continue;
        if (known.has(custId)) { existingClients++; continue; }
        if (!/^\d+$/.test(custId)) { rows.push({ ...describe(pay, null, emailOwners), decision: 'manual', code: 'odd-id', reason: 'the QuickBooks customer id is not numeric' }); continue; }
        let total;
        try { total = Number((await query(`SELECT COUNT(*) FROM Payment WHERE CustomerRef = '${custId}'`)).QueryResponse.totalCount); }
        catch (e) { total = NaN; }
        if (total > 1) { existingClients++; await kv.sadd(KEYS.existing, custId); continue; }
        const row = describe(pay, byId.get(custId), emailOwners);
        if (total !== 1) Object.assign(row, { decision: 'manual', code: 'count-unreadable', reason: 'QuickBooks did not count exactly one payment for this customer' });
        if (row.decision === 'send') await gate(deps, row, { goLive });
        if (row.decision === 'send') {
            const mail = welcomeEmail({ to: row.email, firstName: row.firstName, salt });
            row.mail = { subject: SUBJECT, from: FROM, replyTo: REPLY_TO, bcc: HUBSPOT_BCC, lid: mail.lid, links: mail.links,
                ...(mail.lid ? {} : { lidNote: 'missing LEAD_ID_SALT: a live send adds utm_term=<lid> to the Calendly link' }) };
        }
        rows.push(row);
    }
    return { since, windowDays, payments: payments.length, existingClients, rows };
}

/** Claim, send, and record each person marked send. Two overlapping calls send once per person. */
export async function deliver(deps, rows, { salt = saltOf(deps.env), at = new Date().toISOString(), gapMs = 600 } = {}) {
    const { kv, send, sleep = sleepMs } = deps;
    const todo = rows.filter(r => r.decision === 'send');
    // Fail closed before anyone is claimed: a link without the shared lid cannot be traced back.
    if (!salt) return todo.map(r => ({ ...brief(r), status: 'refused', reason: 'missing LEAD_ID_SALT' }));
    const out = [];
    let first = true;
    for (const row of todo) {
        let slot;
        try { slot = await claimWelcome(kv, row.email, { by: BY, ref: `customer:${row.customerId}`, at }); }
        catch (e) { out.push({ ...brief(row), status: 'error', reason: 'the welcome claim could not be taken: ' + msg(e) }); continue; }
        if (!slot.ok) { out.push({ ...brief(row), status: 'skipped', reason: `already claimed by ${slot.holder.by} (${slot.holder.state})` }); continue; }
        const mail = welcomeEmail({ to: row.email, firstName: row.firstName, salt });
        if (!first) await sleep(gapMs);
        first = false;
        let providerId = '';
        try {
            const r = await send({ payload: mail.payload, idempotencyKey: `${BY}:${KIND}:${emailHash(row.email)}` });
            providerId = String((r && r.id) || '');
            if (!providerId) throw Error('Resend accepted the request but returned no message id');
        } catch (e) {
            const f = await failWelcome(kv, row.email, { token: slot.token, error: msg(e), at }).catch(() => ({ attempts: null, released: false }));
            out.push({ ...brief(row), status: 'failed', error: msg(e), attempts: f.attempts, willRetry: f.released });
            continue;
        }
        try {
            await markWelcomed(kv, row.email, { token: slot.token, by: BY, at, providerId, customerId: row.customerId, paymentId: row.paymentId, email: row.email });
            await kv.lpush(KEYS.log, JSON.stringify({ at, ...brief(row), providerId }));
            await kv.ltrim(KEYS.log, 0, 199);
        } catch (e) {
            // Sent, and the claim still holds it, so nobody resends. The record is what is missing.
            out.push({ ...brief(row), status: 'sent-unrecorded', providerId, error: msg(e) }); continue;
        }
        out.push({ ...brief(row), status: 'sent', providerId });
    }
    return out;
}

async function withLock(kv, fn) {
    const nonce = String(Date.now()) + Math.random();
    if (!await kv.set(KEYS.lock, nonce, { nx: true, ex: LOCK_SECONDS })) return { status: 'running', reason: 'another payment welcome run is in progress' };
    try { return await fn(); }
    finally { await kv.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", [KEYS.lock], [nonce]).catch(() => {}); }
}

const group = rows => ({
    wouldSend: rows.filter(r => r.decision === 'send'),
    held: rows.filter(r => r.decision === 'held').map(r => ({ ...brief(r), reason: r.reason })),
    manual: rows.filter(r => r.decision === 'manual').map(r => ({ ...brief(r), code: r.code, reason: r.reason })),
    skipped: rows.filter(r => r.decision === 'skip').map(r => ({ ...brief(r), code: r.code, reason: r.reason })),
});

/** The scheduled run. Dry-run unless PAYMENT_WELCOME_SEND is 'on' and nothing is missing. */
export async function scheduledRun(deps) {
    const { kv, env = process.env, now = Date.now() } = deps;
    const at = new Date(now).toISOString();
    const h = hourET(now);
    if (h < 8 || h > 20) return { status: 'skipped', at, reason: 'outside 8 AM to 8 PM Eastern' };
    return withLock(kv, async () => {
        const m = sendMode(env);
        await kv.set(KEYS.watchSince, at, { nx: true });
        const canSend = m.live && !m.refused;
        if (canSend) await kv.set(KEYS.liveSince, at, { nx: true });
        const [liveSince, watchSince] = await Promise.all([kv.get(KEYS.liveSince), kv.get(KEYS.watchSince)]);
        // Live: only what QuickBooks created after go-live. Dry-run: what arrived since the cloud started
        // watching, which is what a live run would have sent had it been on.
        const goLive = canSend ? liveSince : (liveSince || watchSince);
        let p;
        try { p = await plan(deps, { windowDays: WINDOW_DAYS, goLive }); }
        catch (e) {
            // QuickBooks unreadable is an error, never "nobody paid". Kept for ?view=status, then raised.
            await kv.set(KEYS.lastRun, JSON.stringify({ at, mode: m.mode, error: msg(e) }), { ex: LAST_RUN_TTL }).catch(() => {});
            throw e;
        }
        const g = group(p.rows);
        const base = { status: 'complete', at, mode: m.mode, ...(m.refused ? { refused: m.refused } : {}), missing: m.missing, window: { since: p.since, days: p.windowDays }, goLive: liveSince || null, watchSince, payments: p.payments, existingClients: p.existingClients };
        if (!canSend) {
            const result = { ...base, sent: [], ...g, note: liveSince ? undefined : 'Nothing is sent before go-live. Payments that arrive while this is in dry-run become backfill once sending is turned on.' };
            await kv.set(KEYS.pending, JSON.stringify(result), { ex: PENDING_TTL });
            await kv.set(KEYS.lastRun, JSON.stringify(summary(result)), { ex: LAST_RUN_TTL });
            return result;
        }
        const sent = await deliver(deps, g.wouldSend, { at });
        const result = { ...base, ...g, wouldSend: undefined, sent };
        await kv.set(KEYS.lastRun, JSON.stringify(summary(result)), { ex: LAST_RUN_TTL });
        return result;
    });
}

const summary = r => ({ at: r.at, mode: r.mode, refused: r.refused || null, window: r.window, goLive: r.goLive,
    counts: { payments: r.payments, existingClients: r.existingClients, wouldSend: (r.wouldSend || []).length, held: r.held.length, manual: r.manual.length, skipped: r.skipped.length,
        sent: (r.sent || []).filter(s => s.status === 'sent').length, failed: (r.sent || []).filter(s => s.status !== 'sent' && s.status !== 'skipped').length } });

/** First-time payers in the last 21 days with no welcome anywhere on record. Sends nothing, claims nobody. */
export async function backfillView(deps) {
    const { kv, now = Date.now() } = deps;
    const p = await plan(deps, { windowDays: BACKFILL_DAYS, goLive: null });
    const imports = parse(await kv.get(KEYS.imports));
    const liveSince = await kv.get(KEYS.liveSince);
    const open = p.rows.filter(r => r.code !== 'welcomed');
    return {
        at: new Date(now).toISOString(), window: { since: p.since, days: p.windowDays }, goLive: liveSince || null,
        seedImportedAt: (imports && imports.at) || null,
        ...(imports ? {} : { warning: 'The Mac sent log has not been imported (scripts/seed-payment-welcome-ledger.mjs). Until it is, this list can include people the Mac already welcomed.' }),
        sendable: open.filter(r => r.decision === 'send').map(r => ({ ...brief(r), firstName: r.firstName, mail: r.mail })),
        notSendable: open.filter(r => r.decision !== 'send').map(r => ({ ...brief(r), code: r.code, reason: r.reason })),
        alreadyWelcomed: p.rows.length - open.length, existingClients: p.existingClients, payments: p.payments,
        howToSend: "POST {action:'send-backfill', customerIds:[...]} with the ids you approve. Nothing on this list is sent otherwise.",
    };
}

/** Welcome exactly the customers Paul names from the backfill list. Live mode only; dry-run shows it. */
export async function sendBackfill(deps, customerIds) {
    const { kv, env = process.env, now = Date.now() } = deps;
    const ids = [...new Set((Array.isArray(customerIds) ? customerIds : []).map(String))];
    if (!ids.length || ids.length > MAX_BACKFILL_IDS || !ids.every(i => /^\d+$/.test(i))) {
        return { status: 'invalid', error: `customerIds must be 1 to ${MAX_BACKFILL_IDS} QuickBooks customer ids` };
    }
    const m = sendMode(env);
    const at = new Date(now).toISOString();
    const run = async () => {
        const p = await plan(deps, { windowDays: BACKFILL_DAYS, goLive: null, onlyIds: new Set(ids) });
        const found = new Map(p.rows.map(r => [r.customerId, r]));
        const notEligible = ids.filter(i => !found.has(i) || found.get(i).decision !== 'send').map(i => found.has(i)
            ? { ...brief(found.get(i)), code: found.get(i).code, reason: found.get(i).reason }
            : { customerId: i, reason: 'not a first-time payer in the last 21 days' });
        const ready = p.rows.filter(r => r.decision === 'send');
        if (!m.live || m.refused) return { status: 'complete', at, mode: m.mode, ...(m.refused ? { refused: m.refused } : {}), wouldSend: ready, notEligible, sent: [] };
        return { status: 'complete', at, mode: m.mode, sent: await deliver(deps, ready, { at }), notEligible };
    };
    return (!m.live || m.refused) ? run() : withLock(kv, run);
}

/**
 * The Mac's dedupe keys: sha256(normalised email) for each welcome in staffify-email-log.jsonl, and
 * optionally its suppression list as hashes. Never raw addresses.
 */
export async function importKeys(kv, body = {}, at = new Date().toISOString()) {
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const sup = Array.isArray(body.suppressed) ? body.suppressed : [];
    const subs = Array.isArray(body.substrings) ? body.substrings : [];
    if (keys.length > 5000 || sup.length > 5000 || subs.length > 50) return { status: 'invalid', error: 'too many keys in one import' };
    let added = 0, kept = 0, rejected = 0;
    for (const k of keys) {
        if (!k || k.kind !== KIND || !isHash(k.hash)) { rejected++; continue; }
        const when = typeof k.at === 'string' && !Number.isNaN(Date.parse(k.at)) ? k.at : null;
        (await importWelcomed(kv, k.hash, { kind: KIND, at: when, ok: k.ok !== false, importedAt: at })) ? added++ : kept++;
    }
    const supHashes = sup.filter(isHash);
    if (supHashes.length) await kv.sadd(KEYS.suppressed, ...supHashes);
    const supText = subs.map(s => String(s || '').trim().toLowerCase()).filter(s => s.length >= 3 && s.length <= 64);
    if (supText.length) await kv.sadd(KEYS.substrings, ...supText);
    const record = { at, source: String(body.source || 'desktop-log').slice(0, 40), welcomed: { added, kept, rejected }, suppressed: supHashes.length, substrings: supText.length };
    await kv.set(KEYS.imports, JSON.stringify(record));
    return { status: 'complete', ...record };
}

export async function statusView(deps) {
    const { kv, env = process.env } = deps;
    const m = sendMode(env);
    const [liveSince, watchSince, lastRun, imports, ledger] = await Promise.all([
        kv.get(KEYS.liveSince), kv.get(KEYS.watchSince), kv.get(KEYS.lastRun), kv.get(KEYS.imports), kv.hlen(SENT)]);
    return { mode: m.mode, sendFlag: SEND_FLAG, refused: m.refused, missing: m.missing, blockers: m.blockers, goLive: liveSince || null, watchSince: watchSince || null,
        lastRun: parse(lastRun), seedImport: parse(imports), welcomedOnRecord: Number(ledger) || 0,
        schedule: 'hourly at :17 from 8 AM to 8 PM Eastern' };
}

/** The email as it would go out, for a sample name. */
export function previewHtml({ firstName = 'there', to = 'preview@example.com' } = {}) {
    const salt = leadIdSalt();
    return welcomeEmail({ to, firstName: String(firstName).slice(0, 40), salt: salt || 'preview-only' }).html;
}

/** Resend, with the provider's own idempotency key so a retry inside 24 hours cannot send twice. */
export async function resendSend({ payload, idempotencyKey, apiKey, fetchImpl = fetch }) {
    if (!apiKey) throw Error('RESEND_API_KEY not set');
    const r = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': String(idempotencyKey).slice(0, 256) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(`Resend ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
}
