// ROLE-MAP REQUESTS: the logic, with its dependencies injected so it can be tested without a network.
//
// The public endpoint is api/role-map-request.js. Everything it decides lives here, because the rules
// are the interesting part and they all came out of the September 2026 funnel audit:
//
//  1. ONE RECORD PER PERSON. The record id is derived from the email, so two simultaneous submissions
//     write the same hash rather than racing to create two, and every write is idempotent.
//  2. PERSIST FIRST, THEN CLAIM THE ALERT. An earlier cut claimed before writing, so a submission whose
//     write failed still burned the claim and the retry that finally persisted never alerted anyone.
//     The claim is now taken only after the data is safely down, so a failed write leaves nothing
//     behind and the retry alerts normally.
//  3. A CHANNEL THAT SUCCEEDED IS NEVER SENT AGAIN, AND ONE THAT FAILED IS NEVER FORGOTTEN. Email and
//     Slack are tracked separately. A later submission, or an operator pressing retry, re-attempts
//     only the channels that never got through.
//  4. THE PUBLIC MAY NEVER WRITE OPERATOR STATE. A visitor submitting again appends a submission. It
//     does not reset `state`, does not overwrite the first thing they told us, does not clear a
//     suppression, and does not reopen something Paul has closed.
//  5. THE ANSWER IS ALWAYS THE SAME. First time or fifth, known email or not, the visitor gets one
//     message and no record id. Nothing here can be used to probe whether an address is on file.

const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
export const DEDUPE_SECONDS = 180 * 24 * 3600;   // the person, not the campaign: one record per email
export const RATE_PER_HOUR = 5;
export const MAX_SUBMISSIONS_KEPT = 10;
export const PUBLIC_MESSAGE =
    'Got it. Paul will write back himself, usually within one business day. Nothing is booked until you both agree on a time.';

export const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(CONTROL, ' ').trim().slice(0, max);
export const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length < 160;

/** Terminal operator states. A new public submission never drags one of these backwards. */
export const CLOSED_STATES = new Set(['CLOSED', 'HELD']);

// ---------------------------------------------------------------------------------------------
// TELLING A HUMAN, AND BEING HONEST ABOUT WHETHER WE MANAGED IT.
//
// Two channels, each of which fails on its own, so each is tracked on its own. Before either is
// sent, the sender takes a short per-channel lease with SET NX. Two callers arriving together
// cannot both send, because only one can hold the lease, and the one that misses reports the
// channel as in flight rather than sending a second copy.
//
// WHAT WE CAN AND CANNOT PROMISE. Resend accepts an Idempotency-Key and keeps it for 24 hours, so
// a retried email inside that window is the same email, not a second one. Slack's chat.postMessage
// has no such key, so a Slack retry after an uncertain result may genuinely post twice. And a send
// that times out leaves us not knowing whether it arrived. None of those are called delivered and
// none of them are retried automatically: they are recorded as unknown, shown as unknown, and only
// a person pressing retry will try them again.
// ---------------------------------------------------------------------------------------------
export const CHANNELS = Object.freeze(['email', 'slack']);
const FIELD = { email: 'notifyEmail', slack: 'notifySlack' };
const AT_FIELD = { email: 'notifyEmailAt', slack: 'notifySlackAt' };
const LEASE_SECONDS = 45;                 // comfortably longer than the 10 second send timeout
export const UNKNOWN_PREFIX = 'unknown: ';
/** Only email has a provider-side idempotency guarantee, and only for 24 hours. */
export const IDEMPOTENT_CHANNELS = Object.freeze(['email']);

const isOk = (v) => v === 'ok';
const isUnknown = (v) => typeof v === 'string' && v.startsWith(UNKNOWN_PREFIX);

/**
 * Channels still owed an alert. A success is never re-sent. An unknown is not re-sent either,
 * unless a person explicitly asks for it, because we do not know that it failed.
 */
export function channelsNeeded(existing = {}, { includeUnknown = false } = {}) {
    return CHANNELS.filter((c) => {
        const v = existing[FIELD[c]];
        if (isOk(v)) return false;
        if (isUnknown(v)) return includeUnknown;
        return true;
    });
}

/**
 * What the queue should say.
 *   delivered  both got through
 *   partial    one got through, the other did not
 *   uncertain  nothing is known to have failed, but at least one result was never established
 *   failed     everything we tried was refused
 *   pending    nothing has been attempted yet
 */
