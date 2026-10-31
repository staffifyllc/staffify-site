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
//      ledger, or the webhook path's onboarding email). The desktop's hard-coded legal exclusion
//      (any address containing "haymes") is here too, with the Hub's named exclusions on the name.
//   5. First name: the customer's GivenName, else the first word of the customer name, else "there".
// Added here, all of them skips or flags and never a different recipient: the email must be one clear
// address that belongs to one QuickBooks customer, active or inactive, and not a sub-customer; the
// payer's record must be active; the payment must be more than zero; the count must read exactly one;
// a payer on the global opt-out list is flagged for a person instead of emailed.
//
// Sending is off unless PAYMENT_WELCOME_SEND is 'on'. Off, every run records exactly what it would
// send (payment-welcome:pending, 36 hours) and returns it. On, it refuses to send while LEAD_ID_SALT or
// RESEND_API_KEY is missing, while QB_WEBHOOK_VERIFIER_TOKEN is set (a second welcome path would be
// live), or until the Mac's sent log and suppression list are imported (scripts/seed-payment-welcome-
// ledger.mjs). Each send takes the person's claim first (api/_welcome-ledger.js), and is marked sent
// only after Resend accepts it.
//
// Go-live: the first run that is allowed to send records payment-welcome:live-since. Live runs only
// welcome payments QuickBooks created after that moment. Everything older is backfill: listed by
// ?view=backfill and sent only for customer ids Paul names (sendBackfill). Never automatically.
// live-since is kept when sending is turned off and on again, so a payment created while it was off
// (and still inside the 7-day window) goes out on the first live run after it comes back on.
//
// Schedule: the desktop's own, 9 AM, 1 PM and 6 PM Eastern. The cron fires at both UTC hours that can
// be each of those (summer and standard time) and a run outside them does nothing.
import { welcomeEmail, KIND, SUBJECT, FROM, REPLY_TO, HUBSPOT_BCC } from './_payment-welcome-copy.js';
import { EXCLUDED_NAMES } from './_rep-email-gates.js';
import { welcomeRecord, claimWelcome, markWelcomed, failWelcome, importWelcomed, retryExpired, emailHash, isHash, normEmail, SENT } from './_welcome-ledger.js';

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
    flags: 'payment-welcome:flags',
    flagged: 'payment-welcome:flagged',
    lock: 'payment-welcome:lock',
};
export const WINDOW_DAYS = 7;
export const BACKFILL_DAYS = 21;
// The Mac's QuickBooks token file was last rewritten 2026-09-29 (it rewrites on every rotation), so
// that is the last day the Mac is known to have read payments. Backfill never starts later than this,
// however long go-live takes.
export const BACKFILL_FLOOR = '2026-09-28';
export const RUN_HOURS_ET = [9, 13, 18];
export const BY = 'payment-welcome';
export const SEND_FLAG = 'PAYMENT_WELCOME_SEND';
export const DESKTOP_TASK = 'staffify-payment-welcome';
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
/** Backfill reaches back 21 days, and never later than the day the Mac stopped reading QuickBooks. */
export const backfillSince = now => { const d = sinceDate(now, BACKFILL_DAYS); return d < BACKFILL_FLOOR ? d : BACKFILL_FLOOR; };

/** Live or dry-run, and why live would refuse. Names only, never values. */
export function sendMode(env = process.env) {
    const live = String(env[SEND_FLAG] || '').trim().toLowerCase() === 'on';
    const missing = ['LEAD_ID_SALT', 'RESEND_API_KEY'].filter(k => !String(env[k] || '').trim());
    const blockers = env.QB_WEBHOOK_VERIFIER_TOKEN ? ['QB_WEBHOOK_VERIFIER_TOKEN is set, so the webhook welcome path is live too'] : [];
    const refused = !live ? null : missing.length ? 'missing ' + missing.join(', ') : blockers[0] || null;
    return { live, mode: live ? 'live' : 'dry-run', missing, blockers, refused };
}

/** Why the Mac seed is not good enough to go live, or null. An unreadable record is a refusal. */
export function seedProblem(imports, readError = null) {
    if (readError) return 'the desktop seed import could not be read';
    if (!imports || typeof imports !== 'object') return 'missing desktop seed import';
    if (!imports.suppressionList) return 'the desktop seed import has no suppression list';
    return null;
}

