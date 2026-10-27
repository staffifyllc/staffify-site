// The dialer search: a name, a company or a number, in any mix, even just a first name.
// Paul, 2026-10-27: "make it so we can search by name, company or phone number, any combo of those
// even just first names", then a screenshot of "740" finding nothing on a 740 number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchRecords } from '../assets/js/call-queue-order.js';

const rec = (id, o) => ({ id, company: 'Co ' + id, recipient: id + '@example.com', callHistory: [], ...o });
const RECORDS = [
    rec('eastside', { company: 'Eastside Pics', recipient: 'nolan@eastsidepics.com', callContact: { phone: '+17408779902' } }),
    rec('realkit', { company: 'Realkit', recipient: 'support@realkit.com', phone: '+14043135871', callContact: null, callHistory: [{ notes: 'BIZ line , Nick was not in , left message' }] }),
    rec('loft', { company: 'Loft & Light', recipient: 'priya@loft.example', callContact: { phone: '+15125550002' }, verifiedFirstName: 'Priya' }),
    rec('major', { company: 'Major Media', recipient: 'hello@major.example', callContact: { phone: '+16145557400' } }),
    rec('joas', { company: 'Ohio Visuals', recipient: 'info@ohiovisuals.example', callContact: { phone: '+17405550101' } }),
];
const NAMES = { eastside: 'Nolan McClain', joas: 'Joás Pereira', major: 'Dana Ruiz' };
const ids = (q, o = {}) => searchRecords(RECORDS, q, { names: NAMES, ...o }).map(h => h.record.id);

test('three digits find the area code first: "740" lists the 740 numbers', () => {
    const r = ids('740');
    assert.deepEqual(r.slice(0, 2).sort(), ['eastside', 'joas'], 'both 740 area codes first');
    assert.ok(r.includes('major'), 'then numbers with 740 elsewhere (614-555-7400)');
    assert.equal(r.indexOf('major'), 2);
    assert.deepEqual(ids('74'), [], 'two digits is too few to mean anything');
});

test('any written form of a whole number finds it', () => {
    for (const q of ['(740) 877-9902', '740-877-9902', '7408779902', '+1 740 877 9902', '877-9902', '9902']) assert.deepEqual(ids(q), ['eastside'], q);
});

test('first names alone, full names, and names from HubSpot', () => {
    assert.deepEqual(ids('nolan'), ['eastside'], 'a first name from HubSpot');
    assert.deepEqual(ids('Nolan McClain'), ['eastside']);
    assert.deepEqual(ids('priya'), ['loft'], 'the card\'s own verified first name');
    assert.deepEqual(ids('joas'), ['joas'], 'accents do not matter');
    assert.deepEqual(ids('jo'), ['joas'], 'names match from the start of a word');
    assert.deepEqual(ids('nick'), ['realkit'], 'a name only in the call notes still finds the card');
    assert.equal(searchRecords(RECORDS, 'nolan', { names: NAMES })[0].name, 'Nolan McClain', 'the hit carries the name to show');
});

test('any combination of name, company and number', () => {
    assert.deepEqual(ids('nolan 740'), ['eastside']);
    assert.deepEqual(ids('eastside 9902'), ['eastside']);
    assert.deepEqual(ids('nick realkit'), ['realkit']);
    assert.deepEqual(ids('realkit 404'), ['realkit']);
    assert.deepEqual(ids('nolan realkit'), [], 'every word has to match the same card');
    assert.deepEqual(ids('loft light'), ['loft'], 'company words in any order');
    assert.deepEqual(ids('nolan, eastside'), ['eastside'], 'commas are fine');
});

test('a long list says how many matched in all', () => {
    const many = Array.from({ length: 25 }, (_, i) => rec('p' + i, { company: 'Peach Photo ' + i, callContact: { phone: '+14045550' + String(100 + i) } }));
    const r = searchRecords(many, '404');
    assert.equal(r.length, 10); assert.equal(r.total, 25);
});
