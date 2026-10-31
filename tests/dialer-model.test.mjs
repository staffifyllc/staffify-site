// The dialer's decisions, tested without a browser.
// ------------------------------------------------------------------
// What a quick pick means, which follow-ups are due, how the prospect's clock reads, which key
// does what. If any of these are wrong the rep calls at the wrong time or misses a promise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTCOMES, NEEDS_TIME, quickPicks, defaultNext, toLocalInput, fmtWhen, localTime, followUps, followUpCount, timeline, lastTouch, shortcut, numberTrust, nurtureNote } from '../assets/js/dialer-model.js';

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

test('every quick pick is in the future, and "today 4 pm" disappears once the afternoon is gone', () => {
    const morning = at(2026, 10, 23, 10);
    const picks = quickPicks(morning);
    assert.ok(picks.every(p => p.at > morning), 'all in the future');
    assert.ok(picks.some(p => p.label === 'Today 4 pm'));
    assert.equal(picks.find(p => p.label === 'Tomorrow 10 am').at.getHours(), 10);
    const monday = picks.find(p => p.label === 'Next Monday 10 am').at;
    assert.equal(monday.getDay(), 1); assert.ok(monday > morning);
    const late = at(2026, 10, 23, 16, 30);
    assert.ok(!quickPicks(late).some(p => p.label === 'Today 4 pm'), 'no pick that has already passed');
    assert.ok(quickPicks(late).every(p => p.at > late));
});

test('defaults: a callback starts tomorrow 10, a retry two days out, "not now" ninety days out', () => {
    const now = at(2026, 10, 23, 15);
    assert.equal(toLocalInput(defaultNext('callback', now)), '2026-10-24T10:00');
    assert.equal(toLocalInput(defaultNext('no_answer', now)), '2026-10-25T10:00');
    assert.equal(toLocalInput(defaultNext('voicemail', now)), '2026-10-25T10:00');
    assert.equal(defaultNext('timing', now).getTime() - now.getTime() > 85 * 86400000, true);
});

test('fmtWhen reads like a person: overdue, today, tomorrow, then a date', () => {
    const now = at(2026, 10, 23, 14);
    assert.equal(fmtWhen(at(2026, 10, 23, 13, 35), now), 'Overdue 25 min');
    assert.equal(fmtWhen(at(2026, 10, 23, 9), now), 'Overdue 5 h');
    assert.match(fmtWhen(at(2026, 10, 23, 16, 30), now), /^Today 4:30/);
    assert.match(fmtWhen(at(2026, 10, 24, 10), now), /^Tomorrow 10:00/);
    assert.match(fmtWhen(at(2026, 10, 27, 10), now), /^Tue, Oct 27, 10:00/);
    assert.equal(fmtWhen('garbage', now), '');
});

test('the prospect clock comes from a zone, never a guess, and knows business hours', () => {
    const noonET = Date.parse('2026-10-23T16:00:00Z'); // Friday 12:00 ET
    const ny = localTime('America/New_York', noonET);
    assert.equal(ny.inHours, true); assert.match(ny.time, /12:00/); assert.equal(ny.note, 'Business hours');
    const la = localTime('America/Los_Angeles', noonET);
    assert.equal(la.hour, 9); assert.equal(la.inHours, true);
    const london = localTime('Europe/London', noonET);
    assert.equal(london.inHours, true, '5 pm is still in hours');
    const lateLondon = localTime('Europe/London', Date.parse('2026-10-23T19:30:00Z'));
    assert.equal(lateLondon.inHours, false); assert.equal(lateLondon.note, 'After hours there');
    const sat = localTime('America/New_York', Date.parse('2026-10-24T16:00:00Z'));
    assert.equal(sat.inHours, false); assert.equal(sat.note, 'Weekend there');
    assert.equal(localTime(null), null);
    assert.equal(localTime('Not/AZone'), null);
});

