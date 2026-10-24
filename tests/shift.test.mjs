// Declared shifts: the state machine, the durations, the gate, the correction rule. Pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withholdPhones, stateOf, gate, start, startBreak, resume, end, correct, minutesOf, summarizeShifts, shiftRequired, MAX_OPEN_MS, GATE_TEXT, DECLARED_TEXT, K } from '../api/_shift.js';

const T = iso => Date.parse(iso);

test('start, break, resume, end: server times only, one shift at a time, nothing backdated', () => {
    const s = start(null, T('2026-10-23T20:00:00Z'), { page: '/dialer/' });
    assert.equal(s.ok, true); assert.equal(s.doc.startedAt, '2026-10-23T20:00:00.000Z'); assert.equal(s.doc.day, '2026-10-23'); assert.equal(s.doc.status, 'open'); assert.equal(s.archived, null);
    assert.equal(stateOf(s.doc, T('2026-10-23T20:01:00Z')), 'on');
    const again = start(s.doc, T('2026-10-23T20:00:30Z'));
    assert.equal(again.ok, false); assert.equal(again.error, 'already_on_shift', 'a second tab cannot open a second shift');
    assert.equal(startBreak(null, 0).error, 'not_on_shift'); assert.equal(resume(s.doc, T('2026-10-23T20:05:00Z')).error, 'not_on_break');
    const b = startBreak(s.doc, T('2026-10-23T20:30:00Z'));
    assert.equal(stateOf(b.doc, T('2026-10-23T20:31:00Z')), 'break'); assert.equal(startBreak(b.doc, T('2026-10-23T20:31:00Z')).error, 'already_on_break');
    const r = resume(b.doc, T('2026-10-23T20:40:00Z'));
    assert.equal(stateOf(r.doc, T('2026-10-23T20:41:00Z')), 'on'); assert.deepEqual(r.doc.breaks, [{ startedAt: '2026-10-23T20:30:00.000Z', endedAt: '2026-10-23T20:40:00.000Z' }]);
    const e = end(r.doc, T('2026-10-23T21:00:00Z'));
    assert.equal(e.doc.status, 'closed'); assert.equal(e.doc.endedAt, '2026-10-23T21:00:00.000Z'); assert.deepEqual(e.doc.flags, []);
    assert.deepEqual(minutesOf(e.doc), { elapsedMinutes: 60, breakMinutes: 10, clockedMinutes: 50 }, 'clocked is end minus start minus breaks; Hub idle is never deducted');
    const onBreak = end(b.doc, T('2026-10-23T20:45:00Z'));
    assert.equal(onBreak.doc.breaks[0].endedAt, '2026-10-23T20:45:00.000Z', 'ending while on a break closes the break at the end');
    assert.equal(minutesOf(onBreak.doc).clockedMinutes, 30);
    assert.equal(end(null, 0).error, 'not_on_shift');
});

test('a shift open past twelve hours is stale: it allows nothing, and ending it flags it rather than counting it', () => {
    const s = start(null, T('2026-10-24T00:00:00Z')).doc;
    const later = T('2026-10-24T00:00:00Z') + MAX_OPEN_MS;
    assert.equal(stateOf(s, later - 1), 'on'); assert.equal(stateOf(s, later), 'stale');
    assert.equal(startBreak(s, later).error, 'shift_too_long'); assert.equal(resume(s, later).error, 'shift_too_long');
    const e = end(s, later + 3600000);
    assert.equal(e.doc.status, 'needs_review'); assert.deepEqual(e.doc.flags, ['open_over_12h']); assert.equal(e.doc.endedAt, new Date(later + 3600000).toISOString(), 'the real press time is kept');
    const sum = summarizeShifts([e.doc], later + 7200000);
    assert.equal(sum.clockedMinutes, 0, 'not counted until an owner reviews it'); assert.equal(sum.needsReview, 1); assert.equal(sum.list[0].state, 'needs_review');
    // Pressing Start on top of a forgotten shift archives it with NO end time. Nobody invents one.
    const next = start(s, later + 3600000, { page: '/my-day/' });
    assert.equal(next.ok, true); assert.equal(next.archived.endedAt, null); assert.equal(next.archived.status, 'needs_review'); assert.deepEqual(next.archived.flags, ['open_over_12h', 'never_ended']);
    assert.equal(next.archived.archivedAt, new Date(later + 3600000).toISOString()); assert.equal(next.doc.day, '2026-10-24');
});

