// The daily caller report: proof before counts, unknown before zero, one Slack post per day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, slackText, pairCalls, hubEntriesFrom, gather, dayRange, previousDay, tail4, RK } from '../api/_daily-report.js';
import { runOne, destination, postToSlack } from '../api/_daily-report-run.js';
import { nextRun } from '../api/daily-report.js';

const DAY = '2026-10-23';
const range = dayRange(DAY);
const at = hm => new Date(`${DAY}T${hm}:00-04:00`).toISOString();      // a time on DAY, Eastern
const USER = { email: 'miltion@trystaffify.com', name: 'Milton Hodgson' };
const quoOk = calls => ({ configured: true, ok: true, seat: { email: 'milton@trystaffify.com', actorId: 'US1' }, complete: true, readAt: at('23:00'), calls });
const hubOk = entries => ({ ok: true, entries, readAt: at('23:00'), stateUpdatedAt: at('22:59') });
const calOk = bookings => ({ configured: true, ok: true, bookings, readAt: at('23:00') });
const SHIFT = { shifts: 1, clockedMinutes: 240, breakMinutes: 15, needsReview: 0, open: 0, list: [{ startedAt: at('16:00'), endedAt: at('20:15'), state: 'closed', clockedMinutes: 240, breakMinutes: 15, breaks: [{ startedAt: at('18:00'), endedAt: at('18:15') }] }] };
const ACTIVITY = { measured: true, activeMinutes: 150, idleMinutes: 60, elapsedMinutes: 210, sessions: 2, firstSeen: at('16:01'), lastSeen: at('20:10') };
const e = (id, hm, outcome, over = {}) => ({ id, recordId: id.split('#')[0], company: 'Co ' + id.split('#')[0], recipient: id.split('#')[0] + '@x.com', at: at(hm), outcome, tag: null, nextCallAt: null, numbers: ['5125550001'], ...over });

const FIXTURE = () => ({
    quo: quoOk([
        { id: 'c1', at: at('16:10'), number: '5125550001', answered: true, seconds: 20 },      // voicemail greeting
        { id: 'c2', at: at('16:20'), number: '5125550002', answered: true, seconds: 75 },      // a conversation
        { id: 'c3', at: at('16:30'), number: '5125550003', answered: false, seconds: 0 },      // dialled, nothing logged
        { id: 'c4', at: at('16:31'), number: '5125550003', answered: false, seconds: 0 },      // a repeat attempt
    ]),
    hub: hubOk([
        e('r1#0', '16:11', 'voicemail', { numbers: ['5125550001'] }),
        e('r2#0', '16:22', 'connected', { numbers: ['5125550002'], tag: 'Interested', recipient: 'pat@two.com' }),
        e('r4#0', '17:00', 'no_answer', { numbers: ['5125550004'] }),                          // logged, no Quo call
        e('r5#0', '10:00', 'callback', { at: new Date('2026-10-22T14:00:00Z').toISOString(), numbers: ['5125550005'], nextCallAt: at('17:30') }),
        e('r5#1', '17:35', 'voicemail', { numbers: ['5125550005'] }),                          // the callback, done
        e('r6#0', '10:00', 'callback', { at: new Date('2026-10-21T14:00:00Z').toISOString(), numbers: ['5125550006'], nextCallAt: new Date('2026-10-22T15:00:00Z').toISOString() }), // overdue
    ]),
    calendly: calOk([
        { email: 'pat@two.com', createdAt: at('16:40'), startTime: '2026-10-27T15:00:00Z', eventName: 'Discovery call' },
        { email: 'stranger@else.com', createdAt: at('12:00'), startTime: '2026-10-28T15:00:00Z', eventName: 'Discovery call' },
    ]),
});

