// Area code to time zone: the lookup behind "the prospect's local time" on the Caller review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zoneForNumber, localClock } from '../api/_area-time.js';

test('area codes map to their zone, in any number format, with a leading 1 or without', () => {
    assert.equal(zoneForNumber('2125550100'), 'America/New_York');
    assert.equal(zoneForNumber('+1 (312) 555-0100'), 'America/Chicago');
    assert.equal(zoneForNumber('1-303-555-0100'), 'America/Denver');
    assert.equal(zoneForNumber('602.555.0100'), 'America/Phoenix');
    assert.equal(zoneForNumber('4155550100'), 'America/Los_Angeles');
    assert.equal(zoneForNumber('9055550100'), 'America/Toronto');
});

test('a split area code is settled by the exchange where the data has one, and unknown where it has two zones', () => {
    assert.equal(zoneForNumber('2702020000'), 'America/Chicago', '270-202 is western Kentucky');
    assert.equal(zoneForNumber('2709990000'), 'America/New_York', 'the rest of 270 falls back to the area code');
    assert.equal(zoneForNumber('4232650000'), 'America/New_York', '423-265 is Chattanooga, Eastern');
    assert.equal(zoneForNumber('6055550100'), null, '605 spans Central and Mountain: unknown, never guessed');
    assert.equal(zoneForNumber('6895551234'), 'America/New_York', '689 overlays Orlando; the source data says Central');
    for (const n of ['4485551234', '3645551234', '9305551234']) assert.equal(zoneForNumber(n), null, n + ' overlays a split area code');
});

test('anything that is not a ten-digit North American number has no zone', () => {
    for (const n of [null, '', '1234', '555-0100', '44 20 7946 0958', '12125550100999']) assert.equal(zoneForNumber(n), null, String(n));
});

test('the local clock follows daylight time for that zone', () => {
    assert.deepEqual(localClock('2026-10-26T23:00:00Z', '4155550100'), { zone: 'America/Los_Angeles', hour: 16, minute: 0 });
    assert.deepEqual(localClock('2026-10-26T23:00:00Z', '2125550100'), { zone: 'America/New_York', hour: 19, minute: 0 });
    assert.deepEqual(localClock('2026-12-26T23:00:00Z', '2125550100'), { zone: 'America/New_York', hour: 18, minute: 0 }, 'standard time in December');
    assert.deepEqual(localClock('2026-10-26T23:30:00Z', '6025550100'), { zone: 'America/Phoenix', hour: 16, minute: 30 }, 'Arizona has no daylight time');
    assert.equal(localClock('not a time', '2125550100'), null);
    assert.equal(localClock('2026-10-26T23:00:00Z', '6055550100'), null);
});