test('follow-ups: mine only, grouped by when, callbacks and tasks together, suppressed and done left out', () => {
    const now = Date.parse('2026-10-23T18:00:00Z'); // 2 pm ET
    const me = 'milton@trystaffify.com';
    const rec = (id, over) => ({ id, company: 'Co ' + id, recipient: id + '@x.com', callOwner: me, callOutcome: 'callback', nextCallAt: '2026-10-23T17:30:00Z', callHistory: [{ notes: 'after lunch' }], callContact: { phone: '+1' }, ...over });
    const records = [
        rec('a'),                                                                  // overdue 30 min
        rec('b', { nextCallAt: '2026-10-23T21:00:00Z' }),                          // later today
        rec('c', { nextCallAt: '2026-10-26T14:00:00Z', callOutcome: 'no_answer' }),// this week
        rec('d', { nextCallAt: '2027-01-15T14:00:00Z', callOutcome: 'timing' }),   // later
        rec('e', { callOwner: 'someone.else@x.com' }),                             // not mine
        rec('f', { status: 'suppressed' }),                                        // they said stop
        rec('g', { callOutcome: 'connected', nextCallAt: null }),                  // nothing promised
        rec('h', { callOwner: 'MILTON@trystaffify.com', nextCallAt: '2026-10-23T17:00:00Z' }), // case
    ];
    const tasks = [
        { id: 't1', title: 'Send pricing', dueAt: '2026-10-23T19:00:00Z', doneAt: null, company: 'Loft', hubspot: { ok: false, reason: 'no_owner' } },
        { id: 't2', title: 'Done already', dueAt: '2026-10-23T19:00:00Z', doneAt: '2026-10-23T12:00:00Z' },
    ];
    const g = followUps({ records, tasks, me, now });
    assert.deepEqual(g.dueNow.map(i => i.recordId), ['h', 'a'], 'most overdue first');
    assert.deepEqual(g.today.map(i => i.id), ['task:t1', 'cb:b']);
    assert.deepEqual(g.upcoming.map(i => i.recordId), ['c']);
    assert.deepEqual(g.later.map(i => i.recordId), ['d']);
    assert.equal(followUpCount(g), 6);
    assert.equal(g.dueNow[1].note, 'after lunch');
    assert.equal(g.today[0].kind, 'task');
    // Tasks arrive already scoped to the caller, so a stranger sees none of the callbacks and only the task list handed in.
    assert.equal(followUpCount(followUps({ records, tasks, me: 'nobody@x.com', now })), 1);
});

test('the timeline merges emails and calls newest first and names the last touch', () => {
    const brief = { events: [
        { kind: 'sent', at: '2026-10-01T13:00:00Z', subject: 'Hello', body: 'Hi Tom', mailbox: 'paul@trystaffify.com' },
        { kind: 'received', at: '2026-10-02T13:00:00Z', subject: 'Re: Hello', body: 'Thanks', mailbox: 'tom@x.com' },
        { kind: 'draft', at: '2026-10-03T13:00:00Z', subject: 'never' },
    ] };
    const row = { callHistory: [{ at: '2026-10-20T20:00:00Z', outcome: 'voicemail', notes: 'left one', caller: 'milton@trystaffify.com', nextCallAt: '2026-10-22T14:00:00Z' }] };
    const items = timeline({ brief, row });
    assert.deepEqual(items.map(i => i.kind), ['call', 'email_in', 'email_out']);
    assert.equal(items[0].title, 'Call · Left voicemail');
    assert.equal(items[0].body, 'left one');
    assert.equal(items[1].title, 'Reply · Re: Hello');
    assert.match(lastTouch(items, Date.parse('2026-10-22T20:00:00Z')), /^Call 2 days ago$/);
    assert.equal(lastTouch([]), 'No contact recorded yet');
    // With no brief the queue record's own events are used.
    assert.equal(timeline({ row: { events: brief.events } }).length, 2);
});

test('keys: outcomes 1-7, N P S F C, save with the command key, and nothing while typing', () => {
    const k = (key, over = {}) => shortcut({ key, target: { tagName: 'DIV' }, ...over });
    assert.deepEqual(k('1'), { type: 'outcome', value: 'connected' });
    assert.deepEqual(k('7'), { type: 'outcome', value: 'suppress' });
    assert.deepEqual(k('n'), { type: 'next' }); assert.deepEqual(k('P'), { type: 'prev' });
    assert.deepEqual(k('s'), { type: 'skip' }); assert.deepEqual(k('f'), { type: 'followups' }); assert.deepEqual(k('c'), { type: 'call' });
    assert.deepEqual(k('Enter', { metaKey: true }), { type: 'save' });
    assert.equal(k('n', { metaKey: true }), null, 'cmd+N is the browser\'s');
    assert.equal(k('x'), null);
    const typing = { target: { tagName: 'TEXTAREA' } };
    assert.equal(shortcut({ key: '1', ...typing }), null, 'typing a 1 in the notes is not an outcome');
    assert.deepEqual(shortcut({ key: 'Enter', metaKey: true, ...typing }), { type: 'save' }, 'but cmd-enter still saves');
    assert.deepEqual(shortcut({ key: 'Escape', ...typing }), { type: 'escape' });
    // Gatekeeper (2026-10-27) sits next to Callback on key 8, so 1 to 7 keep their meaning.
    assert.equal(OUTCOMES.map(o => o.key).join(''), '12834567');
    assert.equal(OUTCOMES.find(o => o.key === '8').value, 'gatekeeper');
    assert.deepEqual(NEEDS_TIME, ['callback', 'gatekeeper', 'no_answer', 'voicemail', 'timing']);
});

test('number trust reads the brief\'s label, and no number is said plainly', () => {
    assert.equal(numberTrust({ label: 'Published on their own website' }).tone, 'good');
    assert.equal(numberTrust({ label: 'Direct dial (mobile)' }).tone, 'ok');
    assert.equal(numberTrust({ label: 'Main line published on their website' }).word, 'Main line');
    assert.equal(numberTrust({ label: 'From the CRM, not corroborated' }).tone, 'warn');
    assert.equal(numberTrust(null).word, 'No number');
});