test('verified calls come only from Quo; logged outcomes are counted apart; the two are reconciled', () => {
    const f = FIXTURE();
    const r = buildReport({ user: USER, day: DAY, generatedAt: at('23:30'), range, activity: ACTIVITY, shift: SHIFT, ...f });
    const c = r.calls;
    assert.equal(c.verifiedAttempts, 4); assert.equal(c.uniqueNumbersCalled, 3); assert.equal(c.repeatAttempts, 1);
    assert.equal(c.linePickedUp, 2, 'a voicemail greeting picks up a line'); assert.equal(c.answered60sOrMore, 1); assert.equal(c.talkSeconds, 95);
    assert.equal(c.loggedOutcomes, 4, 'the four outcomes logged that day, the earlier days left out'); assert.equal(c.loggedProspects, 4);
    assert.equal(c.conversations, 1); assert.equal(c.noAnswerOrVoicemail, 3); assert.equal(c.interested, 1); assert.equal(c.optOuts, 0);
    assert.equal(c.numbersDialledWithoutOutcome, 1, '...0003 was dialled twice and nothing was logged'); assert.equal(c.dialsWithoutOutcome, 2);
    assert.equal(c.outcomesWithoutQuoCall, 2, 'no answer on ...0004 and the voicemail on ...0005 have no Quo call');
    assert.equal(r.meetings.booked, 1, 'only the invitee he had called before the booking'); assert.equal(r.meetings.bookedTotalThatDay, 2);
    assert.deepEqual(r.callbacks, { dueToday: 1, doneOfDueToday: 1, overdueAtEndOfDay: 1 });
    assert.deepEqual([r.rates.pickedUp.num, r.rates.pickedUp.den], [2, 4]); assert.match(r.rates.pickedUp.label, /not a conversation rate/);
    assert.deepEqual([r.rates.conversations.num, r.rates.conversations.den, r.rates.conversations.pct], [1, 4, 25]);
    assert.deepEqual([r.rates.meetings.num, r.rates.meetings.den], [1, 1]);
    assert.equal(r.noRecordedActivity, false);
    assert.match(r.coverage[0], /iPhone’s own dialer.*not counted/);
    assert.deepEqual(r.evidence.numbersDialledWithoutOutcome, ['•••0003']);
    assert.equal(r.evidence.quoDials.find(d => d.number === '•••0002').loggedAs, 'Conversation');
    assert.ok(!/\d{10}/.test(JSON.stringify(r).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '')), 'no full number anywhere on the report');
});

test('a source that cannot be read is unknown, never zero, and the day is never called empty', () => {
    const f = FIXTURE();
    const r = buildReport({ user: USER, day: DAY, generatedAt: at('23:30'), range, activity: ACTIVITY, shift: SHIFT, ...f, quo: { configured: true, ok: false, seat: { actorId: 'US1' }, error: 'Quo 503' } });
    assert.equal(r.calls.verifiedAttempts, null); assert.equal(r.calls.numbersDialledWithoutOutcome, null); assert.equal(r.rates.pickedUp, null);
    assert.equal(r.calls.loggedOutcomes, 4, 'the Hub side still reports');
    assert.ok(r.coverage.some(x => /Quo could not be read.*unavailable, not zero/.test(x)));
    const empty = buildReport({ user: USER, day: DAY, generatedAt: at('23:30'), range, activity: { measured: false }, shift: { shifts: 0, list: [] }, quo: { configured: true, ok: false, seat: { actorId: 'US1' } }, hub: hubOk([]), calendly: calOk([]) });
    assert.equal(empty.noRecordedActivity, false, 'Quo unreadable: we cannot say there were no calls');
    const meet = buildReport({ user: USER, day: DAY, generatedAt: at('23:30'), range, activity: ACTIVITY, shift: SHIFT, ...f, calendly: { configured: true, ok: false, error: 'x' } });
    assert.equal(meet.meetings.booked, null); assert.equal(meet.rates.meetings, null);
});

test('a day with nothing says so plainly, and rates with a zero denominator are withheld', () => {
    const r = buildReport({ user: USER, day: '2026-10-25', generatedAt: at('23:30'), range: dayRange('2026-10-25'), activity: { measured: false, activeMinutes: 0 }, shift: { shifts: 0, clockedMinutes: 0, breakMinutes: 0, needsReview: 0, open: 0, list: [] }, quo: quoOk([]), hub: hubOk([]), calendly: calOk([]) });
    assert.equal(r.noRecordedActivity, true);
    assert.equal(r.rates.conversations.pct, null); assert.match(r.rates.conversations.note, /denominator is zero/);
    const text = slackText(r, { link: 'https://www.gostaffify.com/activity/report/?user=x&date=2026-10-25' });
    assert.match(text, /No recorded activity/); assert.match(text, /Sun, Oct 25, 2026/);
});

