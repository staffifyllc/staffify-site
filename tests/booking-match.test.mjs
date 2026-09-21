// Calendly events applied to a pilot request, through the real exported function with a fake store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBookingEvent, requestIdFor, PILOT_EVENT } from '../api/_booking-match.js';

function store(seed = {}) {
    const hash = new Map(), str = new Map();
    for (const [k, v] of Object.entries(seed)) hash.set(k, new Map(Object.entries(v)));
    const h = (k) => { if (!hash.has(k)) hash.set(k, new Map()); return hash.get(k); };
    const z = new Map();
    return {
        _: { hash, str, z }, failHset: false, failZadd: false, failAfterField: '',
        async hsetnx(k, f, v) {
            if (this.failHset) throw new Error('down');
            const m = h(k);
            // Fail partway through the field writes, which is the orphaning shape.
            if (this.failAfterField && m.has(this.failAfterField) && f !== this.failAfterField) throw new Error('down');
            if (m.has(f)) return 0;
            m.set(f, String(v)); return 1;
        },
        async zadd(k, { member }) { if (this.failZadd) throw new Error('down'); if (!z.has(k)) z.set(k, new Set()); z.get(k).add(member); return 1; },
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

test('a booking with no request gets its own opportunity, queued before it is acknowledged', async () => {
    // This used to assert that nothing happened, which was right before the owner page offered the
    // fifteen minutes directly. The booking is the evidence now and it gets a record, but only once
    // the record is indexed and queued, because nothing else scans for unsynced ones.
    const q = [];
    const s = store({});
    const out = await applyBookingEvent(created('inv-1', '2026-09-25T18:00:00Z'),
        deps(s, { enqueueSync: async (_r, id) => { q.push(id); return { ok: true }; } }));
    assert.equal(out.created, true);
    assert.equal(out.state, 'BOOKED');
    const rec = await s.hgetall(ID);
    assert.equal(rec.origin, 'direct_booking');
    assert.equal(rec.originComplete, 'true');
    assert.deepEqual(q, [ID]);
});

// ---------- somebody books without ever filling in the form ----------
//
// The owner page offers the fifteen minutes directly now, so this path exists and used to drop the
// booking on the floor: it matched nothing and lived only in Calendly.

const queued = [];
const withQueue = (st, over = {}) => deps(st, { enqueueSync: async (_r, id) => { queued.push(id); return { ok: true }; }, ...over });

test('a direct booking on the media-owner event creates its own opportunity', async () => {
    queued.length = 0;
    const s = store({});                       // nothing on file for this person at all
    const ev = created('inv-d1', '2026-09-30T18:00:00Z');
    ev.payload.name = 'Dana Okafor';
    ev.payload.questions_and_answers = [{ question: 'What is one task that keeps coming back to you?', answer: 'Checking every file before it goes out.' }];
    const out = await applyBookingEvent(ev, withQueue(s));

    assert.equal(out.applied, true);
    assert.equal(out.created, true);
    assert.equal(out.state, 'BOOKED');
    assert.equal(out.origin, 'direct_booking');

    const rec = await s.hgetall(ID);
    assert.equal(rec.origin, 'direct_booking');
    assert.equal(rec.submittedForm, 'false', 'a booking is never recorded as a form submission');
    assert.equal(rec.nurtureSuppressed, 'true');
    assert.equal(rec.name, 'Dana Okafor');
    assert.equal(rec.pain, 'Checking every file before it goes out.', 'their own words are kept');
    assert.match(rec.originEvidence, /booked "Owner workflow, 15 minutes" directly/);
    assert.equal(rec.originInvitee, 'inv-d1');
    assert.equal(rec.bookingRef, 'inv-d1');
    assert.equal(rec.syncState, 'pending');
    assert.deepEqual(queued, [ID], 'and it is queued for the guarded CRM sync');
    assert.ok(s._.z.get('pilot:requests').has(ID), 'it appears in the operator queue');
});

test('the same direct booking delivered twice makes one opportunity', async () => {
    queued.length = 0;
    const s = store({});
    const ev = created('inv-d1', '2026-09-30T18:00:00Z');
    const first = await applyBookingEvent(ev, withQueue(s));
    const again = await applyBookingEvent(ev, withQueue(s));
    assert.equal(first.created, true);
    assert.equal(again.applied, false);
    assert.equal(again.duplicate, true, 'the second delivery is recognised, not re-created');
    assert.equal(s._.hash.size, 1, 'one record');
    assert.equal((await s.hgetall(ID)).submissions, undefined);
    assert.deepEqual(queued, [ID], 'and it was queued once');
});

test('a direct booking on somebody else different event is left alone', async () => {
    queued.length = 0;
    const s = store({});
    const ev = created('inv-x', '2026-09-30T18:00:00Z');
    ev.payload.scheduled_event.event_type = 'https://api.calendly.com/event_types/SOMETHING_ELSE';
    ev.payload.scheduled_event.name = 'Lead generation call';
    const out = await applyBookingEvent(ev, withQueue(s));
    assert.equal(out.applied, false);
    assert.equal(out.matched, false);
    assert.match(out.reason, /not the media-owner event/);
    assert.equal(s._.hash.size, 0, 'nothing was invented');
    assert.deepEqual(queued, []);
});

test('a cancellation for somebody we hold nothing for creates nothing', async () => {
    const s = store({});
    const out = await applyBookingEvent(canceled('inv-gone', '2026-09-23T10:00:00Z'), withQueue(s));
    assert.equal(out.applied, false);
    assert.equal(out.matched, false);
    assert.equal(s._.hash.size, 0);
});

test('a direct booking that cannot be written is retryable, and nothing is half made', async () => {
    const s = store({});
    s.failHset = true;
    const out = await applyBookingEvent(created('inv-d9', '2026-09-30T18:00:00Z'), withQueue(s));
    assert.equal(out.applied, false);
    assert.equal(out.retryable, true, 'so Calendly sends it again');
});

test('an existing record is never overwritten by a direct booking path', async () => {
    queued.length = 0;
    const s = store({ [ID]: { ...REQ, origin: 'inbound', submittedForm: 'true', pain: 'what they typed in the form' } });
    const out = await applyBookingEvent(created('inv-d2', '2026-09-30T18:00:00Z'), withQueue(s));
    assert.equal(out.created, undefined === out.created ? undefined : false);
    const rec = await s.hgetall(ID);
    assert.equal(rec.origin, 'inbound', 'their original origin stands');
    assert.equal(rec.submittedForm, 'true');
    assert.equal(rec.pain, 'what they typed in the form', 'and what they wrote is not replaced');
    assert.equal(rec.bookingRef, 'inv-d2');
    assert.deepEqual(queued, [], 'an existing record is already in the queue lifecycle');
});

test('the pinned event is the one the page links to', () => {
    assert.equal(PILOT_EVENT.minutes, 15);
    assert.match(PILOT_EVENT.url, /media-owner-workflow-chat$/);
    assert.match(PILOT_EVENT.uri, /^https:\/\/api\.calendly\.com\/event_types\//);
});

// ---------- creation has to finish, or be resumable ----------

test('a failure partway through the fields leaves nothing acknowledged, and the retry completes it', async () => {
    const q1 = [];
    const s = store({});
    s.failAfterField = 'email';                       // dies right after the email is written
    const ev = created('inv-h1', '2026-09-30T18:00:00Z');
    const first = await applyBookingEvent(ev, deps(s, { enqueueSync: async (_r, id) => { q1.push(id); return { ok: true }; } }));
    assert.equal(first.applied, false);
    assert.equal(first.retryable, true);
    assert.equal((await s.hgetall(ID)).originComplete, undefined, 'it is not marked complete');
    assert.deepEqual(q1, [], 'and nothing was queued for a record that is not finished');

    s.failAfterField = '';
    const second = await applyBookingEvent(ev, deps(s, { enqueueSync: async (_r, id) => { q1.push(id); return { ok: true }; } }));
    const rec = await s.hgetall(ID);
    assert.equal(rec.originComplete, 'true', 'the retry finished the job');
    assert.equal(rec.origin, 'direct_booking');
    assert.deepEqual(q1, [ID], 'and queued it exactly once');

    // The SAME successful retry applies the booking. There is no third delivery to rely on: a 200
    // tells Calendly the event is done with.
    assert.equal(second.applied, true, 'the retry applied the event, it did not defer it');
    assert.equal(second.healed, true);
    assert.equal(second.state, 'BOOKED');
    assert.equal(rec.state, 'BOOKED');
    assert.equal(rec.bookingRef, 'inv-h1');
    assert.ok(String(rec.bookingApplied || '').length > 0, 'and the event marker is down');
});

test('exactly one write after the email, then a clean retry, needs no third delivery', async () => {
    const q = [];
    const enqueue = async (_r, id) => { q.push(id); return { ok: true }; };
    const s = store({});
    s.failAfterField = 'email';
    const ev = created('inv-h7', '2026-10-02T18:00:00Z');
    const a = await applyBookingEvent(ev, deps(s, { enqueueSync: enqueue }));
    assert.equal(a.applied, false, 'nothing acknowledged');
    const mid = await s.hgetall(ID);
    assert.equal(mid.email, EMAIL, 'the email is there');
    assert.equal(mid.originComplete, undefined, 'and the record is visibly unfinished');
    assert.equal(mid.originPending !== undefined || mid.origin === 'direct_booking', true,
        'with a marker that makes it resumable');

    s.failAfterField = '';
    const b = await applyBookingEvent(ev, deps(s, { enqueueSync: enqueue }));
    assert.equal(b.applied, true);
    assert.equal((await s.hgetall(ID)).state, 'BOOKED');
    assert.deepEqual(q, [ID]);
});

test('an index that will not write is not acknowledged either', async () => {
    const q = [];
    const s = store({});
    s.failZadd = true;
    const out = await applyBookingEvent(created('inv-h2', '2026-09-30T18:00:00Z'),
        deps(s, { enqueueSync: async (_r, id) => { q.push(id); return { ok: true }; } }));
    assert.equal(out.applied, false);
    assert.equal(out.retryable, true);
    assert.match(out.reason, /could not be indexed/);
    assert.deepEqual(q, [], 'nothing is queued for a record nobody can see');
    assert.equal((await s.hgetall(ID)).originComplete, undefined);
});

test('a failed enqueue is never shrugged off, because nothing else scans for unsynced records', async () => {
    const s = store({});
    const out = await applyBookingEvent(created('inv-h3', '2026-09-30T18:00:00Z'),
        deps(s, { enqueueSync: async () => ({ ok: false, error: 'redis down' }) }));
    assert.equal(out.applied, false);
    assert.equal(out.retryable, true);
    assert.match(out.reason, /could not be queued for the CRM/);
    assert.equal((await s.hgetall(ID)).originComplete, undefined);
    assert.equal((await s.hgetall(ID)).bookingApplied, undefined, 'and the event was not marked applied');
});

test('an enqueue that throws is treated the same as one that refuses', async () => {
    const s = store({});
    const out = await applyBookingEvent(created('inv-h4', '2026-09-30T18:00:00Z'),
        deps(s, { enqueueSync: async () => { throw new Error('boom'); } }));
    assert.equal(out.retryable, true);
    assert.match(out.reason, /could not be queued/);
});

test('with no queue wired at all the booking is not acknowledged', async () => {
    const s = store({});
    const out = await applyBookingEvent(created('inv-h5', '2026-09-30T18:00:00Z'), deps(s));
    assert.equal(out.applied, false);
    assert.equal(out.retryable, true);
    assert.match(out.reason, /nothing else would ever pick this booking up/);
});

test('healing an incomplete record queues once and never touches suppression', async () => {
    const q = [];
    const enqueue = async (_r, id) => { q.push(id); return { ok: true }; };
    const s = store({ [ID]: { id: ID, email: EMAIL, origin: 'direct_booking', suppressed: 'true', state: 'CLOSED' } });
    // Suppressed and closed: the heal must complete the record without reopening anything.
    const out = await applyBookingEvent(created('inv-h6', '2026-09-30T18:00:00Z'), deps(s, { enqueueSync: enqueue }));
    const rec = await s.hgetall(ID);
    assert.equal(rec.suppressed, 'true', 'suppression is untouched');
    assert.equal(rec.state, 'CLOSED', 'and so is the closed state');
    assert.equal(out.ignored, true, 'a suppressed record is left alone even while its creation is healed');
    assert.ok(q.length <= 1, 'and it is queued at most once');
});