test('summaries: open counts so far, closed and corrected count, the rest count nothing', () => {
    const now = T('2026-10-23T22:00:00Z');
    const open = start(null, T('2026-10-23T21:30:00Z')).doc;
    const closed = end(start(null, T('2026-10-23T18:00:00Z')).doc, T('2026-10-23T19:30:00Z')).doc;
    const sum = summarizeShifts([open, closed], now);
    assert.deepEqual(sum.list.map(s => s.state), ['closed', 'open'], 'sorted by start');
    assert.equal(sum.clockedMinutes, 90 + 30); assert.equal(sum.open, 1); assert.equal(sum.needsReview, 0); assert.equal(sum.shifts, 2);
    const tooLong = start(null, T('2026-10-23T05:00:00Z')).doc;
    const s2 = summarizeShifts([tooLong], now);
    assert.equal(s2.list[0].state, 'open_too_long'); assert.equal(s2.clockedMinutes, 0); assert.equal(s2.needsReview, 1);
    assert.deepEqual(summarizeShifts([], now), { list: [], clockedMinutes: 0, breakMinutes: 0, needsReview: 0, open: 0, shifts: 0 });
});

test('a correction shortens only, needs a note, and is kept next to the original', () => {
    const forgotten = { ...start(null, T('2026-10-23T20:00:00Z')).doc, endedAt: null, status: 'needs_review', flags: ['open_over_12h', 'never_ended'], archivedAt: '2026-10-24T13:00:00.000Z' };
    assert.equal(correct(forgotten, { endedAt: '2026-10-23T22:00:00Z', note: '', by: 'hello@gostaffify.com' }).error, 'note_required');
    assert.equal(correct(forgotten, { endedAt: 'yesterday', note: 'x', by: 'a' }).error, 'bad_time');
    assert.equal(correct(forgotten, { endedAt: '2026-10-23T19:00:00Z', note: 'x', by: 'a' }).error, 'before_start');
    assert.equal(correct(forgotten, { endedAt: '2026-10-24T14:00:00Z', note: 'x', by: 'a' }).error, 'cannot_lengthen', 'never past the moment it was archived');
    const r = correct(forgotten, { endedAt: '2026-10-23T22:00:00Z', note: 'Milton said he stopped at 6', by: 'Hello@gostaffify.com', at: T('2026-10-24T15:00:00Z') });
    assert.equal(r.ok, true); assert.equal(r.doc.status, 'corrected'); assert.equal(r.doc.correctedEndedAt, '2026-10-23T22:00:00.000Z'); assert.equal(r.doc.endedAt, null, 'the original end (none) is untouched');
    assert.deepEqual(r.doc.corrections, [{ by: 'hello@gostaffify.com', at: '2026-10-24T15:00:00.000Z', field: 'endedAt', from: null, to: '2026-10-23T22:00:00.000Z', note: 'Milton said he stopped at 6' }]);
    assert.equal(minutesOf(r.doc).clockedMinutes, 120);
    assert.equal(summarizeShifts([r.doc]).clockedMinutes, 120, 'a corrected shift counts');
    // A closed shift with a break after the corrected end: the break is clipped away.
    const closed = end(resume(startBreak(start(null, T('2026-10-23T20:00:00Z')).doc, T('2026-10-23T22:30:00Z')).doc, T('2026-10-23T22:40:00Z')).doc, T('2026-10-23T23:00:00Z')).doc;
    const c2 = correct(closed, { endedAt: '2026-10-23T22:00:00Z', note: 'left at 6, forgot End', by: 'a' });
    assert.deepEqual(minutesOf(c2.doc), { elapsedMinutes: 120, breakMinutes: 0, clockedMinutes: 120 });
    assert.equal(correct(closed, { endedAt: '2026-10-23T23:30:00Z', note: 'x', by: 'a' }).error, 'cannot_lengthen');
    assert.equal(correct(null, { endedAt: '2026-10-23T23:30:00Z', note: 'x', by: 'a' }).error, 'no_such_shift');
});

