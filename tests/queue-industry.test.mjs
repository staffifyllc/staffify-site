// A queue opened from an industry is that industry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderCallQueue } from '../assets/js/call-queue-order.js';

const rec = (id, industry, over = {}) => ({ id, company: 'Co ' + id, recipient: id + '@x.com', campaignId: 'staffify-tobit-outreach', callReady: true, unclaimed: true, lastSentAt: '2026-10-01T12:00:00Z',
    callContact: { phone: '+1512555000' + id.replace(/\D/g, ''), phoneStatus: 'site_main' }, industry, ...over });
const records = [rec('r1', { key: 'construction', label: 'Construction' }), rec('r2', { key: 'software', label: 'Software' }), rec('r3', { key: 'construction', label: 'Construction' }), rec('r4', null)];

test('the industry filter keeps only that industry; "all" and blank keep everyone', () => {
    assert.deepEqual(orderCallQueue(records, { industry: 'construction' }).map(r => r.id), ['r1', 'r3']);
    assert.deepEqual(orderCallQueue(records, { industry: 'software' }).map(r => r.id), ['r2']);
    assert.equal(orderCallQueue(records, { industry: 'all' }).length, 4);
    assert.equal(orderCallQueue(records, {}).length, 4);
    assert.equal(orderCallQueue(records, { industry: 'education' }).length, 0, 'an industry with nobody in it is an empty queue, not everyone');
});

test('the industry filter composes with the campaign and search filters', () => {
    const mixed = [...records, rec('r5', { key: 'construction', label: 'Construction' }, { campaignId: 'staffify-agency-outreach' })];
    assert.deepEqual(orderCallQueue(mixed, { industry: 'construction', campaign: 'staffify-tobit-outreach' }).map(r => r.id), ['r1', 'r3']);
    assert.deepEqual(orderCallQueue(mixed, { industry: 'construction', search: 'r5' }).map(r => r.id), ['r5']);
});
