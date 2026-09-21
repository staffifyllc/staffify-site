// The inbound-to-CRM sync, driven through its real exports with fake transport. Nothing here
// duplicates the algorithm: every test calls syncRequest or drainSync and asserts on what they did
// to the injected store and the injected HubSpot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncRequest, drainSync, enqueueSync, noteBody, attributionLine, classifyFailure,
    DUE_KEY, RESPONSE_DUE_HOURS, MAX_ATTEMPTS, BACKOFF_SECONDS } from '../api/_pilot-sync.js';

function store(seed = {}) {
    const hash = new Map(), str = new Map(), z = new Map();
    for (const [k, v] of Object.entries(seed)) hash.set(k, new Map(Object.entries(v)));
    const h = (k) => { if (!hash.has(k)) hash.set(k, new Map()); return hash.get(k); };
    return {
        _: { hash, str, z }, failHset: false, failHgetall: false,
        async hgetall(k) { if (this.failHgetall) throw new Error('down'); const m = hash.get(k); return m ? Object.fromEntries(m) : null; },
        async hset(k, o) { if (this.failHset) throw new Error('down'); const m = h(k); for (const [f, v] of Object.entries(o)) m.set(f, String(v)); return 1; },
        async set(k, v, opt = {}) { if (opt.nx && str.has(k)) return null; str.set(k, String(v)); return 'OK'; },
        async get(k) { return str.has(k) ? str.get(k) : null; },
        async del(k) { str.delete(k); return 1; },
        async eval(script, keys, args) { if (str.get(keys[0]) === args[0]) { str.delete(keys[0]); return 1; } return 0; },
        async zadd(k, { score, member }) { if (!z.has(k)) z.set(k, new Map()); z.get(k).set(member, score); return 1; },
        async zrem(k, m) { if (z.has(k)) z.get(k).delete(m); return 1; },
        async zcard(k) { return z.has(k) ? z.get(k).size : 0; },
        async zrange(k, min, max) {
            const m = z.get(k); if (!m) return [];
            return [...m.entries()].filter(([, s]) => s >= min && s <= max).sort((a, b) => a[1] - b[1]).map(([mem]) => mem);
        },
    };
}

function hubspot(over = {}) {
    const calls = { lookup: 0, create: 0, note: 0, deal: 0, task: 0, fill: 0 };
    return {
        calls,
        async lookupContact() { calls.lookup++; return { status: 'absent' }; },
        async findOrCreateContact() { calls.create++; return { ok: true, id: '100' + calls.create, created: true }; },
        async fillBlankContactProps() { calls.fill++; return { ok: true, filled: ['company'] }; },
        async logNote() { calls.note++; return { ok: true, id: 'n' + calls.note }; },
        async upsertDeal() { calls.deal++; return { ok: true, id: 'd' + calls.deal }; },
        async createTask(a) { calls.task++; calls.lastTask = a; if (!a.ownerId) return { ok: false, reason: 'no_owner', status: 400 }; return { ok: true, id: 't' + calls.task, linked: true }; },
        async linkToContact() { calls.link = (calls.link || 0) + 1; return { ok: true }; },
        ...over,
    };
}

const REQ = {
    id: 'pilot:req:abc', email: 'dana@example.com', name: 'Dana Okafor', company: 'Okafor Media',
    pain: 'Every file comes back to me.', times: 'Thursday afternoons', state: 'REQUESTED',
    createdAt: '2026-09-21T12:00:00Z', utmSource: 'linkedin', utmCampaign: 'owners-q3', lid: 'L42',
};
const deps = (s, hs, over = {}) => ({
    redis: s, hubspot: hs, guard: async () => ({ status: 'clear' }), optout: async () => false,
    ownerId: async () => 'OWNER1', now: () => Date.parse('2026-09-21T13:00:00Z'), ...over,
});

test('the worker never writes its own status onto the buyer request', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    const out = await syncRequest('pilot:req:abc', deps(s, hubspot()));
    assert.equal(out.status, 'ok');
    const rec = await s.hgetall('pilot:req:abc');
    assert.equal(rec.state, 'REQUESTED', 'the buyer-facing state is untouched');
    assert.equal(rec.syncState, 'ok');
    assert.equal(rec.crmContactId, '1001');
});