// sendMode plus the seed: live never sends until the Mac's sent log and suppression list are in Redis.
async function liveGate(kv, env) {
    const m = sendMode(env);
    let imports = null, readError = null;
    try { imports = parse(await kv.get(KEYS.imports)); } catch (e) { readError = msg(e); }
    const seed = seedProblem(imports, readError);
    const refused = m.refused || (m.live && seed) || null;
    return { ...m, refused, seed, imports };
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

/** The legal and named exclusions: the desktop's "haymes" address rule, and the Hub's names. */
export function doNotContact(pay, cust, email = '') {
    const c = cust || {};
    const text = [pay && pay.CustomerRef && pay.CustomerRef.name, c.DisplayName, c.CompanyName, c.FullyQualifiedName,
        (c.GivenName || '') + ' ' + (c.FamilyName || '')].map(v => String(v || '')).join(' ').toLowerCase().replace(/\s+/g, ' ');
    if (EXCLUDED_NAMES.some(n => text.includes(n))) return true;
    return String(email || '').toLowerCase().includes('haymes');
}

// The person, from the payment's own customer. Anything short of one clear address is a manual flag.
function describe(pay, cust, emailOwners) {
    const name = String((pay.CustomerRef && pay.CustomerRef.name) || (cust && cust.DisplayName) || '');
    const row = {
        customerId: String(pay.CustomerRef.value), name, paymentId: String(pay.Id || ''), paymentDate: pay.TxnDate || null,
        amount: Number(pay.TotalAmt), paymentCreatedAt: (pay.MetaData && pay.MetaData.CreateTime) || null, email: '', firstName: '',
    };
    const flag = (code, reason, decision = 'manual') => Object.assign(row, { decision, code, reason });
    if (!(row.amount > 0)) return flag('zero-amount', 'the payment amount is not above zero', 'skip');
    // Before any flag, so nobody on the do-not-contact list is ever put in front of a person to send by hand.
    if (doNotContact(pay, cust)) return flag('do-not-contact', 'on the do-not-contact list', 'skip');
    if (!cust) return flag('no-customer', 'no QuickBooks customer record for this payment');
    if (cust.Active === false) return flag('inactive-customer', 'the paying QuickBooks customer record is inactive; check this is not a past client on a new record');
    const raw = cust.PrimaryEmailAddr && cust.PrimaryEmailAddr.Address;
    if (!raw || !String(raw).trim()) return flag('no-email', 'FIRST payment but no email on QB customer - FLAG for manual');
    const email = normEmail(raw);
    row.email = email;
    if (doNotContact(pay, cust, email)) return flag('do-not-contact', 'on the do-not-contact list', 'skip');
    if (!ONE_ADDRESS.test(email)) return flag('unclear-email', 'the QuickBooks email is not one clear address');
    if ((emailOwners.get(email) || 0) > 1) return flag('shared-email', 'this email is on more than one QuickBooks customer, active or inactive');
    if ((cust.ParentRef && cust.ParentRef.value) || cust.Job === true) return flag('sub-customer', 'the payer is a sub-customer of another QuickBooks customer');
    row.firstName = String(cust.GivenName || name.split(/[\s,]+/)[0] || 'there').trim() || 'there';
    return Object.assign(row, { decision: 'send', code: 'first-payment', reason: 'first payment ever in QuickBooks' });
}

/** Which suppression rule matches, or null. 'opted-out' is the global do-not-contact list. */
async function suppressedBy(deps, email) {
    const { kv, optedOut } = deps;
    const domain = email.split('@')[1] || '';
    if (await kv.sismember(KEYS.suppressed, emailHash(email))) return 'desktop-list';
    if (domain && await kv.sismember(KEYS.suppressed, emailHash('@' + domain))) return 'desktop-list';
    const subs = (await kv.smembers(KEYS.substrings)) || [];
    if (subs.some(s => s && email.includes(String(s).toLowerCase()))) return 'desktop-list';
    // The handler's optedOut throws when the list cannot be read, so that is "unreadable", not a skip.
    if (optedOut && await optedOut(email)) return 'opted-out';
    return null;
}

// Redis gates, in the desktop's order: suppression, then already welcomed. Then the go-live gate.
async function gate(deps, row, { goLive, allowRetry = null }) {
    const { kv, now = Date.now() } = deps;
    const set = (decision, code, reason, extra = {}) => Object.assign(row, { decision, code, reason }, extra);
    try {
        const rule = await suppressedBy(deps, row.email);
        if (rule === 'opted-out') return set('manual', 'opted-out', 'this payer is on the global opt-out list, so the welcome never goes out on its own; Paul decides how onboarding reaches them');
        if (rule) return set('skip', 'suppressed', 'suppressed');
        // The webhook path's own mark first: its send may have gone out even if its ledger write did not.
        const sub = (await kv.hgetall('subscriber:' + row.email)) || {};
        if (sub.onboarding_email_sent_at) return set('skip', 'welcomed', 'already sent the onboarding email by the QuickBooks webhook path');
        const rec = await welcomeRecord(kv, row.email, KIND);
        if (rec.sent) return set('skip', 'welcomed', `already welcomed (${rec.sent.by || rec.sent.source || 'on record'})`, { welcomedAt: rec.sent.at || null });
        if (rec.claim) {
            const state = rec.claim.state;
            if (state === 'sent') return set('skip', 'welcomed', `already welcomed (${rec.claim.by})`, { welcomedAt: rec.claim.sentAt || rec.claim.at || null });
            if (state === 'failed') return set('manual', 'failed', 'two sends failed; a person decides what happens next');
            return set('manual', 'in-flight', `a send by ${rec.claim.by} was claimed and never confirmed; check Resend before anything else`);
        }
        if (retryExpired(rec.failures, now) && !(allowRetry && allowRetry.has(row.customerId))) {
            return set('manual', 'retry-expired', 'a send failed more than 23 hours ago, outside Resend\'s duplicate protection; check Resend first, then approve it with checkedResend', { failedAt: rec.failures.firstAt });
        }
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
export async function plan(deps, { windowDays = WINDOW_DAYS, since: sinceArg = null, goLive = null, onlyIds = null, allowRetry = null, salt = saltOf(deps.env) } = {}) {
    const { kv, query, now = Date.now() } = deps;
    const since = sinceArg || sinceDate(now, windowDays);
    const payments = await pages(query, `SELECT * FROM Payment WHERE TxnDate >= '${since}' ORDERBY TxnDate DESC`, 'Payment');
    // Inactive records too: a past client whose old record was made inactive and who pays first on a
    // new record with the same email is an existing client, not a new one.
    const customers = await pages(query, 'SELECT * FROM Customer WHERE Active IN (true, false)', 'Customer');
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
        if (!/^\d+$/.test(custId)) {
            const r = describe(pay, null, emailOwners);
            rows.push(r.code === 'do-not-contact' ? r : { ...r, decision: 'manual', code: 'odd-id', reason: 'the QuickBooks customer id is not numeric' });
            continue;
        }
        let total;
        try { total = Number((await query(`SELECT COUNT(*) FROM Payment WHERE CustomerRef = '${custId}'`)).QueryResponse.totalCount); }
        catch (e) { total = NaN; }
        if (total > 1) { existingClients++; await kv.sadd(KEYS.existing, custId); continue; }
        const row = describe(pay, byId.get(custId), emailOwners);
        if (total !== 1 && row.decision !== 'skip') Object.assign(row, { decision: 'manual', code: 'count-unreadable', reason: 'QuickBooks did not count exactly one payment for this customer' });
        if (row.decision === 'send') await gate(deps, row, { goLive, allowRetry });
        if (row.decision === 'send') {
            const mail = welcomeEmail({ to: row.email, firstName: row.firstName, salt });
            row.mail = { subject: SUBJECT, from: FROM, replyTo: REPLY_TO, bcc: HUBSPOT_BCC, lid: mail.lid, links: mail.links,
                ...(mail.lid ? {} : { lidNote: 'missing LEAD_ID_SALT: a live send adds utm_term=<lid> to the Calendly link' }) };
        }
        rows.push(row);
    }
    return { since, windowDays: Math.round((Date.parse(new Date(now).toISOString().slice(0, 10)) - Date.parse(since)) / 86400000), payments: payments.length, existingClients, rows };
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
        // The Mac's 600 ms between sends, taken before the claim so a crash in the gap holds nobody.
        if (!first) await sleep(gapMs);
        first = false;
        let slot;
        try { slot = await claimWelcome(kv, row.email, { by: BY, ref: `customer:${row.customerId}`, at }); }
        catch (e) { out.push({ ...brief(row), status: 'error', reason: 'the welcome claim could not be taken: ' + msg(e) }); continue; }
        if (!slot.ok) { out.push({ ...brief(row), status: 'skipped', reason: `already claimed by ${slot.holder.by} (${slot.holder.state})` }); continue; }
        const mail = welcomeEmail({ to: row.email, firstName: row.firstName, salt });
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
        } catch (e) {
            // Sent, and the claim still holds it, so nobody resends. The record is what is missing.
            out.push({ ...brief(row), status: 'sent-unrecorded', providerId, error: msg(e) }); continue;
        }
        let logError;
        try {
            await kv.lpush(KEYS.log, JSON.stringify({ at, ...brief(row), providerId }));
            await kv.ltrim(KEYS.log, 0, 199);
        } catch (e) { logError = msg(e); } // the send is recorded in the ledger; only the history line is missing
        out.push({ ...brief(row), status: 'sent', providerId, ...(logError ? { logError } : {}) });
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

/** What a person has to act on: every manual flag, and every send that did not go out cleanly. */
export const flagsOf = r => [
    ...(r.manual || []).map(x => ({ customerId: x.customerId, name: x.name, code: x.code, reason: x.reason })),
    ...(r.sent || []).filter(s => s.status !== 'sent' && s.status !== 'skipped')
        .map(s => ({ customerId: s.customerId, name: s.name, code: s.status, reason: s.error || s.reason || '' })),
];

// Live only. Each new customer and problem is kept in a history list and posted to Slack once; the
// same flag on the next run is not repeated. Best effort: the run's own result never depends on it.
async function recordFlags(deps, flags, at) {
    const { kv, notify } = deps;
    const out = [];
    for (const f of flags) {
        try {
            if (!await kv.sadd(KEYS.flagged, `${f.customerId}:${f.code}`)) continue;
            let notified = false;
            if (notify) {
                const r = await notify(`Payment welcome needs a person: ${f.name || 'a customer'} (QuickBooks customer ${f.customerId}). ${f.reason}\nhttps://www.gostaffify.com/api/payment-welcome/?view=status`).catch(() => null);
                notified = !!(r && r.ok);
            }
            await kv.lpush(KEYS.flags, JSON.stringify({ at, ...f, notified }));
            await kv.ltrim(KEYS.flags, 0, 199);
            out.push({ ...f, notified });
        } catch { /* the flag stays in last-run and pending */ }
    }
    return out;
}

/** The scheduled run. Dry-run unless PAYMENT_WELCOME_SEND is 'on' and nothing is missing. */
export async function scheduledRun(deps) {
    const { kv, env = process.env, now = Date.now() } = deps;
    const at = new Date(now).toISOString();
    const h = hourET(now);
    if (!RUN_HOURS_ET.includes(h)) return { status: 'skipped', at, reason: 'runs at 9 AM, 1 PM and 6 PM Eastern, like the desktop job' };
    return withLock(kv, async () => {
        const m = await liveGate(kv, env);
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
        result.newFlags = await recordFlags(deps, flagsOf(result), at);
        await kv.set(KEYS.pending, JSON.stringify(result), { ex: PENDING_TTL }).catch(() => {});
        await kv.set(KEYS.lastRun, JSON.stringify(summary(result)), { ex: LAST_RUN_TTL });
        return result;
    });
}

const summary = r => ({ at: r.at, mode: r.mode, refused: r.refused || null, window: r.window, goLive: r.goLive,
    counts: { payments: r.payments, existingClients: r.existingClients, wouldSend: (r.wouldSend || []).length, held: r.held.length, manual: r.manual.length, skipped: r.skipped.length,
        sent: (r.sent || []).filter(s => s.status === 'sent').length, failed: (r.sent || []).filter(s => s.status !== 'sent' && s.status !== 'skipped').length },
    flags: flagsOf(r) });

/** First-time payers since the backfill start with no welcome anywhere on record. Sends nothing, claims nobody. */
export async function backfillView(deps) {
    const { kv, now = Date.now() } = deps;
    const p = await plan(deps, { since: backfillSince(now), goLive: null });
    const imports = parse(await kv.get(KEYS.imports));
    const liveSince = await kv.get(KEYS.liveSince);
    const open = p.rows.filter(r => r.code !== 'welcomed');
    const seed = seedProblem(imports);
    return {
        at: new Date(now).toISOString(), window: { since: p.since, days: p.windowDays }, goLive: liveSince || null,
        seedImportedAt: (imports && imports.at) || null,
        ...(seed ? { warning: `${seed} (scripts/seed-payment-welcome-ledger.mjs). Until it is imported, this list can include people the Mac already welcomed or suppressed.` } : {}),
        sendable: open.filter(r => r.decision === 'send').map(r => ({ ...brief(r), firstName: r.firstName, mail: r.mail })),
        notSendable: open.filter(r => r.decision !== 'send').map(r => ({ ...brief(r), code: r.code, reason: r.reason })),
        alreadyWelcomed: p.rows.length - open.length, existingClients: p.existingClients, payments: p.payments,
        howToSend: "POST {action:'send-backfill', customerIds:[...]} with the ids you approve. For a retry-expired person, check Resend first, then add the id to checkedResend too. Nothing on this list is sent otherwise.",
    };
}

/** Welcome exactly the customers Paul names from the backfill list. Live mode only; dry-run shows it. */
export async function sendBackfill(deps, customerIds, { checkedResend = [] } = {}) {
    const { kv, env = process.env, now = Date.now() } = deps;
    const clean = list => [...new Set((Array.isArray(list) ? list : []).map(String))];
    const ids = clean(customerIds), checked = clean(checkedResend);
    if (!ids.length || ids.length > MAX_BACKFILL_IDS || !ids.every(i => /^\d+$/.test(i))) {
        return { status: 'invalid', error: `customerIds must be 1 to ${MAX_BACKFILL_IDS} QuickBooks customer ids` };
    }
    if (!checked.every(i => ids.includes(i))) return { status: 'invalid', error: 'checkedResend may only hold ids that are also in customerIds' };
    const m = await liveGate(kv, env);
    const at = new Date(now).toISOString();
    const run = async () => {
        const since = backfillSince(now);
        const p = await plan(deps, { since, goLive: null, onlyIds: new Set(ids), allowRetry: new Set(checked) });
        const found = new Map(p.rows.map(r => [r.customerId, r]));
        const notEligible = ids.filter(i => !found.has(i) || found.get(i).decision !== 'send').map(i => found.has(i)
            ? { ...brief(found.get(i)), code: found.get(i).code, reason: found.get(i).reason }
            : { customerId: i, reason: `not a first-time payer since ${since}` });
        const ready = p.rows.filter(r => r.decision === 'send');
        if (!m.live || m.refused) return { status: 'complete', at, mode: m.mode, ...(m.refused ? { refused: m.refused } : {}), wouldSend: ready, notEligible, sent: [] };
        const sent = await deliver(deps, ready, { at });
        const newFlags = await recordFlags(deps, flagsOf({ sent }), at);
        return { status: 'complete', at, mode: m.mode, sent, notEligible, newFlags };
    };
    return (!m.live || m.refused) ? run() : withLock(kv, run);
}

/**
 * The Mac's dedupe keys: sha256(normalised email) for each welcome in staffify-email-log.jsonl, and
 * its suppression list as hashes. Never raw addresses. suppressionList:true says the seed read the
 * Mac's suppression file; live sending waits for it. Imports add up: a later import never undoes one.
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
    const prev = parse(await kv.get(KEYS.imports));
    const prior = prev && typeof prev === 'object' ? prev : {};
    const listNow = body.suppressionList === true;
    const record = { at, source: String(body.source || 'desktop-log').slice(0, 40), welcomed: { added, kept, rejected }, suppressed: supHashes.length, substrings: supText.length,
        suppressionList: listNow || !!prior.suppressionList, suppressionListAt: listNow ? at : (prior.suppressionListAt || null), imports: (Number(prior.imports) || 0) + 1 };
    await kv.set(KEYS.imports, JSON.stringify(record));
    return { status: 'complete', ...record };
}

export async function statusView(deps) {
    const { kv, env = process.env } = deps;
    const m = await liveGate(kv, env);
    const [liveSince, watchSince, lastRun, ledger, flags] = await Promise.all([
        kv.get(KEYS.liveSince), kv.get(KEYS.watchSince), kv.get(KEYS.lastRun), kv.hlen(SENT), kv.lrange(KEYS.flags, 0, 24)]);
    const notReady = [...m.missing.map(k => 'missing ' + k), ...m.blockers, ...(m.seed ? [m.seed] : [])];
    return { mode: m.mode, sendFlag: SEND_FLAG, refused: m.refused, missing: m.missing, blockers: m.blockers, seed: m.seed,
        readyForLive: notReady.length === 0, notReady,
        goLive: liveSince || null, watchSince: watchSince || null,
        lastRun: parse(lastRun), seedImport: m.imports, welcomedOnRecord: Number(ledger) || 0,
        flags: (flags || []).map(parse),
        schedule: '9 AM, 1 PM and 6 PM Eastern, the desktop job\'s hours',
        desktopTask: `Disable the Mac task ${DESKTOP_TASK} in the same step as turning ${SEND_FLAG} on. It dedupes only against its own log, so both running means two welcomes.`,
        goLiveClock: 'live-since is kept when sending is turned off and on again: a payment created while it was off, still inside 7 days, goes out on the next live run.' };
}

/** The email as it would go out, for a sample name. */
export function previewHtml({ firstName = 'there', to = 'preview@example.com' } = {}) {
    const salt = saltOf(process.env);
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
