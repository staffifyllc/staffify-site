// "Is Milton working right now, and when was he not": the pure part.
import test from 'node:test';
import assert from 'node:assert/strict';
import { minuteInstant, signals, shiftWindows, quietStretches, liveStatus, quietDay, QUIET_MS } from '../api/_live-status.js';

const DAY = '2026-10-27';
const et = hm => Date.parse(`${DAY}T${hm}:00-04:00`);
const iso = hm => new Date(et(hm)).toISOString();
const mOf = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };

test('an ET minute of the day maps to its instant, including across the fall-back day', () => {
    assert.equal(minuteInstant(DAY, mOf('16:05')), et('16:05'));
    assert.equal(minuteInstant('2026-12-01', 9 * 60), Date.parse('2026-12-01T09:00:00-05:00'));
    assert.equal(minuteInstant('2026-11-01', 12 * 60), Date.parse('2026-11-01T12:00:00-05:00'), 'Nov 1, 2026 is the day clocks go back');
});

test('quiet means 10 minutes on a running shift with no Hub minute and no Quo call; breaks and long calls are never quiet', () => {
    const shift = [{ startedAt: iso('16:00'), endedAt: iso('18:00'), state: 'closed', breaks: [{ startedAt: iso('17:00'), endedAt: iso('17:30') }] }];
    const minutes = ['16:00', '16:01', '16:02', '16:20', '16:21', '17:45'].map(mOf);
    const calls = [{ at: iso('16:30'), seconds: 25 * 60 }];       // a 25-minute call: 16:30 to 16:55
    const events = [{ at: iso('17:56'), kind: 'idle_prompt' }, { at: iso('17:57'), kind: 'idle_prompt_on_call' }];
    const d = quietDay({ day: DAY, minutes, calls, shiftList: shift, events, now: et('20:00') });
    assert.equal(d.onShiftMinutes, 90, 'two hours less a 30-minute break');
    assert.deepEqual(d.stretches.map(s => [s.from, s.to, s.minutes, s.prompted, s.answer]), [
        [iso('16:03'), iso('16:20'), 17, false, null],                              // before the call
        [iso('17:30'), iso('17:45'), 15, false, null],                              // back from the break, nothing until 5:45
        [iso('17:46'), iso('18:00'), 14, true, 'Said they were on a call'],
    ], 'the 25-minute call and the break are never quiet; 4:55 to 5:00 is under 10 minutes');
    assert.equal(d.quietMinutes, 46);
});

test('an open shift counts up to now, and a stretch still going is marked open', () => {
    const shift = [{ startedAt: iso('16:00'), endedAt: null, state: 'open', breaks: [] }];
    const d = quietDay({ day: DAY, minutes: [mOf('16:00')], calls: [], shiftList: shift, events: [], now: et('16:30') });
    assert.deepEqual(d.stretches.map(s => [s.minutes, s.open]), [[29, true]]);
    const flagged = quietDay({ day: DAY, minutes: [], calls: [], shiftList: [{ startedAt: iso('04:00'), endedAt: null, state: 'open_too_long', breaks: [] }], events: [], now: et('20:00') });
    assert.equal(flagged.onShiftMinutes, 0, 'a forgotten shift is not hours of quiet');
});

test('right now: working, on a call, quiet with or without an answered prompt, on break, off shift', () => {
    const current = { startedAt: iso('16:00'), breaks: [] };
    const now = et('17:00');
    const sig = signals({ day: DAY, minutes: [mOf('16:55')], calls: [], now });
    assert.deepEqual([liveStatus({ state: 'on', current, sig, now }).key, liveStatus({ state: 'on', current, sig, now }).quietMinutes], ['working', 4]);
    assert.equal(liveStatus({ state: 'on', current, sig: [], callInProgress: true, now }).key, 'call');
    const quiet = liveStatus({ state: 'on', current, sig: signals({ day: DAY, minutes: [mOf('16:30')], now }), events: [{ at: iso('16:41'), kind: 'idle_prompt' }], now });
    assert.deepEqual([quiet.key, quiet.label, quiet.prompt.answered], ['quiet', 'Quiet for 29 min', false]);
    const answered = liveStatus({ state: 'on', current, sig: signals({ day: DAY, minutes: [mOf('16:30')], now }), events: [{ at: iso('16:41'), kind: 'idle_prompt' }, { at: iso('16:42'), kind: 'idle_prompt_on_call' }], now });
    assert.equal(answered.prompt.answered, true);
    assert.equal(liveStatus({ state: 'break', current: { startedAt: iso('16:00'), breaks: [{ startedAt: iso('16:50') }] }, now }).since, iso('16:50'));
    assert.equal(liveStatus({ state: 'off', current: null, now }).key, 'off');
    const resumed = liveStatus({ state: 'on', current: { startedAt: iso('15:00'), breaks: [{ startedAt: iso('15:30'), endedAt: iso('16:55') }] }, sig: [], now });
    assert.equal(resumed.key, 'working', 'resumed five minutes ago: the 10 minutes start at the resume');
    assert.equal(QUIET_MS, 600000);
});

test('shift windows skip breaks, clip at now, and use an owner-corrected end', () => {
    assert.deepEqual(shiftWindows([{ startedAt: iso('16:00'), endedAt: iso('20:00'), correctedEndedAt: iso('18:00'), state: 'corrected', breaks: [] }], et('21:00')), [[et('16:00'), et('18:00')]]);
    assert.deepEqual(shiftWindows([{ startedAt: iso('16:00'), endedAt: null, state: 'open', breaks: [{ startedAt: iso('16:30'), endedAt: null }] }], et('17:00')), [[et('16:00'), et('16:30')]]);
});