test('the gate: callers need a running shift; owners and the admin token never do', () => {
    const now = T('2026-10-23T20:10:00Z');
    assert.deepEqual(gate(null, now), { required: true, state: 'off', allowed: false, reason: 'off', message: GATE_TEXT.off });
    const on = start(null, T('2026-10-23T20:00:00Z')).doc;
    assert.equal(gate(on, now).allowed, true); assert.equal(gate(on, now).message, null);
    const br = startBreak(on, T('2026-10-23T20:05:00Z')).doc;
    assert.equal(gate(br, now).reason, 'break'); assert.match(gate(br, now).message, /Resume your shift/);
    assert.equal(gate(on, T('2026-10-24T09:00:00Z')).reason, 'stale'); assert.match(gate(on, T('2026-10-24T09:00:00Z')).message, /more than 12 hours/);
    assert.deepEqual(gate(null, now, { required: false }), { required: false, state: 'off', allowed: true, reason: null, message: null });
    const ownerFor = rep => (rep.email === 'hello@gostaffify.com' ? 'Paul' : rep.role === 'admin' ? 'all' : null);
    assert.equal(shiftRequired({ email: 'miltion@trystaffify.com', role: 'rep' }, ownerFor), true, 'Milton: rep role, no owner lane, caller plan: gated');
    assert.equal(shiftRequired({ email: 'hello@gostaffify.com', role: 'admin' }, ownerFor), false);
    assert.equal(shiftRequired({ email: 'admin', name: 'Admin', role: 'admin' }, ownerFor), false);
    assert.equal(shiftRequired(null, ownerFor), false);
    assert.ok(DECLARED_TEXT.some(t => /never deducted/.test(t)) && DECLARED_TEXT.some(t => /Hubstaff/.test(t)));
    assert.equal(K.current('Milton@TryStaffify.com'), 'shift:cur:milton@trystaffify.com');
});

test('a never-ended shift cannot be corrected past twelve hours', () => {
    const forgotten = { id: 'sh-x', startedAt: '2026-10-23T20:00:00.000Z', endedAt: null, archivedAt: '2026-10-25T20:00:00.000Z', status: 'needs_review', breaks: [], day: '2026-10-23' };
    assert.equal(correct(forgotten, { endedAt: '2026-10-24T09:00:00Z', note: 'x', by: 'a' }).error, 'cannot_lengthen', 'thirteen hours: refused');
    assert.equal(correct(forgotten, { endedAt: '2026-10-24T08:00:00Z', note: 'x', by: 'a' }).ok, true, 'twelve hours: allowed');
    assert.equal(minutesOf(forgotten).elapsedMinutes, 2880, 'an archived never-ended shift stops at its archive time, not now');
});

test('withholdPhones empties every phone field and nothing else', () => {
    const src = { records: [{ name: 'Tom', phone: '+19107695931', company: 'Riley', meta: { mobilephone: '+15125550001', zip: '28401' }, dial: { alternates: ['+15125550002'], label: 'x' } }], items: [{ email: 'a@b.com', phone: null, note: 'Call +15125550003 after 5' }] };
    const out = withholdPhones(src);
    assert.equal(out.records[0].phone, null); assert.equal(out.records[0].meta.mobilephone, null); assert.deepEqual(out.records[0].dial.alternates, []);
    assert.equal(out.records[0].meta.zip, '28401'); assert.equal(out.records[0].company, 'Riley');
    assert.equal(out.items[0].note, 'Call +15125550003 after 5', 'free text is not rewritten');
    assert.equal(src.records[0].phone, '+19107695931', 'the original is untouched');
    assert.equal(withholdPhones(undefined), null);
});
