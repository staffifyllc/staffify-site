// Contact names for the dialer search, read from HubSpot in batches and kept six hours.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.KV_REST_API_URL = 'https://example.invalid';
process.env.KV_REST_API_TOKEN = 'test';
const { namesFor, NAMES_KEY, contactIdOf } = await import('../api/prospect-names.js');
const R = await import('../api/_rep-email.js');

const kv = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async set(k, v) { m.set(k, v); return 'OK'; } }; };
const RECS = [{ id: 'a', callContact: { crmContactId: '11' } }, { id: 'b', hubspotId: '22' }, { id: 'c' }, { id: 'd', callContact: { crmContactId: '44' } }];

test('names come from HubSpot by contact id, only the missing ones are read, and the cache is reused', async () => {
    const store = kv(), reads = [];
    const read = async ids => { reads.push(ids); return { ok: true, names: { 11: { first: 'Nolan', last: 'McClain' }, 22: { first: 'Nick', last: '' }, 44: { first: '', last: '' } }, failed: 0 }; };
    const now = Date.parse('2026-10-27T22:00:00Z');
    const r = await namesFor(RECS, { kv: store, read, now });
    assert.deepEqual(r.names, { a: 'Nolan McClain', b: 'Nick' }, 'a blank HubSpot name is no name');
    assert.deepEqual(reads, [['11', '22', '44']]);
    await namesFor(RECS, { kv: store, read, now: now + 3600e3 });
    assert.equal(reads.length, 1, 'within six hours nothing is read again');
    await namesFor(RECS, { kv: store, read, now: now + 7 * 3600e3 });
    assert.equal(reads.length, 2, 'stale after six hours');
    assert.equal(contactIdOf({ crmContactId: 9 }), '9'); assert.equal(contactIdOf({}), null);
});

test('a HubSpot read that failed is said, and tried again soon rather than cached as no names', async () => {
    const store = kv();
    const r = await namesFor(RECS, { kv: store, read: async () => ({ ok: false, names: {}, failed: 3, why: '3 of 3 contacts could not be read' }), now: Date.parse('2026-10-27T22:00:00Z') });
    assert.equal(r.complete, false); assert.match(r.why, /could not be read/);
    const kept = store.m.get(NAMES_KEY);
    assert.ok(Date.parse('2026-10-27T22:00:00Z') - Date.parse(kept.at) > 5 * 3600e3, 'marked nearly stale, so the next open retries');
});

test('the subject carries their first name: templates, the cleanup and the send rule', () => {
    const [thanks, missed] = R.TEMPLATES;
    assert.equal(R.fillTemplate(thanks, { first: 'Nolan' }).subject, 'Nolan, thanks for your time today');
    assert.equal(R.fillTemplate(missed, { first: 'Nolan' }).subject, 'Sorry I missed you, Nolan');
    assert.equal(R.fillTemplate(thanks, {}).subject, 'Thanks for your time today', 'no name known: no "There," in a subject');
    assert.equal(R.withFirstName('Thanks for your time today', 'Nolan'), 'Nolan, thanks for your time today');
    assert.equal(R.withFirstName('Staffify overview', 'Nolan'), 'Nolan, Staffify overview', 'a proper noun keeps its capital');
    assert.equal(R.withFirstName('Quick question for Nolan', 'Nolan'), 'Quick question for Nolan', 'already there: unchanged');
    assert.equal(R.withFirstName('Hi', ''), 'Hi');
    assert.equal(R.subjectHasName('nolan, thanks', 'Nolan'), true);
    assert.equal(R.subjectHasName('Nolanville update', 'Nolan'), false, 'a whole word, not part of one');
    assert.equal(R.cleanFirst(' nick  rossi'), 'Nick'); assert.equal(R.cleanFirst('{first}'), ''); assert.equal(R.cleanFirst('Joás'), 'Joás');
});

test('his signature reads Milton Hodgson, with no second last name', () => {
    const html = R.signatureHtml('milton@trystaffify.com');
    assert.match(html, />Milton Hodgson</); assert.ok(!/Gaitan/.test(html));
    assert.ok(!/border-radius:50%/.test(html), 'no photo column until there is a photo');
});