export function notifyState(existing = {}) {
    const vals = CHANNELS.map((c) => existing[FIELD[c]]);
    const ok = vals.filter(isOk).length;
    const unknown = vals.filter(isUnknown).length;
    const tried = vals.filter((v) => !!v).length;
    if (ok === CHANNELS.length) return 'delivered';
    if (ok && unknown) return 'partial';
    if (ok) return 'partial';
    if (unknown) return 'uncertain';
    if (tried) return 'failed';
    return 'pending';
}

/** Merge results without ever downgrading a channel that already succeeded. */
export function mergeNotify(existing = {}, results = {}, at = new Date().toISOString()) {
    const patch = {};
    for (const c of CHANNELS) {
        const r = results[c];
        if (!r || r.skippedBecauseInFlight) continue;
        if (isOk(existing[FIELD[c]])) continue;               // already delivered, leave it alone
        patch[FIELD[c]] = r.ok ? 'ok'
            : r.unknown ? UNKNOWN_PREFIX + (r.error || 'the send did not answer')
            : (r.skipped || r.error || 'failed');
        patch[AT_FIELD[c]] = at;
    }
    return patch;
}

/** A stable key per alert per channel, so a retried email is the same email to the provider. */
export const idempotencyKey = (id, channel, kind = 'first') => `rolemap/${id}/${channel}/${kind}`;

const LEASE_RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

async function takeLease(redis, key, token) {
    try { return (await redis.set(key, token, { nx: true, ex: LEASE_SECONDS })) !== null; }
    catch (e) { return false; }           // if the lease cannot be taken, do not send
}
async function dropLease(redis, key, token) {
    // Token checked, so releasing never destroys a successor's lease. If eval is unavailable the
    // lease simply expires, which is slower but never wrong.
    try { if (typeof redis.eval === 'function') await redis.eval(LEASE_RELEASE, [key], [token]); }
    catch (e) { /* let it expire */ }
}

/**
 * Hand the leases back, AFTER the results are durable.
 *
 * Releasing at the end of a send instead opens a window: between the release and the write, the
 * record still shows no result, so the next caller reads a gap that is not there and sends again.
 * A test with one slow channel and one fast one caught exactly that. So the lease is held from
 * before the send until after the answer is written down.
 *
 * A channel whose result is unknown keeps its lease until it expires, so nothing piles straight
 * back onto a send we are not sure about.
 */
export async function releaseLeases(redis, leases = []) {
    for (const l of leases) {
        if (l.unknown) continue;
        await dropLease(redis, l.key, l.token);
    }
}

/**
 * Send only what is owed, one lease per channel. Returns a result per channel attempted, plus the
 * channels that were skipped because someone else already had them in flight.
 */
export async function sendNeeded(id, existing, payload, deps, { includeUnknown = false, kind = 'first' } = {}) {
    const { redis, notifyEmail, notifySlack, token = () => Math.random().toString(36).slice(2, 12) } = deps;
    const send = { email: notifyEmail, slack: notifySlack };
    const needed = channelsNeeded(existing, { includeUnknown });
    const results = {}, attempted = [], inFlight = [], leases = [], settled = [];
    for (const c of needed) {
        const key = `${id}:lease:${c}:${kind}`;
        const tk = token();
        if (!(await takeLease(redis, key, tk))) { inFlight.push(c); results[c] = { skippedBecauseInFlight: true }; continue; }
        // Holding the lease, look again. `existing` was read before any of this started, and in the
        // time since, another caller may have finished this very channel and handed the lease back.
        // Taking the lease is what makes this second look authoritative.
        let now = existing[FIELD[c]];
        try { if (typeof redis.hget === 'function') now = await redis.hget(id, FIELD[c]); } catch (e) { /* keep the snapshot */ }
        const stillNeeded = channelsNeeded({ [FIELD[c]]: now }, { includeUnknown }).includes(c);
        if (!stillNeeded) {
            results[c] = { skippedBecauseInFlight: true };    // someone else already did it
            settled.push(c);
            await dropLease(redis, key, tk);
            continue;
        }
        let r;
        try {
            r = (await send[c]({ ...payload, idempotencyKey: idempotencyKey(id, c, kind) })) || { ok: false, error: 'no result' };
        } catch (e) {
            // We asked, and never found out. That is not a failure and must not be treated as one.
            r = { ok: false, unknown: true, error: String((e && e.message) || e).slice(0, 120) };
        }
        results[c] = r; attempted.push(c);
        leases.push({ channel: c, key, token: tk, unknown: !!r.unknown });
    }
    return { needed, attempted, inFlight, settled, results, leases };
}

