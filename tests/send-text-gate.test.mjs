// The text endpoint's card check: paused work and cards that left the list are never texted.
// Nothing here sends; the store is a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { textStop } from '../api/send-text.js';
import { HK } from '../api/_hiring-intent.js';
import { KEY } from '../api/_outreach-queue.js';

function kv(records, queue) {
    return {
        async hget(k, f) { return k === HK.records && records[f] ? JSON.stringify(records[f]) : null; },
        async get(k) { return k === KEY ? queue : null; },
        async hgetall() { return null; },
    };
}
const QUEUE = { revision: 3, records: [
    { id: 'rep1', campaignId: 'staffify-agency-outreach', recipient: 'a@agency.com' },
    { id: 'tn1', campaignId: 'staffify-talent-network-outreach', recipient: 'b@co.com' },
    { id: 'tn2', campaignId: 'staffify-talent-network-outreach', recipient: 'c@co.com', booking: { at: '2026-10-28T15:00:00Z' } },
] };
const HIRE = {
    'hire:00000000000000a1': { id: 'hire:00000000000000a1', status: 'ready' },
    'hire:00000000000000a2': { id: 'hire:00000000000000a2', status: 'excluded' },
    'hire:00000000000000a3': { id: 'hire:00000000000000a3', status: 'research' },
};

test('a paused REP card, a booked lead and a card off the list are refused; eligible work is not', async () => {
    const k = kv(HIRE, QUEUE);
    assert.equal(await textStop('rep1', { kv: k }), 'campaign_paused');
    assert.equal(await textStop('tn1', { kv: k }), null);
    assert.equal(await textStop('tn2', { kv: k }), 'booked');
    assert.equal(await textStop('hire:00000000000000a1', { kv: k }), null);
    assert.equal(await textStop('hire:00000000000000a2', { kv: k }), 'not_callable');
    assert.equal(await textStop('hire:00000000000000a3', { kv: k }), 'not_callable');
    assert.equal(await textStop('hire:00000000000000ff', { kv: k }), 'not_found');
    assert.equal(await textStop('unknown-id', { kv: k }), 'not_found', 'an id nobody knows is not texted');
});

test('the endpoint refuses anyone who is not signed in to the Hub', async () => {
    const { default: handler } = await import('../api/send-text.js');
    const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ method: 'POST', headers: {}, query: {}, body: { phone: '+15125550100', first: 'Pat', role: 'Receptionist', rep: 'Milton' } }, res);
    assert.equal(res.code, 401); assert.equal(res.body.error, 'sign_in');
});
