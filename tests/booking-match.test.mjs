// Calendly events applied to a pilot request, through the real exported function with a fake store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBookingEvent, requestIdFor } from '../api/_booking-match.js';

function store(seed = {}) {
    const hash = new Map(), str = new Map();
    for (const [k, v] of Object.entries(seed)) hash.set(k, new Map(Object.entries(v)));
    const h = (k) => { if (!hash.has(k)) hash.set(k, new Map()); return hash.get(k); };
    return {
        _: { hash, str }, failHset: false,
        async hgetall(k) { const m = hash.get(k); return m ? Object.fromEntries(m) : null; },
        async hset(k, o) { if (this.failHset) throw new Error('down'); const m = h(k); for (const [f, v] of Object.entries(o)) m.set(f, String(v)); return 1; },
        async set(k, v, opt = {}) { if (opt.nx && str.has(k)) return null; str.set(k, String(v)); return 'OK'; },
        async get(k) { return str.has(k) ? str.get(k) : null; },
        async eval(s, keys, args) { if (str.get(keys[0]) === args[0]) { str.delete(keys[0]); return 1; } return 0; },
    };
}
const EMAIL = 'dana@example.com';
const ID = requestIdFor(EMAIL);
const REQ = { id: ID, email: EMAIL, name: 'Dana', state: 'ANSWERED', createdAt: '2026-09-21T12:00:00Z' };
const RIGHT = 'https://api.calendly.com/event_types/OWNERS15';
// updated_at is when Calendly changed the record, which is not the meeting time. Defaulting it to
// the start time is what hid an ordering bug: a cancellation looked older than a future booking.
const created = (uri, start, over = {}) => ({ event: 'invitee.created', payload: {
    uri, email: EMAIL, updated_at: '2026-09-22T09:00:00Z',
    scheduled_event: { uri: 'ev-' + uri, event_type: RIGHT, name: 'Owner workflow, 15 minutes', start_time: start },
    ...over } });
const canceled = (uri, when, over = {}) => ({ event: 'invitee.canceled', payload: {
    uri, email: EMAIL, updated_at: when,
    scheduled_event: { event_type: RIGHT, name: 'Owner workflow, 15 minutes', start_time: when },
    cancellation: { reason: 'something came up' }, ...over } });
const deps = (s, over = {}) => ({ redis: s, now: () => Date.parse('2026-09-22T09:00:00Z'), expected: () => [RIGHT], ...over });

test('a booking on the verified event type books it and switches off the generic nurture', async () => {
    const s = store({ [ID]: REQ });
    const out = await applyBookingEvent(created('inv-1', '2026-09-25T18:00:00Z'), deps(s));
    assert.equal(out.applied, true);
    assert.equal(out.state, 'BOOKED');
    const rec = await s.hgetall(ID);
    assert.equal(rec.state, 'BOOKED');
    assert.equal(rec.bookingRef, 'inv-1');
    assert.equal(rec.agreedFor, '2026-09-25T18:00:00Z');
    assert.equal(rec.nurtureSuppressed, 'true');
});

test('an event type we have not verified for this audience is held for review, not booked', async () => {
    const s = store({ [ID]: REQ });
    const ev = created('inv-x', '2026-09-25T18:00:00Z');
    ev.payload.scheduled_event.event_type = 'https://api.calendly.com/event_types/SOMETHING_ELSE';
    ev.payload.scheduled_event.name = 'Lead generation call';
    const out = await applyBookingEvent(ev, deps(s));
    assert.equal(out.state, 'BOOKING_REVIEW');
    const rec = await s.hgetall(ID);
    assert.equal(rec.state, 'BOOKING_REVIEW');
    assert.equal(rec.agreedFor, '', 'nothing is presented as an agreed time');
    assert.equal(rec.bookingProposedFor, '2026-09-25T18:00:00Z');
    assert.match(rec.bookingReviewReason, /not one of the event types verified/);
});

test('with no event types configured a booking is held rather than assumed', async () => {
    const s = store({ [ID]: REQ });
    const out = await applyBookingEvent(created('inv-1', '2026-09-25T18:00:00Z'), deps(s, { expected: () => [] }));
    assert.equal(out.state, 'BOOKING_REVIEW');
    assert.match((await s.hgetall(ID)).bookingReviewReason, /PILOT_EVENT_TYPES is not configured/);
});