test('the Slack message is readable, plain and says what it cannot see', () => {
    const r = buildReport({ user: USER, day: DAY, generatedAt: at('23:30'), range, activity: ACTIVITY, shift: SHIFT, ...FIXTURE() });
    const text = slackText(r, { link: 'https://www.gostaffify.com/activity/report/?user=miltion%40trystaffify.com&date=2026-10-23' });
    assert.match(text, /Milton Hodgson · calls and shift · Fri, Oct 23, 2026 \(ET\)/);
    assert.match(text, /Verified calls \(Quo\): 4 dials to 3 numbers \(1 repeat\)\. Line picked up 2 times, voicemail included; 1 answered calls ran 60 s or more/);
    assert.match(text, /Logged in the Hub: 4 outcomes on 4 prospects\. Conversations 1/);
    assert.match(text, /Not reconciled: 1 numbers dialled with no outcome logged; 2 outcomes logged with no matching Quo call/);
    assert.match(text, /Meetings booked by prospects he called: 1/); assert.match(text, /Callbacks: 1 due, 1 done, 1 overdue/);
    assert.match(text, /Shift \(declared\): 4:00 PM to 8:15 PM; 4h 0m clocked, 15m on breaks/);
    assert.match(text, /iPhone’s own dialer/);
    assert.ok(!/—/.test(text), 'no em dashes'); assert.ok(!/\d{10}/.test(text), 'no phone numbers');
    assert.ok(text.split('\n').length <= 12, 'one short message');
});

test('only this person’s calls: other callers on the log and other Quo users on a shared line are left out', async () => {
    const records = [{ id: 'r1', company: 'A', recipient: 'a@x.com', callContact: { phone: '+15125550001' }, callHistory: [{ at: at('16:00'), outcome: 'voicemail', caller: 'MILTION@trystaffify.com' }, { at: at('16:05'), outcome: 'connected', caller: 'paul' }] }];
    const mine = hubEntriesFrom(records, ['miltion@trystaffify.com', 'milton@trystaffify.com']);
    assert.equal(mine.length, 1); assert.deepEqual(mine[0].numbers, ['5125550001']);
    const store = new Map([['staffify:outreach-review:v1', { records, assignments: [], suppressions: [], queueUpdatedAt: at('22:00') }]]);
    const redis = { get: async k => store.get(k) ?? null, smembers: async () => [], lrange: async () => [], hgetall: async () => ({}) };
    let asked = null;
    const deps = { quoConfigured: () => true, listUsers: async () => [{ actorId: 'US1', email: 'milton@trystaffify.com' }, { actorId: 'US2', email: 'molly@gostaffify.com' }],
        listCalls: async q => { asked = q; return { complete: true, items: [
            { id: 'q1', direction: 'outgoing', createdAt: at('16:00'), initiatedBy: 'US1', answeredAt: at('16:00'), duration: 30, participants: [{ phoneNumber: '+15125550001' }] },
            { id: 'q2', direction: 'outgoing', createdAt: at('16:02'), initiatedBy: 'US2', participants: [{ phoneNumber: '+15125550009' }] },     // Molly on a shared line
            { id: 'q3', direction: 'incoming', createdAt: at('16:03'), participants: [{ phoneNumber: '+15125550008' }] },
        ] }; },
        calendlyConfigured: () => false };
    const src = await gather({ redis, rep: { email: 'miltion@trystaffify.com', name: 'Milton' }, day: DAY, deps });
    assert.equal(asked.actorId, 'US1', 'Quo is asked for his user, found through his login alias'); assert.equal(asked.direction, 'outgoing');
    assert.deepEqual(src.quo.calls.map(c => c.id), ['q1']);
    const r = buildReport({ ...src, generatedAt: at('23:00') });
    assert.equal(r.calls.verifiedAttempts, 1); assert.equal(r.calls.loggedOutcomes, 1); assert.equal(r.calls.outcomesWithoutQuoCall, 0);
    assert.equal(r.sources.calendly, 'not connected'); assert.equal(r.meetings.booked, null);
});

test('pairing: one dial and one outcome each, within the window, nearest first', () => {
    const { dials, outcomes } = pairCalls(
        [{ id: 'a', at: at('16:00'), number: '1' }, { id: 'b', at: at('16:01'), number: '1' }, { id: 'c', at: at('12:00'), number: '1' }],
        [{ id: 'x', at: at('16:03'), numbers: ['1'] }]);
    assert.equal(outcomes[0].pairedWith, 'b', 'the nearer dial');
    assert.equal(dials.filter(d => d.pairedWith).length, 1);
    assert.equal(dials.find(d => d.id === 'c').pairedWith, null, 'four hours earlier is not the same call');
});

// ---- delivery -----------------------------------------------------------------------------------
function memRedis() {
    const m = new Map();
    return { m, get: async k => (m.has(k) ? m.get(k) : null), set: async (k, v, o = {}) => { if (o.nx && m.has(k)) return null; m.set(k, v); return 'OK'; }, del: async k => (m.delete(k) ? 1 : 0),
        smembers: async () => [], lrange: async () => [], hgetall: async () => ({}), hget: async () => null };
}
const quietDeps = { quoConfigured: () => true, listUsers: async () => [{ actorId: 'US1', email: 'milton@trystaffify.com' }], listCalls: async () => ({ complete: true, items: [] }), calendlyConfigured: () => false };