test('a booked request stays booked through a sync', async () => {
    const s = store({ 'pilot:req:abc': { ...REQ, state: 'BOOKED', bookingRef: 'cal:xyz' } });
    await syncRequest('pilot:req:abc', deps(s, hubspot()));
    const rec = await s.hgetall('pilot:req:abc');
    assert.equal(rec.state, 'BOOKED');
    assert.equal(rec.bookingRef, 'cal:xyz');
});

test('a failed lookup never creates a duplicate contact', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    const hs = hubspot({ async lookupContact() { return { status: 'failed', why: 'HubSpot answered 500' }; } });
    const out = await syncRequest('pilot:req:abc', deps(s, hs));
    assert.equal(out.status, 'pending');
    assert.equal(out.retryable, true);
    assert.match(out.reason, /lookup failed/);
    assert.equal(hs.calls.create, 0, 'nothing was created on a failed search');
    assert.equal((await s.hgetall('pilot:req:abc')).crmContactId, undefined);
});

test('an existing contact is reused rather than duplicated', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    const hs = hubspot({ async lookupContact() { return { status: 'found', id: '777' }; } });
    const out = await syncRequest('pilot:req:abc', deps(s, hs));
    assert.equal(out.contactId, '777');
    assert.equal(hs.calls.create, 0);
});

test('running twice makes one of everything', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    const hs = hubspot();
    await syncRequest('pilot:req:abc', deps(s, hs));
    await syncRequest('pilot:req:abc', deps(s, hs));
    assert.deepEqual([hs.calls.create, hs.calls.note, hs.calls.deal, hs.calls.task], [1, 1, 1, 1]);
});

test('if the intent cannot be recorded, nothing is attempted at all', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    const hs = hubspot();
    s.hset = async function () { throw new Error('down'); };
    const out = await syncRequest('pilot:req:abc', deps(s, hs));
    assert.equal(out.status, 'pending');
    assert.match(out.reason, /intent to create a Contact could not be recorded/);
    assert.equal(hs.calls.create, 0, 'no unrecorded object was created in HubSpot');
});

test('created remotely but the id could not be saved: hold, and never a second create', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    const hs = hubspot();
    // The intent write lands; every write after it fails. This is the crash-after-create shape.
    let writes = 0;
    const realHset = s.hset.bind(s);
    s.hset = async function (k, o) { writes++; if (writes > 1) throw new Error('down'); return realHset(k, o); };
    const first = await syncRequest('pilot:req:abc', deps(s, hs));
    assert.equal(first.status, 'hold');
    assert.match(first.reason, /created in HubSpot/);
    assert.match(first.reason, /Do not re-run this request/);
    assert.equal(hs.calls.create, 1);

    // The intent survives. A later run sees it, with no id beside it, and refuses to guess.
    s.hset = realHset;
    const second = await syncRequest('pilot:req:abc', deps(s, hs));
    assert.equal(second.status, 'hold');
    assert.equal(second.needsReview, true);
    assert.match(second.reason, /may already have been created/);
    assert.equal(hs.calls.create, 1, 'still one contact, never two');
    assert.equal((await s.hgetall('pilot:req:abc')).syncState, 'needs-reconcile');
});

test('a create that never answered is held, not retried blindly', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    const hs = hubspot({ async createTask() { this.calls.task++; throw new Error('socket hang up'); } });
    const out = await syncRequest('pilot:req:abc', deps(s, hs));
    assert.equal(out.status, 'hold');
    assert.match(out.reason, /did not answer, so it may or may not exist/);
    const again = await syncRequest('pilot:req:abc', deps(s, hs));
    assert.equal(again.status, 'hold');
    assert.equal(hs.calls.task, 1, 'the uncertain create was not repeated');
});

