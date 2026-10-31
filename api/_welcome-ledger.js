// One welcome per person, whichever path sends it.
// ------------------------------------------------------------------
// Two code paths can welcome a new paying client:
//   api/payment-welcome.js     the cron port of the Mac's staffify-payment-welcome job (the approved
//                              "You're in. Book your strategy call." email)
//   api/_pilot-activation.js   the dormant QuickBooks webhook path (api/quickbooks-webhook.js), which
//                              answers 503 while QB_WEBHOOK_VERIFIER_TOKEN is unset
// Both take the SAME claim here before sending, so whichever claims first is the only one that writes
// to that person. The claim is SET NX with no expiry: a run that dies between claim and send leaves the
// person claimed, and a person decides what happens next. Fail closed; never a second email.
//
// Keys hold sha256(normalised email), never the address, so the Mac's sent log can be imported as
// hashes only (scripts/seed-payment-welcome-ledger.mjs) and nobody the Mac already emailed is
// welcomed twice.
//
//   welcome:claim:<kind>:<hash>   string  {token, by, ref, state: sending|sent|failed, at}
//   welcome:sent                  hash    <kind>:<hash> -> {at, by, source, providerId?, customerId?, email?}
//   welcome:failures              hash    <kind>:<hash> -> {n, firstAt, lastAt, error}: provider failures so far
//
// firstAt matters because Resend keeps an idempotency key for 24 hours. A retry inside that window
// with the same key cannot send twice; a retry after it can, if the first "failure" was a timeout on a
// send Resend actually accepted. So the sender stops retrying on its own once the first failure is
// older than RETRY_WINDOW_MS, and a person checks Resend first.
import { createHash, randomUUID } from 'node:crypto';

export const WELCOME_KIND = 'welcome-strategy-call';
export const SENT = 'welcome:sent';
export const FAILURES = 'welcome:failures';
export const MAX_ATTEMPTS = 2; // the desktop rule: report a failed send, retry it no more than once
export const RETRY_WINDOW_MS = 23 * 3600 * 1000; // inside Resend's 24-hour idempotency window

export const normEmail = e => String(e || '').trim().toLowerCase();
export const emailHash = e => createHash('sha256').update(normEmail(e)).digest('hex');
export const isHash = h => /^[0-9a-f]{64}$/.test(String(h || ''));
export const claimKey = (hash, kind = WELCOME_KIND) => `welcome:claim:${kind}:${hash}`;
const field = (hash, kind) => `${kind}:${hash}`;
const parse = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return { raw: String(v) }; } };

/** A failures field as {n, firstAt, lastAt, error}. A bare count (older shape) has no firstAt. */
export function failureOf(v) {
    if (v == null) return { n: 0, firstAt: null, lastAt: null, error: '' };
    if (typeof v === 'number' || /^\d+$/.test(String(v))) return { n: Number(v), firstAt: null, lastAt: null, error: '' };
    const o = parse(v) || {};
    return { n: Number(o.n) || 0, firstAt: o.firstAt || null, lastAt: o.lastAt || null, error: String(o.error || '') };
}

/** True when a person had a failed send and the automatic retry can no longer rely on Resend's key. */
export function retryExpired(failures, now = Date.now()) {
    if (!failures || !(failures.n >= 1)) return false;
    const first = Date.parse(failures.firstAt || '');
    return !(now - first <= RETRY_WINDOW_MS); // an unknown first time counts as expired: fail closed
}

/** What is on record for this person: the sent row, the claim and past failures. Throws if unreadable. */
export async function welcomeRecord(kv, email, kind = WELCOME_KIND) {
    const h = emailHash(email);
    const [sent, claim, failures] = await Promise.all([kv.hget(SENT, field(h, kind)), kv.get(claimKey(h, kind)), kv.hget(FAILURES, field(h, kind))]);
    return { hash: h, sent: parse(sent), claim: parse(claim), failures: failureOf(failures) };
}

/**
 * Take the person's welcome slot. {ok:true, token} when this caller now holds it, otherwise
 * {ok:false, holder}. With resume, a path that already holds the slot for the same ref and has not
 * finished gets back in: the webhook's redelivery of its own failed send, which its provider
 * idempotency key keeps to one email. The cron never resumes, so two overlapping runs send once.
 */
export async function claimWelcome(kv, email, { by, ref = '', kind = WELCOME_KIND, resume = false, at = new Date().toISOString() } = {}) {
    if (!by) throw Error('claimWelcome needs a path name');
    const key = claimKey(emailHash(email), kind);
    const token = randomUUID();
    const won = await kv.set(key, JSON.stringify({ token, by, ref: String(ref), state: 'sending', at }), { nx: true });
    if (won) return { ok: true, token };
    const holder = parse(await kv.get(key));
    if (!holder) throw Error('welcome claim could not be read');
    if (resume && holder.by === by && String(holder.ref) === String(ref) && holder.state === 'sending') return { ok: true, token: holder.token, resumed: true };
    return { ok: false, holder };
}

/** Record a send the provider accepted. Only the claim holder writes. */
export async function markWelcomed(kv, email, { token, by, kind = WELCOME_KIND, at = new Date().toISOString(), ...detail }) {
    const h = emailHash(email), key = claimKey(h, kind);
    const holder = parse(await kv.get(key));
    if (!holder || holder.token !== token) throw Error('welcome claim is no longer held by this send');
    await kv.hset(SENT, { [field(h, kind)]: JSON.stringify({ at, by, source: 'cloud', ...detail }) });
    await kv.set(key, JSON.stringify({ ...holder, state: 'sent', sentAt: at }));
}

/**
 * The provider refused or did not answer. Nothing is marked sent. The first failure lets the slot go so
 * the next run retries with the same provider idempotency key; the second keeps the slot as failed so
 * nothing retries again without a person.
 */
export async function failWelcome(kv, email, { token, kind = WELCOME_KIND, error = '', at = new Date().toISOString() }) {
    const h = emailHash(email), key = claimKey(h, kind), f = field(h, kind);
    // Only the claim holder gets here, so one writer per person at a time: read, add one, write.
    const prev = failureOf(await kv.hget(FAILURES, f));
    const attempts = prev.n + 1;
    await kv.hset(FAILURES, { [f]: JSON.stringify({ n: attempts, firstAt: prev.n ? prev.firstAt : at, lastAt: at, error: String(error).slice(0, 200) }) });
    const holder = parse(await kv.get(key));
    if (!holder || holder.token !== token) return { attempts, released: false };
    if (attempts < MAX_ATTEMPTS) { await kv.del(key); return { attempts, released: true }; }
    await kv.set(key, JSON.stringify({ ...holder, state: 'failed', failedAt: at, error: String(error).slice(0, 200) }));
    return { attempts, released: false };
}

/** Import one dedupe key from the Mac's log: the person counts as welcomed, and the slot is taken. */
export async function importWelcomed(kv, hash, { kind = WELCOME_KIND, at = null, ok = true, source = 'desktop-log', importedAt = new Date().toISOString() } = {}) {
    if (!isHash(hash)) throw Error('not a sha256 hex key');
    const f = field(hash, kind);
    const existing = parse(await kv.hget(SENT, f));
    if (!existing) await kv.hset(SENT, { [f]: JSON.stringify({ at, by: 'desktop', source, ok: ok !== false, importedAt }) });
    await kv.set(claimKey(hash, kind), JSON.stringify({ token: 'import', by: 'desktop', ref: source, state: 'sent', at: at || importedAt }), { nx: true });
    return !existing;
}
