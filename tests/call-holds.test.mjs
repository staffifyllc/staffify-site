// Two reps, one queue: holds keep them off each other's cards and every count moves together.
// Paul, 2026-10-27: "after that person's called, it should be removed from the database. Otherwise,
// it's going to be impossible to have multiple sales reps in here working at the same time."
import test from 'node:test';
import assert from 'node:assert/strict';
import { takeHold, releaseHold, listHolds, heldByOther, HK, OPEN_MS, CALL_MS } from '../api/_call-holds.js';

function fakeKv() {
    const m = new Map(), exp = new Map(), h = new Map();
    let clock = Date.parse('2026-10-27T22:00:00Z');
    const alive = k => !exp.has(k) || exp.get(k) > clock;
    return { m, h, tick: ms => { clock += ms; }, now: () => clock,
        async set(k, v, o = {}) { if (o.nx && m.has(k) && alive(k)) return null; m.set(k, v); if (o.ex) exp.set(k, clock + o.ex * 1000); return 'OK'; },
        async get(k) { return m.has(k) && alive(k) ? m.get(k) : null; },
        async del(k) { m.delete(k); return 1; },
        async hset(k, o) { for (const [f, v] of Object.entries(o)) h.set(f, v); return 1; },
        async hgetall() { return Object.fromEntries(h); },
        async hdel(k, ...f) { for (const x of f) h.delete(x); return f.length; } };
}
const MILTON = { email: 'miltion@trystaffify.com', name: 'Milton Hodgson' }, PAUL = { email: 'hello@gostaffify.com', name: 'Paul Chareth' };

test('the first rep to open a card holds it; the second is told who has it', async () => {
    const kv = fakeKv();
    const a = await takeHold(kv, 'r1', MILTON, 'open', kv.now());
    assert.equal(a.ok, true); assert.equal(a.hold.name, 'Milton');
    const b = await takeHold(kv, 'r1', PAUL, 'open', kv.now());
    assert.equal(b.ok, false); assert.equal(b.heldBy.name, 'Milton');
    const live = await listHolds(kv, kv.now());
    assert.ok(heldByOther(live, 'r1', PAUL.email, kv.now())); assert.ok(!heldByOther(live, 'r1', 'MILTION@trystaffify.com', kv.now()), 'his own card is not held against him');
});

test('an open card frees itself in four minutes; Call now holds it fifteen; a saved outcome much longer', async () => {
    const kv = fakeKv();
    await takeHold(kv, 'r1', MILTON, 'open', kv.now());
    kv.tick(OPEN_MS + 1000);
    assert.equal((await takeHold(kv, 'r1', PAUL, 'open', kv.now())).ok, true, 'a walked-away card is free again');
    await takeHold(kv, 'r2', MILTON, 'calling', kv.now());
    kv.tick(CALL_MS - 60000);
    assert.equal((await takeHold(kv, 'r2', PAUL, 'open', kv.now())).ok, false, 'mid-call, still his');
    await takeHold(kv, 'r2', MILTON, 'called', kv.now());
    kv.tick(6 * 3600e3);
    assert.equal((await takeHold(kv, 'r2', PAUL, 'open', kv.now())).ok, false, 'called today: out of everyone else\'s queue');
    assert.equal((await takeHold(kv, 'r2', MILTON, 'open', kv.now())).hold.kind, 'called', 'reopening his own called card never downgrades it');
});

test('releasing lets a card go, but never a called one; expired holds leave the list', async () => {
    const kv = fakeKv();
    await takeHold(kv, 'r1', MILTON, 'open', kv.now());
    assert.deepEqual(await releaseHold(kv, 'r1', PAUL), { ok: true, released: false }, 'nobody releases someone else\'s card');
    assert.deepEqual(await releaseHold(kv, 'r1', MILTON), { ok: true, released: true });
    assert.equal((await takeHold(kv, 'r1', PAUL, 'open', kv.now())).ok, true);
    await takeHold(kv, 'r3', MILTON, 'called', kv.now());
    assert.equal((await releaseHold(kv, 'r3', MILTON)).released, false, 'a call that happened stays happened');
    kv.tick(OPEN_MS + 1000);
    const live = await listHolds(kv, kv.now());
    assert.deepEqual(Object.keys(live), ['r3']); assert.ok(!kv.h.has('r1'), 'the expired one is pruned');
});

test('second review: a hold re-taken while another dialer is pruning is not dropped from the list', async () => {
    const kv = fakeKv();
    await takeHold(kv, 'x', MILTON, 'open', kv.now());
    kv.tick(OPEN_MS + 1000);
    // Expired in the index, but Milton saved an outcome a moment ago: the card's own key is live again.
    await kv.set(HK.one('x'), { id: 'x', by: 'miltion@trystaffify.com', name: 'Milton', kind: 'called', until: new Date(kv.now() + 3600e3).toISOString() }, { ex: 3600 });
    const live = await listHolds(kv, kv.now());
    assert.equal(live.x && live.x.kind, 'called'); assert.ok(kv.h.has('x'), 'the index entry is restored, not deleted');
    assert.equal(typeof live.x.ms, 'number', 'remaining time, so a browser with a wrong clock still honours it');
});
