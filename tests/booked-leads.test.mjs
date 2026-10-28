// Paul, 2026-10-28: "if someone books a discovery call it should remove that lead from the database".
// The lead leaves every list (calls, sequences, Hiring now) and the record stays. Stubs only: nothing
// here calls Calendly, sends or writes a real store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { markQueue, bookingKeys, removeBookedLead, sweepBookings, hiringMatches, LOG, EVENTS } from '../api/_booked-leads.js';
import { KEY, sharedCallState, mergeSnapshot } from '../api/_outreach-queue.js';
import { callReady, eligible } from '../api/_outreach-policy.js';
import { HK, putRecord, getRecord, hiringCallRows } from '../api/_hiring-intent.js';
import { prospectState } from '../api/_campaigns-model.js';

const NOW = Date.parse('2026-10-28T15:30:00Z');
const old = new Date(NOW - 5 * 864e5).toISOString();
const sent = (id, recipient, extra = {}) => ({ id, campaignId: 'staffify-talent-network-outreach', recipient, owner: 'Paul', sender: 'paul@trystaffify.com', status: 'sent', sentTouches: 4, verifiedSentTouches: 4, lastSentAt: old, ...extra });
function fakeKv(queue) {
    const m = new Map([[KEY, JSON.stringify(queue)]]), h = new Map(), l = new Map();
    const H = k => { if (!h.has(k)) h.set(k, new Map()); return h.get(k); };
    return { m, h, l,
        async get(k) { return m.has(k) ? m.get(k) : null; },
        async set(k, v, o = {}) { if (o.nx && m.has(k)) return null; m.set(k, v); return 'OK'; },
        async del(k) { m.delete(k); return 1; },
        async eval(_s, [k], [rev, next]) { const cur = JSON.parse(m.get(k) || '{}'); if ((cur.revision || 0) !== Number(rev)) return 0; m.set(k, next); return 1; },
        async hget(k, f) { return H(k).has(f) ? H(k).get(f) : null; },
        async hset(k, o) { for (const [f, v] of Object.entries(o)) H(k).set(f, v); return 1; },
        async hgetall(k) { return H(k).size ? Object.fromEntries(H(k)) : null; },
        async lpush(k, v) { if (!l.has(k)) l.set(k, []); l.get(k).unshift(v); return 1; },
        async ltrim() { return 'OK'; },
    };
}

test('a booking matches the person, or the agency on its own domain; a shared mailbox domain never matches alone', () => {
    assert.equal(bookingKeys('Pat@Gmail.com').domain, null);
    assert.equal(bookingKeys('pat@acme-media.com').domain, 'acme-media.com');
    const state = { records: [sent('a', 'pat@acme-media.com'), sent('b', 'lee@acme-media.com', { agencyKey: 'acme-media.com' }), sent('c', 'sam@gmail.com', { agencyKey: 'sams-photos.com' }), sent('d', 'kim@other.com')] };
    assert.deepEqual(markQueue(state, { email: 'pat@acme-media.com', inviteeUri: 'i1' }), ['a', 'b']);
    assert.deepEqual(markQueue(state, { email: 'jo@gmail.com', inviteeUri: 'i2' }), [], 'gmail matches nobody but its own address');
    assert.deepEqual(markQueue(state, { email: 'pat@acme-media.com', inviteeUri: 'i1' }), [], 'the same booking twice changes nothing');
});