test('a persistence failure does not mark the event applied, so the retry still works', async () => {
    const s = store({ [ID]: REQ });
    s.failHset = true;
    const first = await applyBookingEvent(created('inv-1', '2026-09-25T18:00:00Z'), deps(s));
    assert.equal(first.applied, false);
    assert.equal(first.retryable, true);
    assert.equal((await s.hgetall(ID)).bookingApplied, undefined, 'nothing was claimed');

    s.failHset = false;
    const retry = await applyBookingEvent(created('inv-1', '2026-09-25T18:00:00Z'), deps(s));
    assert.equal(retry.applied, true, 'the retry is not swallowed as a duplicate');
    assert.equal((await s.hgetall(ID)).state, 'BOOKED');
});

test('the same event twice is applied once', async () => {
    const s = store({ [ID]: REQ });
    await applyBookingEvent(created('inv-1', '2026-09-25T18:00:00Z'), deps(s));
    const again = await applyBookingEvent(created('inv-1', '2026-09-25T18:00:00Z'), deps(s));
    assert.equal(again.duplicate, true);
});

test('cancelling the live booking cancels it, and does not leave a time nobody is holding', async () => {
    const s = store({ [ID]: REQ });
    await applyBookingEvent(created('inv-1', '2026-09-25T18:00:00Z'), deps(s));
    const out = await applyBookingEvent(canceled('inv-1', '2026-09-23T10:00:00Z'), deps(s));
    assert.equal(out.state, 'CANCELED');
    const rec = await s.hgetall(ID);
    assert.equal(rec.state, 'CANCELED');
    assert.equal(rec.bookingRef, '');
    assert.equal(rec.agreedFor, '', 'the stale time is gone');
    assert.match(rec.bookingCanceledReason, /something came up/);
});

test('a reschedule: the late cancel of the old invitee does not kill the new booking', async () => {
    const s = store({ [ID]: REQ });
    await applyBookingEvent(created('inv-1', '2026-09-25T18:00:00Z'), deps(s));
    // The new booking lands first, as Calendly often delivers it.
    await applyBookingEvent(created('inv-2', '2026-09-30T18:00:00Z', { rescheduled: true, old_invitee: 'inv-1' }), deps(s));
    // Then the cancellation of the one it replaced turns up.
    const late = await applyBookingEvent(canceled('inv-1', '2026-09-26T10:00:00Z'), deps(s));
    assert.equal(late.superseded, true);
    const rec = await s.hgetall(ID);
    assert.equal(rec.state, 'BOOKED', 'the meeting that is actually happening survives');
    assert.equal(rec.bookingRef, 'inv-2');
    assert.equal(rec.agreedFor, '2026-09-30T18:00:00Z');
    assert.equal(rec.bookingSupersededCancelOf, 'inv-1');
});

test('an older event arriving after a newer one is recorded and ignored', async () => {
    const s = store({ [ID]: REQ });
    await applyBookingEvent(created('inv-2', '2026-09-30T18:00:00Z', { updated_at: '2026-09-24T10:00:00Z' }), deps(s));
    const old = await applyBookingEvent(created('inv-3', '2026-09-20T18:00:00Z', { updated_at: '2026-09-22T10:00:00Z' }), deps(s));
    assert.equal(old.stale, true);
    const rec = await s.hgetall(ID);
    assert.equal(rec.bookingRef, 'inv-2');
    assert.match(rec.bookingOutOfOrderNote, /arrived after a newer event/);
});

test('a late event never reopens a closed, suppressed or paid record', async () => {
    for (const [field, value] of [['state', 'CLOSED'], ['suppressed', 'true'], ['paymentReference', 'qbo:p1']]) {
        const s = store({ [ID]: { ...REQ, [field]: value } });
        const out = await applyBookingEvent(created('inv-9', '2026-09-30T18:00:00Z'), deps(s));
        assert.equal(out.applied, false, field);
        assert.equal(out.ignored, true, field);
        assert.notEqual((await s.hgetall(ID)).state, 'BOOKED', field);
    }
});

test('two events for the same person at once do not interleave', async () => {
    const s = store({ [ID]: REQ });
    const [a, b] = await Promise.all([
        applyBookingEvent(created('inv-1', '2026-09-25T18:00:00Z'), deps(s)),
        applyBookingEvent(created('inv-2', '2026-09-26T18:00:00Z'), deps(s)),
    ]);
    const held = [a, b].filter((x) => /being applied/.test(x.reason || ''));
    assert.equal(held.length, 1, 'one of them was asked to come back');
    assert.equal(held[0].retryable, true, 'and Calendly will, because we answer retryable');
});

test('a booking for somebody with no inbound request touches nothing', async () => {
    const s = store({});
    const out = await applyBookingEvent(created('inv-1', '2026-09-25T18:00:00Z'), deps(s));
    assert.equal(out.matched, false);
    assert.equal(s._.hash.size, 0);
});
