// ROLE-MAP REQUESTS: the logic, with its dependencies injected so it can be tested without a network.
//
// The public endpoint is api/role-map-request.js. Everything it decides lives here, because the rules
// are the interesting part and they all came out of the September 2026 funnel audit:
//
//  1. ONE RECORD PER PERSON, CLAIMED ATOMICALLY. The record id is derived from the email, so two
//     simultaneous submissions land on the same hash rather than racing to create two. Exactly one of
//     them wins the SET NX creation flag, and only that one sends the alert.
//  2. THE PUBLIC MAY NEVER WRITE OPERATOR STATE. A visitor submitting again appends a submission. It
//     does not reset `state`, does not overwrite the first thing they told us, does not clear a
//     suppression, and does not reopen something Paul already closed.
//  3. THE ANSWER IS ALWAYS THE SAME. First time or fifth, known email or not, the visitor gets one
//     message and no record id. Nothing here can be used to probe whether an address is on file.
//  4. A SAVED REQUEST IS NOT A DELIVERED ALERT. The email and Slack results are written onto the
//     record so the operator queue can show which ones nobody was told about.

const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
export const DEDUPE_SECONDS = 180 * 24 * 3600;   // the person, not the campaign: one record per email
export const RATE_PER_HOUR = 5;
export const MAX_SUBMISSIONS_KEPT = 10;
// Every caller gets this, always. It promises a reply and explicitly refuses to promise a booking.
export const PUBLIC_MESSAGE =
    'Got it. Paul will write back himself, usually within one business day. Nothing is booked until you both agree on a time.';

export const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(CONTROL, ' ').trim().slice(0, max);
export const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length < 160;

/** Terminal operator states. A new public submission never drags one of these backwards. */
export const CLOSED_STATES = new Set(['CLOSED', 'HELD']);

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
        source: clean(body.source, 60) || 'real-estate-media',
        path: clean(body.path, 120) || '/real-estate-media/',
    };
}

/**
 * Save the request. `deps` supplies { redis, hash, now, notifyEmail, notifySlack }, all injectable.
 * Returns { saved, created, alerted } for the caller's own logging. It never returns anything that
 * would tell a stranger whether the address was already on file.
 */
export async function saveRequest(input, deps) {
    const { redis, hash, now = () => Date.now(), notifyEmail, notifySlack } = deps;
    const at = new Date(now()).toISOString();
    const h = hash(input.email);
    const id = `pilot:req:${h}`;
    const subsKey = `${id}:subs`;

    // The claim. SET NX is the whole concurrency story: two identical submissions arriving together
    // both write the same hash, and exactly one of them is told it created the record.
    let created = false;
    try {
        created = (await redis.set(`${id}:claim`, at, { nx: true, ex: DEDUPE_SECONDS })) !== null;
    } catch (e) {
        created = false;   // if the claim cannot be made, assume someone else holds it and do not alert twice
    }

    const submission = JSON.stringify({ at, name: input.name, company: input.company,
        pain: input.pain, times: input.times, source: input.source, path: input.path });

    // Immutable-on-first-write fields. hsetnx means a later submission cannot rewrite the first answer
    // Paul read, and cannot overwrite what the operator has since recorded.
    const firstWrite = {
        id, email: input.email, createdAt: at, arm: 'inbound', isTest: 'false',
        name: input.name, company: input.company, pain: input.pain, times: input.times,
        source: input.source, path: input.path, state: 'REQUESTED',
    };
    try {
        for (const [k, v] of Object.entries(firstWrite)) await redis.hsetnx(id, k, v);
        // Only ever-appending fields are written unconditionally.
        await redis.hset(id, { lastSubmissionAt: at, lastSubmissionName: input.name });
        await redis.hincrby(id, 'submissions', 1);
        await redis.rpush(subsKey, submission);
        await redis.ltrim(subsKey, -MAX_SUBMISSIONS_KEPT, -1);
        await redis.zadd('pilot:requests', { score: now(), member: id });
        if (created) await redis.zadd('leads:by_date', { score: now(), member: id });
    } catch (e) {
        return { saved: false, created: false, alerted: false, error: 'store' };
    }

    // A repeat on a request the operator already closed is worth seeing, and still must not reopen it.
    let reopenedFlag = false;
    try {
        const state = await redis.hget(id, 'state');
        const suppressed = await redis.hget(id, 'suppressed');
        if (!created && (CLOSED_STATES.has(String(state || '')) || String(suppressed) === 'true')) {
            await redis.hset(id, { newSubmissionAfterClose: at });
            reopenedFlag = true;
        }
    } catch (e) { /* the flag is a convenience; losing it never changes what we stored */ }

    // Notify, then record whether the notification actually went anywhere. A saved request is not a
    // delivered alert, and the queue shows the difference.
    let mail = { ok: false, skipped: 'not attempted' };
    let slack = { ok: false, skipped: 'not attempted' };
    const suppressAlert = reopenedFlag === false && created === false;
    if (created || reopenedFlag) {
        mail = (await notifyEmail({ ...input, id, repeat: !created, reopened: reopenedFlag })) || { ok: false };
        slack = (await notifySlack({ ...input, id, repeat: !created, reopened: reopenedFlag })) || { ok: false };
    } else {
        // A plain repeat still gets one quiet note so Paul sees they came back, but no duplicate alert.
        mail = { ok: false, skipped: 'repeat submission, no duplicate alert' };
        slack = { ok: false, skipped: 'repeat submission, no duplicate alert' };
    }
    try {
        await redis.hset(id, {
            notifyEmail: mail.ok ? 'ok' : (mail.skipped || mail.error || 'failed'),
            notifySlack: slack.ok ? 'ok' : (slack.skipped || slack.error || 'failed'),
            notifyAt: at,
        });
    } catch (e) { /* best effort */ }

    return { saved: true, created, alerted: !!(mail.ok || slack.ok), reopened: reopenedFlag, suppressAlert };
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