test('a 500 is unknown and a 400 is a refusal, and they are treated differently', async () => {
    assert.equal(classifyFailure({ ok: false, status: 500 }), 'unknown');
    assert.equal(classifyFailure({ ok: false, status: 429 }), 'unknown');
    assert.equal(classifyFailure({ ok: false, status: 0 }), 'unknown');
    assert.equal(classifyFailure({ ok: false }), 'unknown');
    assert.equal(classifyFailure({ ok: false, status: 400 }), 'refused');
    assert.equal(classifyFailure({ ok: false, status: 403 }), 'refused');

    const s = store({ 'pilot:req:abc': REQ });
    const hs = hubspot({ async createTask() { this.calls.task++; return { ok: false, reason: 'task_failed', status: 500 }; } });
    const unknown = await syncRequest('pilot:req:abc', deps(s, hs));
    assert.equal(unknown.status, 'hold', 'a 500 might have landed, so it is held');
});

test('a failed task makes the sync partial, and the retry finishes it without repeating work', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    let taskShouldFail = true;
    const hs = hubspot({
        // A 400 is HubSpot saying no. Nothing was created, so this is safe to retry.
        async createTask(a) { this.calls.task++; if (taskShouldFail) return { ok: false, reason: 'task_failed', status: 400 }; return { ok: true, id: 't9' }; },
    });
    const first = await syncRequest('pilot:req:abc', deps(s, hs));
    assert.equal(first.status, 'partial');
    assert.deepEqual(first.missing, ['task']);
    assert.equal((await s.hgetall('pilot:req:abc')).syncState, 'partial');

    taskShouldFail = false;
    const second = await syncRequest('pilot:req:abc', deps(s, hs));
    assert.equal(second.status, 'ok');
    assert.equal(hs.calls.create, 1, 'the contact was not created again');
    assert.equal(hs.calls.note, 1, 'the note was not written again');
    assert.equal(hs.calls.deal, 1, 'the deal was not created again');
    assert.equal(hs.calls.task, 2, 'only the failed piece was retried');
});

test('an opted-out address is skipped before anything is written', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    const hs = hubspot();
    const out = await syncRequest('pilot:req:abc', deps(s, hs, { optout: async () => true }));
    assert.equal(out.status, 'skipped');
    assert.equal(hs.calls.lookup + hs.calls.create + hs.calls.task, 0);
    assert.equal((await s.hgetall('pilot:req:abc')).syncReason, 'opted out');
});

test('an existing client is linked and never given a sales deal', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    const hs = hubspot();
    const out = await syncRequest('pilot:req:abc', deps(s, hs, {
        guard: async () => ({ status: 'client', reason: 'already a client' }) }));
    assert.equal(out.status, 'ok');
    assert.equal(out.isClient, true);
    assert.equal(hs.calls.deal, 0, 'no deal is built around a paying customer');
    assert.equal(hs.calls.task, 1, 'but somebody still has to answer them');
    assert.match(hs.calls.lastTask.subject, /Existing client/);
    assert.match(hs.calls.lastTask.body, /Do not pitch/);
});

test('a company-name match is held for review, not treated as a client or a prospect', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    const hs = hubspot();
    const out = await syncRequest('pilot:req:abc', deps(s, hs, {
        guard: async () => ({ status: 'possible', reason: 'the company name normalises to "okafor", which matches an existing client' }) }));
    assert.equal(out.status, 'skipped');
    assert.equal(out.needsReview, true);
    assert.equal(hs.calls.create + hs.calls.deal, 0);
    assert.equal((await s.hgetall('pilot:req:abc')).needsReview, 'true');
});

test('a guard that could not answer leaves the job pending, never clear', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    const hs = hubspot();
    const out = await syncRequest('pilot:req:abc', deps(s, hs, {
        guard: async () => ({ status: 'unknown', why: 'the shared client snapshot could not be established' }) }));
    assert.equal(out.status, 'pending');
    assert.equal(out.retryable, true);
    assert.equal(hs.calls.create, 0);
});

test('two workers on one request: one runs, the other stands down', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    const hs = hubspot();
    const [a, b] = await Promise.all([
        syncRequest('pilot:req:abc', deps(s, hs)),
        syncRequest('pilot:req:abc', deps(s, hs)),
    ]);
    const stood = [a, b].filter((x) => /already running/.test(x.reason || ''));
    assert.equal(stood.length, 1);
    assert.equal(hs.calls.task, 1, 'one task, not two');
});