test('no private destination: the report is generated and kept, and nothing is sent anywhere', async () => {
    const redis = memRedis(); redis.m.set('staffify:outreach-review:v1', { records: [], assignments: [], suppressions: [] });
    let posted = 0;
    const out = await runOne({ redis, rep: USER, day: DAY, deps: quietDeps, env: { SLACK_BOT_TOKEN: 'xoxb', SLACK_CHANNEL: 'C-team' }, fetchImpl: async () => { posted++; } });
    assert.equal(out.status, 'stored_not_delivered'); assert.equal(posted, 0, 'never falls back to the team channel');
    const snap = redis.m.get(RK.snapshot(USER.email, DAY));
    assert.ok(snap.calls, 'the snapshot is kept for the Hub'); assert.equal(snap.sources.hubLog, 'read'); assert.equal(snap.sources.quo, 'read'); assert.equal(snap.noRecordedActivity, true);
    assert.equal(redis.m.get(RK.delivery(USER.email, DAY)).status, 'not_configured');
    assert.equal(destination({ SLACK_CHANNEL: 'C-team', SLACK_BOT_TOKEN: 'xoxb' }), null);
});

test('delivery happens once, only when Slack confirms it; a failure is retried by the next run and never doubled', async () => {
    const redis = memRedis(); redis.m.set('staffify:outreach-review:v1', { records: [], assignments: [], suppressions: [] });
    const env = { REPORT_SLACK_CHANNEL: 'D-paul', SLACK_BOT_TOKEN: 'xoxb' };
    const posts = []; let fail = true;
    const fetchImpl = async (url, opts) => { posts.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => (fail ? { ok: false, error: 'channel_not_found' } : { ok: true, ts: '1729.0001', channel: 'D-paul' }) }; };
    let r = await runOne({ redis, rep: USER, day: DAY, deps: quietDeps, env, fetchImpl });
    assert.equal(r.status, 'failed'); assert.equal(r.delivery.delivered, false); assert.equal(r.delivery.attempts, 1);
    fail = false;
    r = await runOne({ redis, rep: USER, day: DAY, deps: quietDeps, env, fetchImpl });
    assert.equal(r.status, 'delivered'); assert.equal(r.delivery.ts, '1729.0001'); assert.equal(r.delivery.attempts, 2);
    r = await runOne({ redis, rep: USER, day: DAY, deps: quietDeps, env, fetchImpl });
    assert.equal(r.status, 'already_delivered'); assert.equal(posts.length, 2, 'the third run posted nothing');
    assert.equal(posts[1].channel, 'D-paul'); assert.match(posts[1].text, /Milton Hodgson · calls and shift/);
    // A run already holding the lease blocks a second one from posting.
    const redis2 = memRedis(); redis2.m.set('staffify:outreach-review:v1', { records: [], assignments: [], suppressions: [] }); redis2.m.set(RK.lease(USER.email, DAY), 'other');
    assert.equal((await runOne({ redis: redis2, rep: USER, day: DAY, deps: quietDeps, env, fetchImpl })).status, 'another_run_is_delivering');
    // A webhook counts only when it answers "ok".
    assert.equal((await postToSlack({ kind: 'webhook', url: 'x' }, 't', async () => ({ ok: true, status: 200, text: async () => 'invalid_payload' }))).confirmed, false);
});

test('the schedule: 8:05 AM Eastern in daylight and in standard time, for the previous complete day', () => {
    assert.equal(nextRun(Date.parse('2026-10-26T23:00:00Z')), '2026-10-27T12:05:00.000Z', 'EDT: 8:05 AM is 12:05 UTC');
    assert.equal(nextRun(Date.parse('2026-11-03T02:00:00Z')), '2026-11-03T13:05:00.000Z', 'EST: 12:05 UTC is 7:05 AM, so 13:05');
    assert.equal(nextRun(Date.parse('2026-10-27T12:30:00Z')), '2026-10-27T13:05:00.000Z', 'after the first run, the retry');
    assert.equal(previousDay(Date.parse('2026-10-27T12:05:00Z')), '2026-10-26');
    assert.equal(tail4('+1 (512) 555-0102'), '•••0102'); assert.equal(tail4('123'), null);
});