export function parseRequest(body = {}) {
    const name = clean(body.name, 80);
    const email = clean(body.email, 160).toLowerCase();
    if (clean(body.website, 200)) return { bot: true };
    if (!name) return { error: 'Your name, so Paul knows who he is writing back to.' };
    if (!validEmail(email)) return { error: 'That email does not look right.' };
    return {
        name, email,
        company: clean(body.company, 120),
        pain: clean(body.pain, 1200),
        times: clean(body.times, 200),
        source: clean(body.utmSource, 60) || clean(body.source, 60) || 'real-estate-media',
        path: clean(body.path, 120) || '/real-estate-media/',
        // Full attribution, captured once at the form and carried all the way into the CRM note and
        // the deal. Before this the form kept utm_source and dropped everything else, so a booking
        // could never be traced back to what brought them.
        utmSource: clean(body.utmSource, 60),
        utmMedium: clean(body.utmMedium, 60),
        utmCampaign: clean(body.utmCampaign, 80),
        utmContent: clean(body.utmContent, 80),
        utmTerm: clean(body.utmTerm, 80),
        referrer: clean(body.referrer, 200),
        landingPath: clean(body.landingPath, 160),
        lid: clean(body.lid, 60),
    };
}

/**
 * Save the request, then make sure someone is told. `deps` supplies
 * { redis, hash, now, notifyEmail, notifySlack }, all injectable.
 * Returns { saved, created, alerted, reopened } for the caller's own logging, and nothing that would
 * tell a stranger whether the address was already on file.
 */
export async function saveRequest(input, deps) {
    const { redis, hash, now = () => Date.now(), notifyEmail, notifySlack } = deps;
    const at = new Date(now()).toISOString();
    const h = hash(input.email);
    const id = `pilot:req:${h}`;
    const subsKey = `${id}:subs`;

    const submission = JSON.stringify({ at, name: input.name, company: input.company,
        pain: input.pain, times: input.times, source: input.source, path: input.path });

    // Immutable-on-first-write fields. hsetnx means a later submission cannot rewrite the first answer
    // Paul read, and cannot overwrite what the operator has since recorded.
    const firstWrite = {
        id, email: input.email, createdAt: at, arm: 'inbound', isTest: 'false',
        name: input.name, company: input.company, pain: input.pain, times: input.times,
        source: input.source, path: input.path, state: 'REQUESTED',
        // Attribution belongs to the first submission. A later one appends rather than rewriting it,
        // so the campaign that actually earned the inquiry is the one on the record.
        utmSource: input.utmSource, utmMedium: input.utmMedium, utmCampaign: input.utmCampaign,
        utmContent: input.utmContent, utmTerm: input.utmTerm,
        referrer: input.referrer, landingPath: input.landingPath, lid: input.lid,
        syncState: 'pending', owner: 'Paul',
    };
    try {
        for (const [k, v] of Object.entries(firstWrite)) await redis.hsetnx(id, k, v);
        await redis.hset(id, { lastSubmissionAt: at, lastSubmissionName: input.name });
        await redis.hincrby(id, 'submissions', 1);
        await redis.rpush(subsKey, submission);
        await redis.ltrim(subsKey, -MAX_SUBMISSIONS_KEPT, -1);
        await redis.zadd('pilot:requests', { score: now(), member: id });
        await redis.zadd('leads:by_date', { score: now(), member: id });
    } catch (e) {
        // Nothing is claimed, so a retry starts from a clean slate and still alerts.
        return { saved: false, created: false, alerted: false, error: 'store' };
    }

    // The data is down, so the inquiry cannot be lost. The CRM sync is queued rather than run here:
    // a HubSpot outage must delay the link, never the acknowledgement the person is waiting on.
    let queued = false;
    if (deps.enqueueSync) {
        const q = await deps.enqueueSync(redis, id);
        queued = !!(q && q.ok);
    }

    // The data is down. Only now is the first alert claimed, and only one caller can win it.
    let created = false;
    try {
        created = (await redis.set(`${id}:alerted`, at, { nx: true, ex: DEDUPE_SECONDS })) !== null;
    } catch (e) {
        created = false;   // if the claim cannot be taken, assume someone else has it rather than double-alert
    }

    // A repeat on a request the operator already closed is worth seeing, and still must not reopen it.
    let reopened = false;
    let existing = {};
    try {
        existing = (await redis.hgetall(id)) || {};
        if (!created && (CLOSED_STATES.has(String(existing.state || '')) || String(existing.suppressed) === 'true')) {
            await redis.hset(id, { newSubmissionAfterClose: at });
            reopened = true;
        }
    } catch (e) { /* the flag is a convenience; losing it never changes what we stored */ }

    // The per-channel lease is the concurrency control. Two callers arriving together cannot both
    // send, because only one holds the lease; the other reports the channel in flight. A later
    // repeat sends only what an earlier attempt left unfinished, and never what already landed.
    const payload = { ...input, id, repeat: !created, reopened };
    const { attempted, inFlight, settled, results, leases } = await sendNeeded(id, existing, payload,
        { redis, notifyEmail, notifySlack });
    const patch = mergeNotify(existing, results, at);
    if (reopened) {
        // A reopen is its own event, so it gets its own line rather than overwriting the first alert's.
        const r = results.email || results.slack || null;
        patch.reopenAlertAt = at;
        patch.reopenAlert = r && !r.skippedBecauseInFlight
            ? (r.ok ? 'ok' : r.unknown ? 'unknown' : (r.skipped || r.error || 'failed'))
            : 'not attempted';
    }
    let recorded = true;
    if (Object.keys(patch).length) {
        try { await redis.hset(id, patch); } catch (e) { recorded = false; }
    }
    // Only now, with the answer durable, is the lease handed back.
    await releaseLeases(redis, recorded ? leases : leases.map((l) => ({ ...l, unknown: true })));
    const after = { ...existing, ...patch };
    const state = notifyState(after);
    return {
        saved: true, created, reopened, attempted, inFlight, settled, queuedForCrm: queued,
        // If a send succeeded and we could not write that down, the stored state is behind reality and
        // saying otherwise would be a lie. The caller is told, so it can be reported rather than hidden.
        notifyState: recorded ? state : 'uncertain',
        resultsRecorded: recorded,
        alerted: recorded && (state === 'delivered' || state === 'partial'),
    };
}

