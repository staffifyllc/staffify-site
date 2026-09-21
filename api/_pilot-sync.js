// INBOUND REQUEST -> CRM, DURABLY, RESUMABLY, AND WITHOUT TRAMPLING ANYTHING.
//
// The inquiry is recorded and acknowledged before any of this runs, so a HubSpot outage can never
// lose one. Syncing happens afterwards, from a due-queue, and every step is checkpointed.
//
// Each rule below is here because of a specific way this goes wrong:
//
//  * THE WORKER'S STATUS IS NOT THE BUYER'S STATE. An earlier cut wrote `state: 'ok'` onto the
//    request and overwrote REQUESTED or BOOKED. The record only ever carries `syncState`. The
//    worker's own status is returned, never persisted under `state`.
//  * EVERY SIDE EFFECT IS CHECKPOINTED THE MOMENT IT HAPPENS. A crash after HubSpot created a task
//    must not create a second one on the retry, so the id is written before the next call is made.
//  * ok MEANS ALL OF IT. If the note or the task failed, the state is `partial` and it retries from
//    the checkpoint. It does not short-circuit forever on having a contact id.
//  * A FAILED LOOKUP IS NOT AN ABSENT CONTACT. `lookupContact` reports found, absent and failed
//    apart, and a failed one stops the job rather than creating a duplicate.
//  * NOTHING EXISTING IS OVERWRITTEN. Blank fields are filled; occupied ones are left alone.
//  * A CLIENT IS LINKED, NEVER PITCHED. A `possible` match is held for review rather than guessed.
//  * A WRITE WE COULD NOT RECORD IS NOT A SUCCESS. Persistence failures are returned, not swallowed.
//  * THE QUEUE SURVIVES A CRASH. Items live in a sorted set by due time and are leased, not popped,
//    so a worker that dies mid-item leaves it to be picked up when the lease expires. Backoff is
//    bounded and spread over hours, not six attempts burned in one pass.
//
// Everything is injected, so the tests drive these exact functions with fake transport.

export const DUE_KEY = 'pilot:sync:due';
export const RESPONSE_DUE_HOURS = 4;                 // Paul's service target, measured from the inquiry
export const MAX_ATTEMPTS = 6;
export const BACKOFF_SECONDS = [60, 300, 900, 3600, 4 * 3600, 12 * 3600];
const leaseKey = (id) => `${id}:sync:lease`;
const LEASE_SECONDS = 120;

export const SYNC_STATES = Object.freeze(['pending', 'partial', 'ok', 'skipped', 'failed', 'needs-reconcile']);

const iso = (t) => new Date(t).toISOString();
const nextDelay = (attempts) => BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length - 1)];

/** Put a request on the due queue. Safe to call twice: a sorted set holds one copy. */
export async function enqueueSync(redis, id, { at = Date.now() } = {}) {
    try {
        await redis.zadd(DUE_KEY, { score: at, member: id });
        await redis.hset(id, { syncState: 'pending', syncQueuedAt: iso(at) });
        return { ok: true };
    } catch (e) { return { ok: false, error: 'could not queue the sync' }; }
}

/** What Paul sees in the CRM: what they asked for, in their words, and where they came from. */
export function noteBody(r) {
    return [
        'Inbound role-map request from gostaffify.com/real-estate-media/',
        '',
        'What still comes back to them, in their words:',
        r.pain ? `"${r.pain}"` : '(they did not say)',
        '',
        r.times ? `They would talk, and suggested: ${r.times}` : 'They did not ask for a call.',
        '',
        'Attribution: ' + (attributionLine(r) || 'none recorded'),
        `Requested at ${r.createdAt || '(unknown)'}. This is a request, not a booking.`,
    ].join('\n');
}

export function attributionLine(r) {
    const bits = [];
    for (const [k, label] of [['utmSource', 'source'], ['utmMedium', 'medium'], ['utmCampaign', 'campaign'],
        ['utmContent', 'content'], ['utmTerm', 'term']]) {
        if (r[k]) bits.push(`${label}=${r[k]}`);
    }
    if (r.referrer) bits.push(`referrer=${r.referrer}`);
    if (r.landingPath) bits.push(`landing=${r.landingPath}`);
    if (r.lid) bits.push(`lid=${r.lid}`);
    return bits.join(' ');
}

