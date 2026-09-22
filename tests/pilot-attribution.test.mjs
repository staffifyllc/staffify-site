import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaBookingUrl, bookingAttribution } from '../assets/js/pilot-attribution.js';

test('campaign source and variant survive the booking hop', () => {
    const url = new URL(mediaBookingUrl({ utmSource: 'founder', utmMedium: 'email',
        utmCampaign: 'owner-pilot-1', utmContent: 'handoff-a' }));
    assert.equal(url.searchParams.get('utm_campaign'), 'owner-pilot-1');
    assert.equal(url.searchParams.get('utm_source'), 'founder');
    assert.equal(url.searchParams.get('utm_content'), 'handoff-a');
    assert.deepEqual(bookingAttribution(Object.fromEntries(url.searchParams)), {
        utmSource: 'founder', utmMedium: 'email', utmCampaign: 'owner-pilot-1', utmContent: 'handoff-a',
    });
});

test('booking forwards only bounded campaign labels, not arbitrary data', () => {
    const url = new URL(mediaBookingUrl({ email: 'person@example.com', lid: 'private-record-id',
        utmSource: 'person@example.com', utmContent: 'https://private.example/a', utmCampaign: 'x'.repeat(101) }));
    assert.deepEqual([...url.searchParams.keys()], ['utm_source', 'utm_content']);
    assert.equal(url.searchParams.get('utm_source'), 'real-estate-media');
    assert.equal(url.searchParams.get('utm_content'), 'owner-page');
    assert.deepEqual(bookingAttribution({ utm_campaign: { secret: true }, arbitrary: 'not-a-field' }), {});
});