test('a booked lead leaves the call list and the sequence, owned or not, and the record stays', async () => {
    const queue = { revision: 7, records: [sent('a', 'pat@acme-media.com'), sent('b', 'kim@other.com'), sent('c', 'owned@acme-media.com', { callOwner: 'milton@trystaffify.com', callOutcome: 'callback', nextCallAt: old })], assignments: [], suppressions: [], pausedOwners: [] };
    const kv = fakeKv(queue);
    const hire = { id: 'hire:00000000000000b1', campaignId: 'staffify-hiring-intent', status: 'ready', company: { name: 'Acme Media', domain: 'acme-media.com' }, contact: { email: null }, job: { title: 'CSR' }, phone: { number: '+15125550100' }, callHistory: [{ outcome: 'no_answer' }], callOwner: null };
    await putRecord(kv, hire);
    assert.equal(callReady(queue.records[0], NOW), true, 'callable before');
    const r = await removeBookedLead(kv, { email: 'pat@acme-media.com', inviteeUri: 'https://api.calendly.com/invitees/1', eventName: 'Discovery call', startTime: '2026-10-30T15:00:00Z', source: 'calendly webhook' }, NOW);
    assert.deepEqual(r.queue, ['a']); assert.deepEqual(r.hiring, ['hire:00000000000000b1']);
    const after = JSON.parse(kv.m.get(KEY));
    assert.equal(after.revision, 8); assert.equal(after.records.length, 3, 'nothing deleted');
    const a = after.records.find(x => x.id === 'a');
    assert.equal(a.booking.email, 'pat@acme-media.com'); assert.equal(a.status, 'sent', 'its own status is kept');
    assert.equal(callReady(a, NOW), false); assert.equal(eligible(a, after, NOW), false, 'no more automated email');
    assert.equal(callReady(after.records.find(x => x.id === 'b'), NOW), true, 'an unrelated lead is untouched');
    const card = await getRecord(kv, hire.id);
    assert.equal(card.status, 'booked'); assert.equal(card.booking.previousStatus, 'ready'); assert.equal(card.callHistory.length, 1);
    assert.equal(JSON.parse(await kv.hget(HK.companies, 'domain:acme-media.com')).verdict, 'in_outreach');
    assert.deepEqual((await hiringCallRows(kv, 'milton@trystaffify.com', NOW)).map(x => x.id), [], 'off the Hiring now list');
    assert.equal(prospectState(a, NOW).key, 'booked');
    // The owned callback at the same company: still on Milton's list until its own booking matches.
    const owned = sharedCallState(after, 'milton@trystaffify.com').records.map(x => x.id);
    assert.ok(owned.includes('c') && !owned.includes('a'));
    await removeBookedLead(kv, { email: 'owned@acme-media.com', inviteeUri: 'https://api.calendly.com/invitees/2', eventName: 'Enterprise Discovery Call' }, NOW);
    assert.ok(!sharedCallState(JSON.parse(kv.m.get(KEY)), 'milton@trystaffify.com').records.some(x => x.id === 'c'), 'an owned lead who booked leaves the list too');
    assert.equal(kv.l.get(LOG).length, 2, 'each removal is logged');
});

test('the sweep reads Calendly\'s meetings once each and fails loudly when Calendly cannot be read', async () => {
    const kv = fakeKv({ revision: 1, records: [sent('a', 'pat@acme-media.com')] });
    let reads = 0;
    const deps = { whoAmI: async () => ({ organization: 'org' }), events: async () => ({ items: [{ uri: 'e1', name: 'Discovery call', start_time: '2026-10-30T15:00:00Z' }, { uri: 'e2', name: 'Workshop' }] }),
        invitees: async u => { reads++; return u === 'e1' ? [{ email: 'pat@acme-media.com', status: 'active', uri: 'i1' }] : [{ email: 'gone@x.com', status: 'canceled' }]; } };
    const out = await sweepBookings(kv, deps, { now: NOW });
    assert.equal(out.checked, 1, 'only the Discovery call is read'); assert.equal(out.removed, 1); assert.equal(out.discovery, 1);
    assert.match(await kv.hget(EVENTS, 'e2'), /not a Discovery call/);
    assert.ok(JSON.parse(kv.m.get(KEY)).records[0].booking);
    assert.ok(await kv.hget(EVENTS, 'e1'));
    await sweepBookings(kv, deps, { now: NOW });
    assert.equal(reads, 1, 'a meeting already swept is not read again, and a workshop never');
    await assert.rejects(sweepBookings(fakeKv({ revision: 1, records: [] }), { ...deps, events: async () => { throw Error('Calendly 401'); } }, { now: NOW }), /401/);
});

test('a Hiring now card matches on its contact or its employer\'s own domain', () => {
    const rec = { contact: { email: 'owner@royalelect.com' }, company: { domain: 'royalelect.com' } };
    assert.equal(hiringMatches(rec, { email: 'owner@royalelect.com' }), true);
    assert.equal(hiringMatches(rec, { email: 'office@royalelect.com' }), true);
    assert.equal(hiringMatches(rec, { email: 'someone@gmail.com' }), false);
});

test('an uploaded snapshot keeps the booking mark', () => {
    const prev = { revision: 4, records: [{ ...sent('a', 'pat@acme-media.com'), booking: { email: 'pat@acme-media.com', at: '2026-10-28T15:00:00Z' } }], assignments: [], suppressions: [] };
    const next = mergeSnapshot(prev, { records: [sent('a', 'pat@acme-media.com')], assignments: [] });
    assert.equal(next.records[0].booking.email, 'pat@acme-media.com'); assert.equal(callReady(next.records[0], NOW), false);
});