test('the response is due from when they asked, not from when the retry ran', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    const hs = hubspot();
    // A retry three days later must not quietly move the deadline.
    await syncRequest('pilot:req:abc', deps(s, hs, { now: () => Date.parse('2026-09-24T09:00:00Z') }));
    const due = new Date(hs.calls.lastTask.dueAt).toISOString();
    assert.equal(due, new Date(Date.parse(REQ.createdAt) + RESPONSE_DUE_HOURS * 3600000).toISOString());
});

test('the due queue leases rather than pops, so a crash does not lose the work', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    await enqueueSync(s, 'pilot:req:abc', { at: 1000 });
    const hs = hubspot({ async lookupContact() { throw new Error('boom'); } });
    await drainSync(deps(s, hs, { now: () => 2000 }), { limit: 5 });
    assert.equal(await s.zcard(DUE_KEY), 1, 'still queued after a worker blew up');
});

test('retries back off instead of burning the budget in one pass', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    await enqueueSync(s, 'pilot:req:abc', { at: 1000 });
    const hs = hubspot({ async lookupContact() { return { status: 'failed', why: '500' }; } });
    const out = await drainSync(deps(s, hs, { now: () => 2000 }), { limit: 5 });
    assert.equal(out.pending, 1);
    const when = s._.z.get(DUE_KEY).get('pilot:req:abc');
    assert.equal(when, 2000 + BACKOFF_SECONDS[1] * 1000, 'rescheduled, not retried immediately');
    const second = await drainSync(deps(s, hs, { now: () => 2000 }), { limit: 5 });
    assert.equal(second.due, 0, 'and it is not due yet, so the pass does nothing');
});

test('after the attempt budget the job fails visibly and leaves the queue', async () => {
    const s = store({ 'pilot:req:abc': { ...REQ, syncAttempts: String(MAX_ATTEMPTS - 1) } });
    await enqueueSync(s, 'pilot:req:abc', { at: 1000 });
    const hs = hubspot({ async lookupContact() { return { status: 'failed', why: '500' }; } });
    const out = await drainSync(deps(s, hs, { now: () => 2000 }), { limit: 5 });
    assert.equal(out.failed, 1);
    const rec = await s.hgetall('pilot:req:abc');
    assert.equal(rec.syncState, 'failed');
    assert.match(rec.syncError, /gave up after/);
    assert.equal(await s.zcard(DUE_KEY), 0);
});

test('the CRM note carries their words and the whole attribution', () => {
    const body = noteBody(REQ);
    assert.match(body, /Every file comes back to me/);
    assert.match(body, /source=linkedin/);
    assert.match(body, /campaign=owners-q3/);
    assert.match(body, /lid=L42/);
    assert.match(body, /request, not a booking/);
    assert.equal(attributionLine({}), '');
});

test('a task with no resolvable owner is refused and shown, never created unowned', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    const hs = hubspot();
    const out = await syncRequest('pilot:req:abc', deps(s, hs, { ownerId: async () => '' }));
    assert.equal(out.status, 'partial');
    assert.deepEqual(out.missing, ['task']);
    assert.match(out.reason, /no HubSpot owner is mapped/);
    assert.equal((await s.hgetall('pilot:req:abc')).crmTaskId, undefined, 'no unowned task exists');
});

test('an object created but not linked is linked on the retry, not created again', async () => {
    const s = store({ 'pilot:req:abc': REQ });
    let linkOk = false;
    const hs = hubspot({
        async logNote() { this.calls.note++; return { ok: true, id: 'n1', linked: false, linkError: 'not linked' }; },
        async linkToContact() { this.calls.link = (this.calls.link || 0) + 1; return { ok: linkOk }; },
    });
    await syncRequest('pilot:req:abc', deps(s, hs));
    assert.equal((await s.hgetall('pilot:req:abc')).crmNoteLinked, 'false');
    linkOk = true;
    await syncRequest('pilot:req:abc', deps(s, hs));
    assert.equal(hs.calls.note, 1, 'the note was never written twice');
    assert.equal((await s.hgetall('pilot:req:abc')).crmNoteLinked, 'true');
});