// Paul, 2026-10-30: reps should "see any email efforts that are going in case they need to help work some of those leads".
test('a Hiring now card says where its emails stand', async () => {
  const { dripLine } = await import('../assets/js/dialer-model.js');
  const now = Date.parse('2026-10-30T18:00:00Z');
  assert.equal(dripLine(null), null);
  assert.deepEqual(dripLine({ status: 'prepared', sentTouches: 0 }, now), { tone: 'muted', text: 'First email queued.' });
  assert.deepEqual(dripLine({ status: 'sent', sentTouches: 2, lastSentAt: '2026-10-30T16:30:00Z', nextEligibleAt: '2026-11-01T16:30:00Z' }, now), { tone: 'muted', text: '2 of 4 emails sent, last Oct 30, next Nov 1.' });
  assert.deepEqual(dripLine({ status: 'draft_saved', sentTouches: 1, lastSentAt: '2026-10-28T16:30:00Z' }, now), { tone: 'muted', text: '1 of 4 emails sent, last Oct 28, the next is queued.' });
  assert.equal(dripLine({ status: 'human_reply_hold', sentTouches: 1, replyReceivedAt: '2026-10-31T14:00:00Z' }, now).tone, 'good');
  assert.match(dripLine({ status: 'human_reply_hold', sentTouches: 1, copied: true }, now).text, /^Replied to our email\. Read it in your inbox or hello@ before you call\.$/);
  assert.equal(dripLine({ status: 'human_reply_hold', sentTouches: 1, sender: 'paul@hirestaffify.com' }, now).text, 'Replied to our email. The reply is in paul@hirestaffify.com; ask Paul for it before you call.', 'sent before reps were copied');
  assert.deepEqual(dripLine({ status: 'auto_reply_hold', sentTouches: 1, replyReceivedAt: '2026-10-31T14:00:00Z' }, now), { tone: 'muted', text: 'Auto-reply (out of office) Oct 31; emails paused.' });
  assert.deepEqual(dripLine({ status: 'suppressed', sentTouches: 1 }, now), { tone: 'bad', text: 'Emails stopped: they opted out or said no.' });
  assert.equal(dripLine({ status: 'bounce_hold' }, now).text, 'Our email to them bounced.');
  assert.equal(dripLine({ status: 'sent', sentTouches: 4, lastSentAt: '2026-10-30T16:30:00Z' }, now).text, '4 of 4 emails sent, last Oct 30.');
  assert.equal(dripLine({ status: 'crm_hold', sentTouches: 0 }, now).text, 'Emails paused.');
  for (const d of [{ status: 'sent', sentTouches: 3 }, { status: 'crm_hold', sentTouches: 2 }]) assert.doesNotMatch(dripLine(d, now).text, /—|–|\bi\b/);
});

test('a closed card is nobody\'s follow-up: no callback and no task for it', async () => {
  const { followUps, followUpCount } = await import('../assets/js/dialer-model.js');
  const now = Date.parse('2026-10-30T18:00:00Z'), at = '2026-10-30T19:00:00Z', me = 'milton@trystaffify.com';
  const rec = (id, status) => ({ id, status, callOwner: me, callOutcome: 'callback', nextCallAt: at });
  const g = followUps({ me, now, records: [rec('live', 'ready'), rec('no', 'suppressed'), rec('stop', 'excluded')], tasks: [{ id: 't1', recordId: 'no', dueAt: at, title: 'Call back' }, { id: 't2', recordId: 'live', dueAt: at, title: 'Send info' }, { id: 't3', recordId: 'elsewhere', dueAt: at, title: 'Other page' }] });
  assert.equal(followUpCount(g), 3);
  assert.deepEqual(g.today.map(i => i.recordId).sort(), ['elsewhere', 'live', 'live']);
});

test('the nurture line after a save: added, or left out with the server\'s reason in plain words', () => {
    assert.equal(nurtureNote(null), null, 'nothing said when the server said nothing');
    assert.deepEqual(nurtureNote({ enrolled: true, reason: 'enrolled' }), { text: 'Saved. Added to the email nurture.', warn: false });
    assert.deepEqual(nurtureNote({ enrolled: false, reason: 'existing client', message: 'already a client' }), { text: 'Saved. Not added to the nurture: already a client.', warn: true });
    assert.deepEqual(nurtureNote({ enrolled: false, reason: 'booked', message: 'they have booked a call' }), { text: 'Saved. Not added to the nurture: they have booked a call.', warn: true });
    assert.equal(nurtureNote({ enrolled: false, reason: 'already in nurture', message: 'they have already been added to it' }).warn, false, 'already in it is not a problem');
    assert.equal(nurtureNote({ enrolled: false, reason: 'enrolment failed: x' }).text, 'Saved. Not added to the nurture: it could not be saved just now.', 'never a raw code');
});
