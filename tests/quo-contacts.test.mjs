// Paul, 2026-10-28: "create a contact card or something so that if these numbers call back we know whos who".
import test from 'node:test';
import assert from 'node:assert/strict';
import { contactOf, contactOfProspect, syncQuoContacts, QK } from '../api/_quo-contacts.js';
import { HK } from '../api/_hiring-intent.js';

const kvOf = () => { const h = new Map(); return {
    async hgetall(k) { const m = h.get(k); return m ? Object.fromEntries(m) : null; },
    async hset(k, o) { if (!h.has(k)) h.set(k, new Map()); for (const [a, b] of Object.entries(o)) h.get(k).set(a, b); return 1; },
    async hget(k, f) { return h.get(k) ? h.get(k).get(f) ?? null : null; },
}; };
const REC = (over = {}) => ({ id: 'hire:aaaaaaaaaaaaaaaa', status: 'ready', company: { name: 'Wedding Weekender' }, job: { title: 'Post-Production Specialist (video edit review and creation; social reels)' },
    contact: { name: 'Anne Marie Carroll', role: 'Founder', email: null }, phone: { number: '+17635671595', alternates: ['+18005551212', '+13035550100'], source: 'vendor', person: 'Anne Carroll', lineType: 'mobile' }, callHistory: [], ...over });

test('a card becomes a Quo contact: the person, the business, the job, and every number but a toll-free one', () => {
    const c = contactOf(REC());
    assert.equal(c.externalId, 'hire:aaaaaaaaaaaaaaaa'); assert.equal(c.source, 'staffify-hub');
    assert.equal(c.defaultFields.firstName, 'Anne'); assert.equal(c.defaultFields.lastName, 'Marie Carroll'); assert.equal(c.defaultFields.company, 'Wedding Weekender');
    assert.equal(c.defaultFields.role, 'Hiring: Post-Production Specialist · Founder');
    assert.deepEqual(c.defaultFields.phoneNumbers, [{ name: 'Owner mobile', value: '+17635671595' }, { name: 'Other', value: '+13035550100' }]);
    assert.equal(contactOf(REC({ contact: {}, phone: { number: '+15125550100', alternates: [] } })).defaultFields.firstName, 'Wedding Weekender', 'no person: the business name');
    assert.equal(contactOf(REC({ phone: { number: '+18885551212', alternates: [] } })), null, 'only a toll-free line: no contact');
});

test('the sync is dry unless asked, creates once, updates only what changed, and never makes a second copy', async () => {
    const kv = kvOf();
    await kv.hset(HK.records, { 'hire:aaaaaaaaaaaaaaaa': JSON.stringify(REC()), 'hire:bbbbbbbbbbbbbbbb': JSON.stringify(REC({ id: 'hire:bbbbbbbbbbbbbbbb', status: 'excluded' })) });
    const calls = [];
    const api = { create: async c => { calls.push(['create', c.externalId]); return { id: 'CT1' }; }, update: async (id, c) => { calls.push(['update', id, c.defaultFields.phoneNumbers.length]); return { id }; }, byExternalId: async id => { calls.push(['find', id]); return null; } };
    const dry = await syncQuoContacts({ kv, api }, {});
    assert.equal(dry.planned.length, 1, 'an excluded card nobody called gets no contact'); assert.deepEqual(calls, []);
    const first = await syncQuoContacts({ kv, api }, { write: true });
    assert.equal(first.created, 1); assert.deepEqual(calls.map(c => c[0]), ['find', 'create']);
    const again = await syncQuoContacts({ kv, api }, { write: true });
    assert.equal(again.unchanged, 1); assert.equal(calls.length, 2, 'nothing sent when nothing changed');
    await kv.hset(HK.records, { 'hire:aaaaaaaaaaaaaaaa': JSON.stringify(REC({ phone: { number: '+17635671595', alternates: ['+13035550100', '+13035550111'], source: 'vendor', person: 'Anne Carroll', lineType: 'mobile' } })) });
    const changed = await syncQuoContacts({ kv, api }, { write: true });
    assert.equal(changed.updated, 1); assert.deepEqual(calls[2], ['update', 'CT1', 3], 'the full list of numbers is sent: Quo replaces, it does not merge');
    // The record of what was synced is lost: the contact is found by the card id, not made twice.
    const kv2 = kvOf(); await kv2.hset(HK.records, { 'hire:aaaaaaaaaaaaaaaa': JSON.stringify(REC()) });
    const found = []; const api2 = { ...api, byExternalId: async () => ({ id: 'CT9' }), update: async id => { found.push(id); return { id }; }, create: async () => { throw Error('should not create'); } };
    assert.equal((await syncQuoContacts({ kv: kv2, api: api2 }, { write: true })).updated, 1); assert.deepEqual(found, ['CT9']);
    assert.equal(JSON.parse((await kv2.hgetall(QK.synced))['hire:aaaaaaaaaaaaaaaa']).quoId, 'CT9');
});

test('a rejected key stops the run instead of failing card after card', async () => {
    const kv = kvOf();
    await kv.hset(HK.records, { 'hire:aaaaaaaaaaaaaaaa': JSON.stringify(REC()), 'hire:cccccccccccccccc': JSON.stringify(REC({ id: 'hire:cccccccccccccccc' })) });
    let tries = 0;
    const api = { byExternalId: async () => null, create: async () => { tries++; const e = Error('Quo 401: unauthorized'); e.status = 401; throw e; }, update: async () => {} };
    const out = await syncQuoContacts({ kv, api }, { write: true });
    assert.equal(tries, 1); assert.equal(out.errors.length, 1);
});

test('the email campaigns\' prospects get contacts too, from the numbers the dialer shows', async () => {
    const p = { id: 'staffify-20260922-248485814632', company: 'Eastside Pics', first: 'Nolan', email: 'Nolan@EastsidePics.com', campaignId: 'staffify-agency-outreach', phones: ['+17408779902', '(800) 555-1212', '740-877-9902', '7408770000'] };
    const c = contactOfProspect(p);
    assert.equal(c.externalId, p.id); assert.equal(c.defaultFields.firstName, 'Nolan'); assert.equal(c.defaultFields.company, 'Eastside Pics');
    assert.equal(c.defaultFields.role, 'Real estate media outreach · emailed by Staffify');
    assert.deepEqual(c.defaultFields.phoneNumbers.map(x => x.value), ['+17408779902', '+17408770000'], 'toll-free dropped, duplicates merged');
    assert.deepEqual(c.defaultFields.emails, [{ name: 'Work', value: 'nolan@eastsidepics.com' }]);
    assert.equal(contactOfProspect({ id: 'x-1', phones: [] }), null);
    const kv = kvOf(); const made = [];
    const api = { byExternalId: async () => null, create: async c2 => { made.push(c2.externalId); return { id: 'CT' + made.length }; }, update: async () => {} };
    const out = await syncQuoContacts({ kv, api }, { write: true, prospects: [p, { id: 'x-2', company: 'No Number Co', phones: [] }] });
    assert.equal(out.created, 1); assert.equal(out.skipped, 1); assert.deepEqual(made, [p.id]);
    assert.equal((await syncQuoContacts({ kv, api }, { write: true, prospects: [p] })).unchanged, 1, 'a second send changes nothing');
});
