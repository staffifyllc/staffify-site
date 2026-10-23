// Hub activity: the definitions, held to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionize, sessionsOn, summarizeDay, daysBetween, dayOf, minuteOf, recordActivity, K, SESSION_GAP_MS, MEASURED_TEXT } from '../api/_hub-activity.js';

const T = iso => Date.parse(iso);

test('ET day and minute are read in New York time, not UTC', () => {
    assert.equal(dayOf(T('2026-10-23T03:30:00Z')), '2026-10-22', '11:30 pm ET the night before');
    assert.equal(minuteOf(T('2026-10-23T03:30:00Z')), 23 * 60 + 30);
    assert.equal(minuteOf(T('2026-10-23T20:05:00Z')), 16 * 60 + 5);
});

test('a session starts on the first signal, lives through heartbeats, and ends after thirty quiet minutes at the last thing seen', () => {
    let r = sessionize(null, T('2026-10-23T20:00:00Z'), { page: '/dialer/' });
    assert.equal(r.started, true); assert.equal(r.doc.current.start, '2026-10-23T20:00:00.000Z'); assert.equal(r.doc.current.firstPage, '/dialer/');
    r = sessionize(r.doc, T('2026-10-23T20:01:00Z')); assert.equal(r.started, false); assert.equal(r.doc.current.lastSeen, '2026-10-23T20:01:00.000Z');
    r = sessionize(r.doc, T('2026-10-23T20:29:00Z')); assert.equal(r.started, false, 'inside the gap, same session');
    r = sessionize(r.doc, T('2026-10-23T21:00:00Z')); assert.equal(r.started, true, 'after the gap, a new session');
    assert.equal(r.doc.recent.length, 1); assert.equal(r.doc.recent[0].reason, 'timeout'); assert.equal(r.doc.recent[0].endedAt, '2026-10-23T20:29:00.000Z', 'ended when last seen, not when noticed');
    const left = sessionize(r.doc, T('2026-10-23T21:10:00Z'), { kind: 'leave' });
    assert.equal(left.ended, true); assert.equal(left.doc.current, null); assert.equal(left.doc.recent[0].reason, 'left'); assert.equal(left.doc.recent[0].lastSeen, '2026-10-23T21:10:00.000Z');
    assert.equal(sessionize(left.doc, T('2026-10-23T21:11:00Z'), { kind: 'leave' }).ended, true, 'a second leave is harmless');
    assert.equal(SESSION_GAP_MS, 30 * 60000);
});

test('a day is summarised from a minute set, so two tabs in one minute count once, and idle is elapsed minus active', () => {
    const sessions = [{ start: '2026-10-23T20:00:00Z', lastSeen: '2026-10-23T20:40:00Z', reason: 'timeout' }, { start: '2026-10-23T22:00:00Z', lastSeen: '2026-10-23T22:10:00Z', reason: 'open' }];
    const events = [{ at: '2026-10-23T20:05:00Z', kind: 'call_outcome' }, { at: '2026-10-23T20:06:00Z', kind: 'note_saved' }, { at: '2026-10-23T20:06:30Z', kind: 'page_view' }, { at: '2026-10-23T22:05:00Z', kind: 'task_added' }];
    const d = summarizeDay({ day: '2026-10-23', minutes: [960, 961, 962, 962, '963', 1320], sessions, events });
    assert.equal(d.activeMinutes, 5, 'duplicate minutes count once');
    assert.equal(d.elapsedMinutes, 50); assert.equal(d.idleMinutes, 45);
    assert.equal(d.sessions, 2); assert.equal(d.meaningful, 3, 'page views are not actions');
    assert.deepEqual(d.counts, { call_outcome: 1, note_saved: 1, page_view: 1, task_added: 1 });
    assert.equal(d.firstSeen, '2026-10-23T20:05:00Z'); assert.equal(d.lastSeen, '2026-10-23T22:05:00Z'); assert.equal(d.measured, true);
    const none = summarizeDay({ day: '2026-10-19' });
    assert.equal(none.measured, false, 'a day with nothing is not measured, not zero');
    assert.equal(summarizeDay({ day: 'x', minutes: [1, 2, 3], sessions: [{ start: '2026-10-23T20:00:00Z', lastSeen: '2026-10-23T20:01:00Z' }] }).idleMinutes, 0, 'idle never goes negative');
});

test('sessions are clipped to the day they touch; days between are inclusive and bounded', () => {
    const doc = { current: { start: '2026-10-23T21:00:00Z', lastSeen: '2026-10-23T21:30:00Z' }, recent: [{ start: '2026-10-22T20:00:00Z', lastSeen: '2026-10-22T20:30:00Z', endedAt: '2026-10-22T20:30:00Z', reason: 'timeout' }] };
    assert.deepEqual(sessionsOn(doc, '2026-10-23').map(s => s.reason), ['open']);
    assert.deepEqual(sessionsOn(doc, '2026-10-22').map(s => s.reason), ['timeout']);
    assert.deepEqual(sessionsOn(doc, '2026-10-21'), []);
    assert.deepEqual(daysBetween('2026-10-19', '2026-10-23'), ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
    assert.deepEqual(daysBetween('2026-10-23', '2026-10-19'), []);
});

test('recordActivity writes the event, the minute and the session, and refuses what it should', async () => {
    const m = new Map(); const sets = new Map(); const lists = new Map();
    const redis = { async lpush(k, v) { lists.set(k, [v, ...(lists.get(k) || [])]); }, async ltrim() {}, async expire() {}, async sadd(k, v) { sets.set(k, new Set([...(sets.get(k) || []), v])); }, async get(k) { return m.get(k) ?? null; }, async set(k, v) { m.set(k, v); } };
    const at = T('2026-10-23T20:05:30Z');
    assert.equal(await recordActivity(redis, { email: 'Milton@TryStaffify.com', kind: 'call_outcome', page: '/dialer/', detail: 'Loft & Light · voicemail', at }), true);
    const ev = JSON.parse(lists.get(K.events('milton@trystaffify.com', '2026-10-23'))[0]);
    assert.equal(ev.kind, 'call_outcome'); assert.equal(ev.detail, 'Loft & Light · voicemail'); assert.equal(ev.at, '2026-10-23T20:05:30.000Z');
    assert.ok(sets.get(K.minutes('milton@trystaffify.com', '2026-10-23')).has(16 * 60 + 5));
    assert.ok(sets.get(K.days('milton@trystaffify.com')).has('2026-10-23'));
    assert.equal(m.get(K.sessions('milton@trystaffify.com')).current.start, '2026-10-23T20:05:30.000Z');
    assert.equal(await recordActivity(redis, { email: 'admin', kind: 'call_outcome' }), false, 'an admin token is not a person');
    assert.equal(await recordActivity(redis, { email: 'a@b.com', kind: 'keystroke' }), false, 'only known kinds');
    assert.equal(await recordActivity({ async lpush() { throw new Error('down'); } }, { email: 'a@b.com', kind: 'call_outcome' }), false, 'a store failure never throws into the caller');
    assert.ok(MEASURED_TEXT.some(t => /not payroll/.test(t)) && MEASURED_TEXT.some(t => /never recorded/.test(t)));
});
