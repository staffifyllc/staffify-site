// End to end for one inbound request: the page posts it, the store holds it, the operator reads it
// back, works it, and closes it. No network, no inbox, no calendar, no prospect is contacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, saveRequest } from '../api/_rolemap.js';
import { validateTransition, REQUEST_STATES } from '../api/_pilotstate.js';

function fakeRedis() {
    const S = { str: new Map(), hash: new Map(), list: new Map(), z: new Map() };
    const h = (k) => { if (!S.hash.has(k)) S.hash.set(k, new Map()); return S.hash.get(k); };
    return {
        _: S,
        async set(k, v, o = {}) { if (o.nx && S.str.has(k)) return null; S.str.set(k, String(v)); return 'OK'; },
        async hsetnx(k, f, v) { const m = h(k); if (m.has(f)) return 0; m.set(f, String(v)); return 1; },
        async hset(k, obj) { const m = h(k); for (const [f, v] of Object.entries(obj)) m.set(f, String(v)); return 1; },
        async hget(k, f) { const m = S.hash.get(k); return m && m.has(f) ? m.get(f) : null; },
        async hgetall(k) { const m = S.hash.get(k); return m ? Object.fromEntries(m) : null; },
        async hincrby(k, f, n) { const m = h(k); const v = Number(m.get(f) || 0) + n; m.set(f, String(v)); return v; },
        async rpush(k, v) { if (!S.list.has(k)) S.list.set(k, []); S.list.get(k).push(v); return 1; },
        async ltrim(k, a) { S.list.set(k, (S.list.get(k) || []).slice(a)); return 'OK'; },
        async zadd(k, { member }) { if (!S.z.has(k)) S.z.set(k, new Set()); S.z.get(k).add(member); return 1; },
        async zrange(k) { return [...(S.z.get(k) || [])].reverse(); },
    };
}
const quiet = { notifyEmail: async () => ({ ok: false, skipped: 'mocked' }), notifySlack: async () => ({ ok: false, skipped: 'mocked' }) };
const deps = (r, now = 1) => ({ redis: r, hash: (s) => 'H' + String(s).toLowerCase(), now: () => now, ...quiet });

test('page to queue to closed, with every gate doing its job', async () => {
    const r = fakeRedis();
    // 1. The page posts it.
    const parsed = parseRequest({ name: 'Dana Okafor', email: 'dana@example.com', company: 'Okafor Media',
        pain: 'Every file comes back to me before it goes to the agent.', times: 'Thursday afternoons' });
    const saved = await saveRequest(parsed, deps(r));
    assert.equal(saved.saved, true);

    // 2. The operator reads it back the way /api/pilot-queue does.
    const ids = await r.zrange('pilot:requests');
    assert.equal(ids.length, 1);
    const rec = await r.hgetall(ids[0]);
    assert.equal(rec.state, 'REQUESTED');
    assert.equal(rec.arm, 'inbound', 'inbound is never warm or cold');
    assert.equal(rec.pain, 'Every file comes back to me before it goes to the agent.');
    assert.equal(rec.notifySlack, 'mocked', 'the queue can see nobody was actually alerted');

    // 3. A booking is refused without a calendar reference. This is the whole point of the gate.
    let step = validateTransition(rec, 'BOOKED', { agreedFor: 'Thu 2 Oct 2pm ET' });
    assert.equal(step.ok, false);
    assert.match(step.error, /bookingRef/);
    assert.match(step.hint, /An agreed time is not a booking/);

    // 4. Role map "sent" is refused without naming what went out.
    step = validateTransition(rec, 'ROLE_MAP_SENT', { roleMapSentAt: '2026-09-22T10:00:00Z' });
    assert.equal(step.ok, false);
    assert.match(step.hint, /A task is not a send/);

    // 5. The honest sequence works.
    step = validateTransition(rec, 'ANSWERED', { answeredAt: '2026-09-21T12:00:00Z' });
    assert.equal(step.ok, true);
    await r.hset(ids[0], step.patch);

    step = validateTransition(await r.hgetall(ids[0]), 'ROLE_MAP_SENT',
        { roleMapSentAt: '2026-09-22T10:00:00Z', roleMapArtifact: 'Okafor Media role map.pdf' });
    assert.equal(step.ok, true);
    await r.hset(ids[0], step.patch);

    step = validateTransition(await r.hgetall(ids[0]), 'TIME_AGREED', { agreedFor: 'Thu 2 Oct 2pm ET' });
    assert.equal(step.ok, true);
    await r.hset(ids[0], step.patch);
    assert.equal((await r.hgetall(ids[0])).state, 'TIME_AGREED', 'agreed is a state of its own, short of booked');

    step = validateTransition(await r.hgetall(ids[0]), 'BOOKED', { bookingRef: 'calendly:abc-123' });
    assert.equal(step.ok, true);
    await r.hset(ids[0], step.patch);

    step = validateTransition(await r.hgetall(ids[0]), 'HELD', { heldAt: '2026-10-02T18:00:00Z' });
    assert.equal(step.ok, true);
    await r.hset(ids[0], step.patch);

    // 6. Closing needs their words, unless the answer is one that has none.
    let closed = validateTransition(await r.hgetall(ids[0]), 'CLOSED', { answerKind: 'NOT_NOW' });
    assert.equal(closed.ok, false);
    assert.match(closed.error, /they said it/);
    closed = validateTransition(await r.hgetall(ids[0]), 'CLOSED',
        { answerKind: 'NOT_NOW', answerWords: 'Come back after the new year.' });
    assert.equal(closed.ok, true);
    await r.hset(ids[0], closed.patch);
    const final = await r.hgetall(ids[0]);
    assert.equal(final.state, 'CLOSED');
    assert.equal(final.answerWords, 'Come back after the new year.');

    // 7. And no response closes without words, because there are none to record.
    const noresp = validateTransition({ email: 'x@y.co' }, 'CLOSED', { answerKind: 'NO_RESPONSE' });
    assert.equal(noresp.ok, true);
});

test('an unknown answer and an unknown state are both refused', () => {
    assert.equal(validateTransition({}, 'WON', {}).ok, false);
    assert.equal(validateTransition({}, 'CLOSED', { answerKind: 'NOT_INTERESTED_PROBABLY' }).ok, false);
    assert.deepEqual(Object.keys(REQUEST_STATES).length, 7);
});

test('saving the same state twice leaves one record and one state', async () => {
    const r = fakeRedis();
    await saveRequest(parseRequest({ name: 'A B', email: 'ab@example.com' }), deps(r));
    const id = (await r.zrange('pilot:requests'))[0];
    for (let i = 0; i < 3; i++) {
        const step = validateTransition(await r.hgetall(id), 'ANSWERED', { answeredAt: '2026-09-21T12:00:00Z' });
        assert.equal(step.ok, true);
        await r.hset(id, step.patch);
    }
    assert.equal((await r.zrange('pilot:requests')).length, 1);
    assert.equal((await r.hgetall(id)).state, 'ANSWERED');
});
