// Finding a person behind an email, without inventing one or overwriting one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitName, needsName, researchIdentity, knownIdentity, triedRecently, isGenericAddress, pickDecider, IDENTITY_KEY, TRIED_KEY } from '../api/_contact-identity.js';

const store = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async set(k, v) { m.set(k, v); return 'OK'; } }; };
const NOW = Date.parse('2026-10-23T15:00:00Z');

test('names split the way a CRM wants them', () => {
    assert.deepEqual(splitName('Tom Rieck'), { firstName: 'Tom', lastName: 'Rieck' });
    assert.deepEqual(splitName('  Mary  Anne   van der Berg '), { firstName: 'Mary', lastName: 'Anne van der Berg' });
    assert.deepEqual(splitName('Cher'), { firstName: 'Cher', lastName: '' });
    assert.deepEqual(splitName(''), { firstName: '', lastName: '' });
    assert.equal(needsName({ firstname: '' }), true); assert.equal(needsName({ firstname: ' Tom ' }), false); assert.equal(needsName(null), true);
});

test('a vendor answer already paid for is used first, fills only the blank CRM fields, and says where it came from', async () => {
    const redis = store(); const fills = [];
    const r = await researchIdentity({ redis, email: 'Dean.Allen@McKinstry.com', contactId: '77', now: NOW,
        vendorCached: { phone: '+1', name: 'Dean Allen', title: 'CEO', source: 'RocketReach' },
        lookup: async () => { throw new Error('must not spend a credit'); },
        fill: async (id, wanted) => { fills.push([id, wanted]); return { ok: true, filled: ['firstname', 'lastname'] }; } });
    assert.equal(r.found, true); assert.equal(r.credit, false);
    assert.equal(r.firstName, 'Dean'); assert.equal(r.lastName, 'Allen'); assert.equal(r.title, 'CEO');
    assert.deepEqual(fills, [['77', { firstname: 'Dean', lastname: 'Allen', jobtitle: 'CEO' }]]);
    const known = await knownIdentity(redis, 'dean.allen@mckinstry.com');
    assert.equal(known.source, 'RocketReach'); assert.equal(known.kind, 'person'); assert.equal(known.checkedAt, '2026-10-23T15:00:00.000Z'); assert.deepEqual(known.crm, { filled: ['firstname', 'lastname'] });
    assert.equal(await triedRecently(redis, 'dean.allen@mckinstry.com', NOW + 86400000), true);
    assert.equal(await triedRecently(redis, 'dean.allen@mckinstry.com', NOW + 40 * 86400000), false, 'a month later it may be tried again');
});

test('a lookup that finds nobody is remembered as tried, stores no identity, and is not retried for a month', async () => {
    const redis = store(); let calls = 0;
    const r = await researchIdentity({ redis, email: 'x@y.com', contactId: '1', now: NOW, lookup: async () => { calls++; return { found: false, reason: 'not in RocketReach' }; }, fill: async () => ({ ok: true, filled: [] }) });
    assert.equal(r.found, false); assert.equal(r.credit, true); assert.equal(calls, 1);
    assert.equal(await knownIdentity(redis, 'x@y.com'), null);
    assert.equal(redis.m.get(TRIED_KEY('x@y.com')).found, false);
    assert.equal(await triedRecently(redis, 'x@y.com', NOW + 1000), true);
});

test('a retryable failure or a pending search is not an answer: nothing is recorded as tried', async () => {
    const redis = store();
    const a = await researchIdentity({ redis, email: 'x@y.com', now: NOW, lookup: async () => ({ found: false, retryable: true, reason: 'rate limited' }) });
    assert.equal(a.ok, false); assert.equal(a.retryable, true);
    const b = await researchIdentity({ redis, email: 'x@y.com', now: NOW, lookup: async () => ({ found: false, pending: true }) });
    assert.equal(b.ok, false);
    const c = await researchIdentity({ redis, email: 'x@y.com', now: NOW, lookup: async () => { throw new Error('socket'); } });
    assert.equal(c.ok, false); assert.equal(c.retryable, true);
    assert.equal(redis.m.size, 0, 'no tried marker, so it is looked at again next run');
});