/**
 * Operator-triggered retry. Re-sends only the channels that never got through, so a successful
 * delivery can never be duplicated by pressing the button.
 */
export async function retryAlert(id, deps) {
    const { redis, notifyEmail, notifySlack, now = () => Date.now() } = deps;
    let existing = null;
    try { existing = await redis.hgetall(id); } catch (e) { return { ok: false, error: 'could not read that request' }; }
    if (!existing || !existing.email) return { ok: false, error: 'no such request' };

    // A person asked, so an unknown is worth trying again. What that costs is stated plainly: the
    // email is deduplicated by Resend for 24 hours after the first attempt, and Slack is not
    // deduplicated at all, so a Slack retry after an uncertain result may post a second message.
    const needed = channelsNeeded(existing, { includeUnknown: true });
    if (!needed.length) {
        return { ok: true, state: notifyState(existing), attempted: [], inFlight: [],
            note: 'both channels already got through, so nothing was sent again' };
    }
    const at = new Date(now()).toISOString();
    const { attempted, inFlight, settled, results, leases } = await sendNeeded(id, existing,
        { name: existing.name, email: existing.email, company: existing.company,
            pain: existing.pain, times: existing.times, id, repeat: true },
        { redis, notifyEmail, notifySlack }, { includeUnknown: true });
    if (!attempted.length) {
        return { ok: true, state: notifyState(existing), attempted: [], inFlight,
            note: 'another retry is already in flight for ' + inFlight.join(' and ') };
    }
    const patch = mergeNotify(existing, results, at);
    if (Object.keys(patch).length) {
        try { await redis.hset(id, patch); }
        catch (e) {
            // The lease is deliberately left to expire, so nothing retries straight over the top of a
            // send whose result we could not write down.
            return { ok: true, state: 'uncertain', attempted, inFlight, resultsRecorded: false,
                error: 'the retry ran but the result could not be written down, so the stored state may be behind' };
        }
    }
    await releaseLeases(redis, leases);
    const retried = attempted.filter((c) => !IDEMPOTENT_CHANNELS.includes(c) && isUnknown(existing[FIELD[c]]));
    return {
        ok: true, state: notifyState({ ...existing, ...patch }), attempted, inFlight, settled, resultsRecorded: true,
        ...(retried.length ? { caution: 'retried ' + retried.join(' and ') + ' after an uncertain result, and '
            + retried.join(' and ') + ' has no provider-side duplicate protection, so a second message is possible' } : {}),
    };
}

/** Rate limit by a hashed IP. A failure here never loses a real request. */
export async function withinRate(redis, ipHash, { perHour = RATE_PER_HOUR } = {}) {
    if (!ipHash) return true;
    try {
        const k = `rl:rolemap:${ipHash}`;
        const n = await redis.incr(k);
        if (n === 1) await redis.expire(k, 3600);
        return n <= perHour;
    } catch (e) { return true; }
}