/** Everything a finished sync must have. Missing any of it means partial, not ok. */
function whatIsMissing(r, { isClient }) {
    const missing = [];
    if (!r.crmContactId) missing.push('contact');
    if (!r.crmNoteId) missing.push('note');
    if (!r.crmTaskId) missing.push('task');
    if (!isClient && !r.crmDealId && !r.crmDealSkipped) missing.push('deal');
    return missing;
}

/**
 * DURABLE INTENT AROUND A CREATE THAT CANNOT BE UNDONE.
 *
 * A lease is not enough. If the process pauses long enough for the lease to expire, or dies between
 * a successful HubSpot create and writing down which object it made, the next run has no idea
 * whether it already created one. Retrying then is how you get two tasks on one contact.
 *
 * So the intent is written FIRST and survives everything. Afterwards there are exactly four cases:
 *   - the intent could not be written        nothing was attempted, retry freely
 *   - the remote refused                     nothing exists, clear the intent, retry freely
 *   - the remote succeeded and we saved       done, intent cleared
 *   - anything else                          something may exist out there. HOLD. Never retry blind.
 *
 * `classify` tells a refusal from an unknown: a transport failure or a 5xx is unknown, a 4xx is a no.
 */
export function classifyFailure(r) {
    const status = Number((r && r.status) || 0);
    if (!status) return 'unknown';                 // no status at all means the call never landed
    if (status >= 500 || status === 429) return 'unknown';
    return 'refused';
}

export async function withIntent({ name, save, read, remote, now }) {
    const token = `${now()}-${Math.random().toString(36).slice(2, 8)}`;
    const intentField = `intent_${name}`;
    const prior = read && read[intentField];
    if (prior) {
        // An intent is already on the record with no id beside it. Something may exist in HubSpot
        // that we never recorded. A person has to look; we will not guess.
        return { status: 'hold', reason: `a ${name} may already have been created in HubSpot on a previous run `
            + `(intent ${prior}) but its id was never recorded. Check the contact before retrying.` };
    }
    if (!(await save({ [intentField]: token, [`${intentField}_at`]: new Date(now()).toISOString() }))) {
        return { status: 'pending', reason: `the intent to create a ${name} could not be recorded, so nothing was attempted` };
    }
    let r;
    try { r = await remote(); }
    catch (e) {
        return { status: 'hold', reason: `the ${name} create did not answer, so it may or may not exist. `
            + `Check the contact in HubSpot before retrying.` };
    }
    if (r && r.ok && r.id) {
        let saved = false;
        for (let i = 0; i < 3 && !saved; i++) saved = await save({ [`crm${name}Id`]: String(r.id), [intentField]: '' });
        if (!saved) {
            return { status: 'hold', id: String(r.id),
                reason: `a ${name} was created in HubSpot (${r.id}) and the id could not be written down. `
                    + `Do not re-run this request until somebody has looked at the contact.` };
        }
        return { status: 'ok', id: String(r.id) };
    }
    const how = classifyFailure(r);
    if (how === 'refused') {
        await save({ [intentField]: '', [`crm${name}Error`]: String((r && (r.reason || r.detail)) || `${name} refused`) });
        return { status: 'refused', reason: String((r && (r.reason || r.detail)) || `${name} was refused`) };
    }
    return { status: 'hold', reason: `the ${name} create failed in a way that does not say whether it landed `
        + `(${(r && (r.reason || r.status)) || 'no detail'}). Check the contact in HubSpot before retrying.` };
}

/**
 * Sync one request, resuming from whatever already succeeded.
 * deps: { redis, hubspot, guard, optout, ownerId, now, token }
 * Returns { status: 'ok'|'partial'|'pending'|'skipped', retryable, reason, ... }. Never writes `state`.
 */