test('a CRM write that fails is recorded on the identity, and the name is still kept for the card', async () => {
    const redis = store();
    const r = await researchIdentity({ redis, email: 'a@b.com', contactId: '5', now: NOW, lookup: async () => ({ found: true, name: 'Priya Nair', title: null }), fill: async () => ({ ok: false, reason: 'patch_failed' }) });
    assert.equal(r.found, true); assert.deepEqual(r.filled, []);
    const known = await knownIdentity(redis, 'a@b.com');
    assert.equal(known.firstName, 'Priya'); assert.deepEqual(known.crm, { error: 'patch_failed' });
    assert.equal(IDENTITY_KEY('A@B.com'), 'staffify:contact-identity:a@b.com');
});

test('with no vendor record and no lookup allowed, nothing is claimed', async () => {
    const redis = store();
    const r = await researchIdentity({ redis, email: 'a@b.com', contactId: '5', now: NOW, lookup: null, fill: async () => ({ ok: true }) });
    assert.equal(r.found, false); assert.equal(r.credit, false);
    assert.equal(await knownIdentity(redis, 'a@b.com'), null);
});


test('a shared inbox is recognised, and the lookup credit is not spent on it', () => {
    for (const a of ['together@mckinstry.com', 'INFO@zenoti.com', 'contact-us@x.com', 'front.desk@x.com', 'hello@x.com']) assert.equal(isGenericAddress(a), true, a);
    for (const a of ['tom@rileyjonesrem.com', 'dean.allen@mckinstry.com', 'priya@loft.com', '']) assert.equal(isGenericAddress(a), false, a);
});

test('for a shared inbox the question becomes who runs the company; the answer is inferred, kept for the card, never written to the CRM', async () => {
    const redis = store(); const fills = []; let lookups = 0;
    const r = await researchIdentity({ redis, email: 'together@mckinstry.com', contactId: '9', company: 'McKinstry', now: NOW,
        lookup: async () => { lookups++; return { found: true, name: 'Nobody' }; },
        search: async ({ company }) => ({ profiles: [
            { id: 1, name: 'Sam Lee', current_title: 'Marketing Coordinator', current_employer: company },
            { id: 2, name: 'Dean Allen', current_title: 'Chief Executive Officer', current_employer: company, linkedin_url: 'https://linkedin.com/in/dean' },
            { id: 3, name: 'Ana Ruiz', current_title: 'Founder', current_employer: company } ] }),
        fill: async (id, wanted) => { fills.push(wanted); return { ok: true, filled: Object.keys(wanted) }; } });
    assert.equal(lookups, 0, 'no email lookup for an inbox');
    assert.equal(r.found, true); assert.equal(r.kind, 'inferred'); assert.equal(r.firstName, 'Dean'); assert.equal(r.title, 'Chief Executive Officer');
    assert.deepEqual(fills, [], 'the CRM contact is the inbox, so nothing is written to it');
    const known = await knownIdentity(redis, 'together@mckinstry.com');
    assert.equal(known.kind, 'inferred'); assert.equal(known.source, 'RocketReach search'); assert.equal(known.linkedin, 'https://linkedin.com/in/dean');
    assert.equal(pickDecider([{ name: 'A', current_title: 'Owner' }, { name: 'B', current_title: 'CEO' }]).name, 'B', 'a CEO outranks an owner');
    assert.equal(pickDecider([{ name: 'A', current_title: 'Account Executive' }]), null, 'a junior title is not a decision-maker');
    // Nobody senior in the results: tried is recorded, nothing is claimed.
    const r2 = await researchIdentity({ redis, email: 'info@x.com', company: 'X', now: NOW, search: async () => ({ profiles: [{ name: 'A', current_title: 'Intern' }] }) });
    assert.equal(r2.found, false); assert.match(r2.reason, /no decision-maker/); assert.equal(await triedRecently(redis, 'info@x.com', NOW + 1), true);
    // No company to search with: that is an answer (the card can say so), nothing is spent, and it is retried the next day.
    const r3 = await researchIdentity({ redis, email: 'info@y.com', company: '', now: NOW, search: async () => ({ profiles: [] }) });
    assert.equal(r3.found, false); assert.match(r3.reason, /no company name/); assert.equal(await triedRecently(redis, 'info@y.com', NOW + 1), true);
    assert.match((await researchIdentity({ redis, email: 'info@z.com', company: 'Z', now: NOW, search: null })).reason, /no people search is configured/);
});
