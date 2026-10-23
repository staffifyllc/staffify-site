// The slim queue view: the same counts as the full one, without the mail.
// ------------------------------------------------------------------
// Live, /api/outreach-queue/ was 7.9 MB uncompressed and took 4.5 seconds: 2 MB of email bodies on
// events, 900 KB of draft copy, 730 KB of send receipts. Today reads none of it. The test that
// matters is not "it is smaller" but "every number the page shows is unchanged", so the reply
// queue is computed by the page's own helper over both shapes and compared.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slimState } from '../api/_outreach-queue.js';

const win = {};
new Function('window', readFileSync(new URL('../assets/js/outreach-replies.js', import.meta.url), 'utf8'))(win);
const Replies = win.StaffifyReplies;

const BODY = 'Hi Krista, '.repeat(200);
const rec = (i, over = {}) => ({
    id: 'r' + i, recipient: `p${i}@x.com`, sender: 'paul@gostaffify.com', owner: 'Paul', company: 'Co ' + i, threadId: 't' + i,
    status: 'sent', subject: 'Hello', bodyText: BODY, followupBodies: { 2: BODY, 3: BODY, 4: BODY }, followupSubjects: { 2: 'Re' },
    source: { list: 'apollo', raw: BODY }, emailVerification: { status: 'verified', reason: null, checkedAt: '2026-10-20T12:00:00Z', provider: 'x', raw: BODY }, sendWindow: { nextOpenAt: '2026-10-23T13:00:00Z', reason: 'outside hours', timeZone: 'America/Chicago', raw: BODY },
    prospectTimezone: 'America/Chicago', replyId: null, holdError: null, callReady: true, callContact: { phone: '+15125551000', phoneStatus: 'available' }, callHistory: [{ at: '2026-10-20T20:00:00Z', outcome: 'no_answer' }],
    events: [
        { id: 'e1', kind: 'sent', at: '2026-10-20T14:00:00Z', from: 'paul@gostaffify.com', to: `p${i}@x.com`, subject: 'Hello', body: BODY },
        { id: 'e2', kind: 'received', at: '2026-10-21T14:00:00Z', from: `p${i}@x.com`, to: 'paul@gostaffify.com', subject: 'Re: Hello', body: BODY },
    ], ...over });

const FULL = {
    revision: 7, updatedAt: '2026-10-22T12:00:00Z', numberWork: { callable: 2, findingNumber: 1, noNumberPossible: 0, blocked: 0 },
    assignments: [{ email: 'p0@x.com', owner: 'Paul' }], suppressions: ['gone@x.com'], campaigns: [{ id: 'c' }],
    sends: [{ status: 'verified', day: '2026-10-22', sender: 'paul@gostaffify.com', messageId: 'm', subject: 'Hello', body: BODY }, { status: 'dry_run', day: '2026-10-22', sender: 'paul@gostaffify.com' }],
    creations: Array.from({ length: 50 }, (_, i) => ({ at: '2026-10-22T12:00:00Z', detail: BODY })),
    records: [rec(0, { status: 'human_reply_hold' }), rec(1, { status: 'human_reply_hold', events: [] }), rec(2, { callReady: false, callContact: { phone: null, phoneStatus: 'missing' } })],
};

test('what the page shows is identical over the slim shape', () => {
    const slim = slimState(structuredClone(FULL));
    assert.deepEqual(Replies.queue(slim.records).map(r => r.id), Replies.queue(FULL.records).map(r => r.id), 'replies to handle');
    assert.equal(slim.records.filter(r => r.callReady).length, FULL.records.filter(r => r.callReady).length, 'ready to call');
    const sentToday = s => s.records.flatMap(r => r.events.filter(e => e.kind === 'sent').map(e => r.sender + ':' + e.id));
    assert.deepEqual(sentToday(slim), sentToday(FULL), 'sends counted per sender and event id');
    assert.equal(slim.sends.filter(s => s.status === 'verified' && s.day === '2026-10-22').length, 1, 'automatic sends today');
    assert.deepEqual(slim.numberWork, FULL.numberWork);
    assert.equal(slim.revision, 7);
});

test('the mail itself is gone, and so is everything else the page never reads', () => {
    const slim = slimState(structuredClone(FULL));
    for (const r of slim.records) {
        for (const k of ['bodyText', 'followupBodies', 'followupSubjects', 'source', 'prospectTimezone']) assert.ok(!(k in r), k + ' stripped');
        for (const e of r.events) { assert.ok(!('body' in e), 'event body stripped'); assert.deepEqual(Object.keys(e).sort(), ['at', 'from', 'id', 'kind', 'subject', 'to']); }
        for (const k of ['id', 'recipient', 'sender', 'owner', 'company', 'threadId', 'status', 'callReady', 'callContact', 'callHistory', 'replyId', 'holdError']) assert.ok(k in r, k + ' kept');
        assert.equal(r.hasDraft, true, 'the Inbox is told there is a draft to open');
        // The Inbox reads these three off the verification and these three off the window. Nothing else.
        assert.deepEqual(Object.keys(r.emailVerification).sort(), ['checkedAt', 'reason', 'status']);
        assert.deepEqual(Object.keys(r.sendWindow).sort(), ['nextOpenAt', 'reason', 'timeZone']);
        assert.equal(r.sendWindow.timeZone, 'America/Chicago');
    }
    assert.ok(!('creations' in slim), 'creation logs are not shipped');
    assert.ok(!('assignments' in slim), 'assignments are not shipped; no page reads them');
    assert.ok(!('dry_run' in Object.fromEntries(slim.sends.map(s => [s.status, 1]))), 'a dry run is not a send');
    assert.ok(slim.sends.every(s => !('body' in s) && !('subject' in s)));
    const before = JSON.stringify(FULL).length, after = JSON.stringify(slim).length;
    assert.ok(after < before / 10, `slim is ${after} bytes against ${before}: under a tenth`);
});

test('a record with no events and an empty state both survive', () => {
    assert.deepEqual(slimState({ revision: 0, records: [] }).records, []);
    const one = slimState({ revision: 1, records: [{ id: 'a', recipient: 'a@x.com', status: 'sent' }] }).records[0];
    assert.deepEqual(one.events, []);
    assert.equal(one.emailVerification, null);
    assert.equal(one.hasDraft, false);
});

test('send receipts are shipped for the last three ET days only', () => {
    const now = Date.parse('2026-10-23T15:00:00Z');
    const s = slimState({ revision: 1, records: [], sends: [
        { status: 'verified', day: '2026-10-23', sender: 'a' }, { status: 'verified', day: '2026-10-21', sender: 'a' },
        { status: 'verified', day: '2026-10-20', sender: 'a' }, { status: 'verified', day: '2026-09-01', sender: 'a' }] }, now);
    assert.deepEqual(s.sends.map(x => x.day), ['2026-10-23', '2026-10-21'], 'three days back from today, inclusive');
});
