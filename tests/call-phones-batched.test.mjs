// The phone ladder, batched: same answers, a bounded number of round-trips.
// ------------------------------------------------------------------
// Live, the Campaigns tab took 9.4 seconds cold and the dialer paid the same on every load: seven
// GETs per due record, one after another, across ~790 records. Each stage now reads all of its
// keys in one MGET. The optimisation is only worth having if the answers are identical, so the
// first test runs the same queue through a store with mget and a store without, and diffs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCallPhones, batchGet } from '../api/_outreach-call-phones.js';

const crmDown = async () => { throw new Error('offline'); };
const NOW = Date.parse('2026-10-22T20:00:00Z');
const OLD = '2026-10-01T12:00:00Z';

// A realistic mix: CRM-cached numbers, evidence, vendor dials, site numbers, a wrong number, a
// block, research in flight, and plenty with nothing at all.
function fixture(n = 60) {
    const seed = {}, rows = [];
    for (let i = 0; i < n; i++) {
        const email = `p${i}@x.com`, id = 'r' + i;
        rows.push({ id, recipient: email, company: 'Co ' + i, campaignId: 'c', callReady: true, unclaimed: true, lastSentAt: OLD, status: 'sent', sentTouches: 4, verifiedSentTouches: 4 });
        if (i % 7 === 0) seed['staffify:call-phone:' + email] = { phone: '+1512555' + String(1000 + i), phoneStatus: 'available', checkedAt: new Date(NOW - 60000).toISOString() };
        if (i % 7 === 1) seed['staffify:call-phone-evidence:' + email] = { phone: '+1305555' + String(1000 + i), status: 'business_listed', sourceUrl: 'https://x.com/' };
        if (i % 7 === 2) seed['staffify:call-phone-evidence:' + email] = { phone: '+1305555' + String(1000 + i), status: 'needs_confirmation' };
        if (i % 7 === 3) seed['staffify:call-phone-vendor:' + email] = { phone: '+1813555' + String(1000 + i), source: 'RocketReach', checkedAt: new Date(NOW).toISOString() };
        if (i % 7 === 4) seed['staffify:call-site-phone:' + email] = { phone: '+1425555' + String(1000 + i), sourceUrl: 'https://x.com/contact', alternates: [], checkedAt: new Date(NOW).toISOString() };
        if (i % 7 === 5) { seed['staffify:call-site-phone:' + email] = { phone: '+1425555' + String(1000 + i), alternates: [], checkedAt: new Date(NOW).toISOString() }; seed['staffify:bad-numbers:' + email] = { numbers: ['425555' + String(1000 + i)] }; }
        if (i % 11 === 0) seed['staffify:call-block:' + id] = { error: 'Do not call: CRM opt-out', lastSentAt: OLD };
        if (i % 7 === 6) seed['staffify:number-research:' + email] = { tried: ['website', 'vendor'], attempts: 2 };
    }
    return { seed, rows };
}
const sequential = seed => ({ async get(k) { return seed[k] ?? null; }, async set(k, v) { seed[k] = v; return 'OK'; } });
const batched = (seed, log = []) => ({
    async get(k) { log.push('get'); return seed[k] ?? null; },
    async set(k, v) { seed[k] = v; return 'OK'; },
    async mget(keys) { log.push('mget:' + keys.length); return keys.map(k => seed[k] ?? null); },
});
const strip = d => d.records.map(r => ({ id: r.id, callReady: r.callReady, unclaimed: r.unclaimed, phone: r.callContact.phone, status: r.callContact.phoneStatus, research: r.numberResearch && r.numberResearch.state, blocked: !!r.callBlock }));

test('batched and sequential stores give identical answers for every record', async () => {
    const { seed, rows } = fixture(60);
    const a = await withCallPhones({ revision: 1, records: structuredClone(rows) }, { redis: sequential(structuredClone(seed)), crm: crmDown, now: NOW });
    const b = await withCallPhones({ revision: 1, records: structuredClone(rows) }, { redis: batched(structuredClone(seed)), crm: crmDown, now: NOW });
    assert.deepEqual(strip(b), strip(a));
    assert.deepEqual(b.numberWork, a.numberWork);
    // And the fixture genuinely exercised every rung.
    const statuses = new Set(strip(a).map(x => x.status));
    // With the CRM down, a record with nothing on file reads 'unavailable', not 'missing': that is
    // the ladder's existing behaviour and the batched path must preserve it.
    for (const s of ['available', 'business_listed', 'crm_unconfirmed', 'vendor_direct', 'site_main', 'wrong_number', 'unavailable']) assert.ok(statuses.has(s), 'fixture covers ' + s);
});

test('the round-trips are bounded by the number of stages, not the number of records', async () => {
    const { seed, rows } = fixture(790);
    const log = [];
    await withCallPhones({ revision: 1, records: rows }, { redis: batched(seed, log), crm: crmDown, now: NOW });
    const mgets = log.filter(x => x.startsWith('mget')).length;
    const gets = log.filter(x => x === 'get').length;
    assert.equal(gets, 0, 'no per-record GETs remain');
    // Seven stages, 790 keys, 400 per chunk: at most 2 chunks per stage.
    assert.ok(mgets <= 14, `${mgets} MGETs for 790 records`);
    assert.ok(mgets >= 7, 'every stage read something');
});

test('a failed chunk degrades its rows to research, and nothing else', async () => {
    const { seed, rows } = fixture(30);
    let calls = 0;
    const flaky = { ...batched(seed), async mget(keys) { calls++; if (keys[0].startsWith('staffify:call-phone-vendor:')) throw new Error('upstash 500'); return keys.map(k => seed[k] ?? null); } };
    const d = await withCallPhones({ revision: 1, records: rows }, { redis: flaky, crm: crmDown, now: NOW });
    const vendorRow = d.records.find(r => r.recipient === 'p3@x.com');
    assert.equal(vendorRow.callReady, false, 'the row that needed the failed read is held');
    assert.equal(vendorRow.numberResearch.state, 'researching', 'as researching, not as a crash');
    const siteRow = d.records.find(r => r.recipient === 'p4@x.com');
    assert.equal(siteRow.callReady, true, 'a row served by a later stage is untouched');
    assert.equal(siteRow.callContact.phoneStatus, 'site_main');
    assert.ok(calls > 1, 'the ladder kept going after the failure');
});

test('batchGet: chunks, preserves order, falls back without mget, never throws', async () => {
    const seed = { a: 1, c: { x: 2 } };
    const log = [];
    const m = await batchGet(batched(seed, log), ['a', 'b', 'c']);
    assert.deepEqual([...m.entries()], [['a', 1], ['b', null], ['c', { x: 2 }]]);
    const big = Array.from({ length: 1000 }, (_, i) => 'k' + i);
    log.length = 0;
    await batchGet(batched({}, log), big);
    assert.deepEqual(log, ['mget:400', 'mget:400', 'mget:200']);
    const f = await batchGet(sequential(seed), ['a', 'b']);
    assert.deepEqual([...f.entries()], [['a', 1], ['b', null]]);
    const dead = await batchGet({ async mget() { throw new Error('down'); } }, ['a']);
    assert.deepEqual([...dead.entries()], [['a', null]]);
    assert.equal((await batchGet(sequential(seed), [])).size, 0);
});