export async function syncRequest(id, deps) {
    const { redis, hubspot, guard, optout, ownerId = async () => '', now = () => Date.now(),
        token = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` } = deps;

    // One worker at a time per request, and only the holder may release it.
    const tk = token();
    let holding = false;
    try { holding = (await redis.set(leaseKey(id), tk, { nx: true, ex: LEASE_SECONDS })) !== null; }
    catch (e) { return { status: 'pending', retryable: true, reason: 'the sync lease could not be taken' }; }
    if (!holding) return { status: 'pending', retryable: true, reason: 'another sync is already running for this request' };

    const release = async () => {
        try {
            if (typeof redis.eval === 'function') {
                await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", [leaseKey(id)], [tk]);
            }
        } catch (e) { /* it expires on its own */ }
    };

    try {
        // Read UNDER the lease, so we resume from what is actually there right now.
        let r;
        try { r = await redis.hgetall(id); }
        catch (e) { return { status: 'pending', retryable: true, reason: 'the request could not be read' }; }
        if (!r || !r.email) return { status: 'skipped', retryable: false, reason: 'no such request' };

        const attempts = Number(r.syncAttempts || 0) + 1;
        // A checkpoint that cannot be written is a failure, not a quiet success: the next run would
        // otherwise repeat whatever we just did remotely.
        const save = async (patch) => {
            try { await redis.hset(id, patch); return true; }
            catch (e) { return false; }
        };
        const bump = (extra) => save({ syncAttempts: String(attempts), syncAt: iso(now()), ...extra });

        // 1. Opted out ends it before anything is written.
        let optedOut = false;
        try { optedOut = await optout({ email: r.email }); }
        catch (e) {
            await bump({ syncState: 'pending', syncError: 'the opt-out list could not be read' });
            return { status: 'pending', retryable: true, attempts, reason: 'the opt-out list could not be read' };
        }
        if (optedOut) {
            await bump({ syncState: 'skipped', syncReason: 'opted out', syncError: '' });
            return { status: 'skipped', retryable: false, attempts, reason: 'opted out' };
        }

        // 2. The client guard. Unknown retries. Possible is held for a person to look at.
        const client = await guard({ email: r.email, company: r.company });
        if (client.status === 'unknown') {
            await bump({ syncState: 'pending', syncError: client.why });
            return { status: 'pending', retryable: true, attempts, reason: client.why };
        }
        if (client.status === 'possible') {
            await bump({ syncState: 'skipped', syncReason: client.reason, needsReview: 'true', syncError: '' });
            return { status: 'skipped', retryable: false, attempts, needsReview: true, reason: client.reason };
        }
        const isClient = client.status === 'client';

        // 3. Contact. Checkpointed the instant we have an id.
        let contactId = r.crmContactId || '';
        if (!contactId) {
            const look = await hubspot.lookupContact({ email: r.email });
            if (look.status === 'failed') {
                await bump({ syncState: 'pending', syncError: `contact lookup failed (${look.why}); nothing was created` });
                return { status: 'pending', retryable: true, attempts, reason: `contact lookup failed: ${look.why}` };
            }
            if (look.status === 'found') {
                contactId = look.id;
                if (!(await save({ crmContactId: String(contactId), crmContactCreated: 'false' }))) {
                    await bump({ syncState: 'pending', syncError: 'the matched contact id could not be saved' });
                    return { status: 'pending', retryable: true, attempts, reason: 'the matched contact id could not be saved' };
                }
            } else {
                const parts = String(r.name || '').trim().split(/\s+/);
                const made = await withIntent({ name: 'Contact', save, read: r, now,
                    remote: () => hubspot.findOrCreateContact({ email: r.email, firstname: parts[0] || '',
                        lastname: parts.slice(1).join(' '), company: r.company }) });
                if (made.status === 'hold') {
                    await bump({ syncState: 'needs-reconcile', needsReview: 'true', syncError: made.reason });
                    return { status: 'hold', retryable: false, needsReview: true, attempts, reason: made.reason };
                }
                if (made.status !== 'ok') {
                    await bump({ syncState: 'pending', syncError: made.reason });
                    return { status: 'pending', retryable: true, attempts, reason: made.reason };
                }
                contactId = made.id;
            }
        }

        // 4. Fill only what is blank.
        if (!r.crmFilled) {
            const fill = await hubspot.fillBlankContactProps(contactId, { company: r.company });
            await save({ crmFilled: (fill && fill.filled ? fill.filled.join(',') : ''), crmFillError: fill && fill.ok ? '' : String((fill && fill.reason) || 'fill failed') });
        }

        // 5. Note.
        let noteId = r.crmNoteId || '';
        if (!noteId) {
            const made = await withIntent({ name: 'Note', save, read: r, now,
                remote: () => hubspot.logNote({ contactId, body: noteBody(r), at: now() }) });
            if (made.status === 'hold') {
                await bump({ syncState: 'needs-reconcile', needsReview: 'true', syncError: made.reason });
                return { status: 'hold', retryable: false, needsReview: true, attempts, reason: made.reason };
            }
            if (made.status === 'ok') noteId = made.id;
        }

        // 6. Deal, unless they are already a client.
        let dealId = r.crmDealId || '';
        let dealSkipped = r.crmDealSkipped || '';
        if (isClient && !dealSkipped) {
            dealSkipped = client.reason || 'already a client';
            if (!(await save({ crmDealSkipped: dealSkipped }))) {
                await bump({ syncState: 'pending', syncError: 'could not record why no deal was created' });
                return { status: 'pending', retryable: true, attempts, reason: 'could not record why no deal was created' };
            }
        } else if (!isClient && !dealId) {
            const made = await withIntent({ name: 'Deal', save, read: r, now,
                remote: async () => hubspot.upsertDeal({ contactId, company: r.company, motion: 'staffing',
                    ownerId: await ownerId(), stage: 'replied' }) });
            if (made.status === 'hold') {
                await bump({ syncState: 'needs-reconcile', needsReview: 'true', syncError: made.reason });
                return { status: 'hold', retryable: false, needsReview: true, attempts, reason: made.reason };
            }
            if (made.status === 'ok') dealId = made.id;
        }

        // 7. The task, due from when THEY asked, not from when this retry happened.
        let taskId = r.crmTaskId || '';
        const askedAt = Date.parse(r.createdAt || '') || now();
        const dueAt = askedAt + RESPONSE_DUE_HOURS * 3600 * 1000;
        if (!taskId) {
            const made = await withIntent({ name: 'Task', save, read: r, now,
                remote: async () => hubspot.createTask({
                    contactId, ownerId: await ownerId(),
                    subject: isClient
                        ? `Existing client asked about the role map: ${r.company || r.name}`
                        : `Answer the role-map request: ${r.company || r.name}`,
                    body: noteBody(r) + (isClient ? `\n\nNOTE: ${client.reason}. Do not pitch. Answer as their provider.` : ''),
                    dueAt,
                }) });
            if (made.status === 'hold') {
                await bump({ syncState: 'needs-reconcile', needsReview: 'true', syncError: made.reason });
                return { status: 'hold', retryable: false, needsReview: true, attempts, reason: made.reason };
            }
            if (made.status === 'ok') { taskId = made.id; await save({ crmTaskDueAt: iso(dueAt) }); }
            if (made.status === 'refused' && /no_owner/.test(made.reason || '')) {
                // Visible, and blocking. An unowned task would look like work assigned to Paul.
                await bump({ syncState: 'partial', syncError: 'no HubSpot owner is mapped for the pilot, so no task was created' });
                return { status: 'partial', retryable: true, attempts, missing: ['task'],
                    reason: 'no HubSpot owner is mapped for the pilot, so the task was not created' };
            }
        }

        // Anything created but not linked is linked now, on its own, without creating anything again.
        if (deps.hubspot.linkToContact) {
            for (const [type, idv, flag] of [['notes', noteId, 'crmNoteLinked'], ['tasks', taskId, 'crmTaskLinked']]) {
                if (!idv || r[flag] === 'true') continue;
                const l = await deps.hubspot.linkToContact(type, idv, contactId);
                await save({ [flag]: l && l.ok ? 'true' : 'false' });
            }
        }

        const after = { crmContactId: contactId, crmNoteId: noteId, crmDealId: dealId, crmDealSkipped: dealSkipped, crmTaskId: taskId };
        const missing = whatIsMissing(after, { isClient });
        const syncState = missing.length ? 'partial' : 'ok';
        // If the final write does not land, the run is not ok, whatever happened remotely. Reporting
        // success on a state we failed to store is how a queue quietly diverges from the CRM.
        const wrote = await bump({
            syncState,
            syncError: missing.length ? `still missing: ${missing.join(', ')}` : '',
            isExistingClient: isClient ? 'true' : 'false',
            clientReason: isClient ? (client.reason || '') : '',
            owner: r.owner || 'Paul',
        });
        if (!wrote) {
            return { status: 'pending', retryable: true, attempts, contactId, dealId, taskId,
                reason: 'the work was done but its result could not be written down, so this will be checked again' };
        }
        return {
            status: syncState, retryable: syncState !== 'ok', attempts, missing,
            contactId, dealId, taskId, noteId, isClient,
            reason: missing.length ? `partial: still missing ${missing.join(', ')}` : 'synced',
        };
    } finally {
        await release();
    }
}

/**
 * Work whatever is due. Items are leased, not popped, so a worker that dies leaves the item in the
 * queue to be retried rather than dropping it on the floor.
 */
export async function drainSync(deps, { limit = 10, now = deps.now || (() => Date.now()) } = {}) {
    const { redis } = deps;
    const out = { due: 0, ok: 0, partial: 0, pending: 0, skipped: 0, failed: 0, results: [] };
    let ids = [];
    try { ids = (await redis.zrange(DUE_KEY, 0, now(), { byScore: true })) || []; }
    catch (e) { return { ...out, error: 'the due queue could not be read' }; }
    out.due = ids.length;

    for (const id of ids.slice(0, limit)) {
        // A worker that throws leaves the item where it is. Losing an inquiry to an unhandled error
        // is the one outcome this queue exists to prevent.
        let r;
        try { r = await syncRequest(id, deps); }
        catch (e) { r = { status: 'pending', retryable: true, attempts: 0, reason: `the worker threw: ${String((e && e.message) || e).slice(0, 120)}` }; }
        out.results.push({ id, status: r.status, reason: r.reason || '' });
        if (r.status === 'ok') {
            out.ok++;
            try { await redis.zrem(DUE_KEY, id); } catch (e) { /* a repeat run is harmless, it short-circuits */ }
            continue;
        }
        if (r.status === 'skipped') {
            out.skipped++;
            try { await redis.zrem(DUE_KEY, id); } catch (e) {}
            continue;
        }
        const attempts = Number(r.attempts || 0);
        if (attempts >= MAX_ATTEMPTS) {
            out.failed++;
            try {
                await redis.hset(id, { syncState: 'failed', syncError: `${r.reason || 'sync failed'} (gave up after ${attempts} attempts)` });
                await redis.zrem(DUE_KEY, id);
            } catch (e) {}
            continue;
        }
        if (r.status === 'partial') out.partial++; else out.pending++;
        // Spread the retries out rather than burning the budget in one pass.
        try { await redis.zadd(DUE_KEY, { score: now() + nextDelay(attempts) * 1000, member: id }); } catch (e) {}
    }
    return out;
}

/** How the health panel describes the queue, including work that is overdue rather than merely queued. */
export async function syncHealth(redis, { now = () => Date.now() } = {}) {
    try {
        const total = Number((await redis.zcard(DUE_KEY)) || 0);
        const dueNow = ((await redis.zrange(DUE_KEY, 0, now(), { byScore: true })) || []).length;
        return { ok: true, queued: total, dueNow };
    } catch (e) { return { ok: false, why: 'the sync queue could not be read' }; }
}
