// The one model behind the Campaigns area, and the arithmetic that was wrong on the live page.
// ------------------------------------------------------------------
// The first cut reported "1,222 of 1,271 replied, 96.1%" because it counted replyId, a threading id
// on every sent message, as a reply. These tests pin every number to a field the worker writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { overview, industryView, campaignView, stats, prospectState, replied, sentCount } from '../api/_campaigns-model.js';

const NOW = Date.parse('2026-10-22T20:00:00Z');
const A = 'staffify-agency-outreach', T = 'staffify-tobit-outreach', N = 'staffify-talent-network-outreach';
let seq = 0;
const rec = (campaignId, over = {}) => ({
    id: 'r' + (++seq), campaignId, recipient: `p${seq}@example.com`, company: 'Studio ' + seq, verifiedFirstName: 'Pat',
    status: 'sent', sentTouches: 4, verifiedSentTouches: 4, lastSentAt: '2026-10-01T12:00:00Z',
    // The trap: a threading id on every sent message. It must count for nothing.
    replyId: 'thread-' + seq, messageId: 'msg-' + seq,
    source: { excerpt: 'Real estate photography for listings across the metro.' },
    events: [{ kind: 'sent', at: '2026-10-01T12:00:00Z', subject: 'A quick hello', body: 'hi' }],
    ...over,
});

test('replyId is not a reply', () => {
    const r = rec(A);
    assert.ok(r.replyId, 'the field is there, as it is on every live record');
    assert.equal(replied(r), false);
    const s = stats([rec(A), rec(A), rec(A)]);
    assert.equal(s.replies, 0);
    assert.equal(s.replyRate.label, '—', 'and no rate is printed from three people');
});

test('a reply is a RECEIVED message, or a status the worker only sets on one', () => {
    assert.equal(replied(rec(A, { events: [{ kind: 'received', at: '2026-10-03T09:00:00Z', subject: 'Re: hello', body: 'what does this cost' }] })), true);
    assert.equal(replied(rec(A, { status: 'human_reply_hold' })), true);
    assert.equal(replied(rec(A, { status: 'auto_reply_hold' })), true);
    assert.equal(replied(rec(A, { status: 'bounce_hold' })), false, 'a bounce is not a reply');
    assert.equal(replied(rec(A, { status: 'draft_saved', sentTouches: 1 })), false);
});

test('the rate is honest at scale and withheld when small', () => {
    const big = [];
    for (let i = 0; i < 779; i++) big.push(rec(A, i < 38 ? { status: 'human_reply_hold' } : {}));
    const s = stats(big);
    assert.equal(s.contacted, 779);
    assert.equal(s.replies, 38);
    assert.equal(s.replyRate.label, '4.9%');
    assert.equal(s.replyRate.note, '38 of 779');
    const small = stats([rec(T, { status: 'human_reply_hold' }), rec(T), rec(T)]);
    assert.equal(small.replyRate.small, true);
    assert.match(small.replyRate.note, /n=3, below 30/);
});

test('contacted means a verified send, and won is unknown not zero', () => {
    const s = stats([rec(A, { sentTouches: 0, verifiedSentTouches: 0, status: 'draft_saved' }), rec(A, { sentTouches: 2, verifiedSentTouches: 2 }), rec(A)]);
    assert.equal(s.total, 3);
    assert.equal(s.contacted, 2);
    assert.equal(s.fourDone, 1);
    assert.equal(s.won, null);
    assert.equal(sentCount(rec(A, { sentTouches: 4, verifiedSentTouches: 3 })), 3, 'the verified count wins over the claimed one');
});

test('candidates carry no sales rate at all', () => {
    const s = stats([rec(N, { status: 'human_reply_hold' }), rec(N)], { candidates: true });
    assert.equal(s.replies, 1, 'the count is still true');
    assert.equal(s.replyRate.unknown, true, 'but it is never a conversion rate');
    assert.match(s.note, /Candidates, not buyers/);
});

test('a prospect has one state, in words a rep uses, and the urgent ones win', () => {
    const past = '2026-10-22T18:00:00Z', future = '2026-10-23T18:00:00Z';
    assert.equal(prospectState(rec(A, { status: 'human_reply_hold', callReady: true }), NOW).key, 'reply', 'a human reply beats being callable');
    assert.equal(prospectState(rec(A, { callOutcome: 'callback', nextCallAt: past }), NOW).key, 'callback_due');
    assert.equal(prospectState(rec(A, { callOutcome: 'callback', nextCallAt: future }), NOW).key, 'callback');
    assert.equal(prospectState(rec(A, { callReady: true }), NOW).key, 'ready');
    assert.equal(prospectState(rec(A, { numberResearch: { state: 'researching' } }), NOW).key, 'finding');
    assert.equal(prospectState(rec(A, { numberResearch: { state: 'exhausted' } }), NOW).label, 'No number found');
    assert.equal(prospectState(rec(A, { callOutcome: 'wrong_number' }), NOW).key, 'wrong_number');
    assert.equal(prospectState(rec(A, { status: 'suppressed' }), NOW).key, 'stopped');
    assert.equal(prospectState(rec(A, { sentTouches: 2, verifiedSentTouches: 2 }), NOW).label, 'Email 2 of 4 sent');
    assert.equal(prospectState(rec(A, { status: 'bounce_hold', sentTouches: 0, verifiedSentTouches: 0 }), NOW).label, 'Held: bounce');
});

test('the overview totals are the three jobs on the board, and the rails count real records', () => {
    const records = [
        rec(A, { status: 'human_reply_hold' }), rec(A, { callOutcome: 'callback', nextCallAt: '2026-10-22T18:00:00Z' }), rec(A, { callReady: true }), rec(A),
        rec(T, { company: 'Jefferson Bank', source: {} }), rec(T, { company: 'Boot Civil', source: {} }),
        rec(N, { source: {}, company: '' }),
    ];
    const o = overview(records, {}, NOW);
    assert.equal(o.totals.repliesWaiting, 1);
    assert.equal(o.totals.callbacksDue, 1);
    assert.equal(o.totals.ready, 1);
    const re = o.filters.industries.find(i => i.key === 're-media');
    assert.equal(re.n, 4, 'the industry chip counts people, not campaigns');
    assert.ok(o.filters.motions.find(m => m.key === 'email_call').n >= 6);
    // Spearhead spans (a bank and a builder); the agency campaign does not.
    assert.ok(o.spanning.some(c => c.id === T));
    assert.ok(!o.spanning.some(c => c.id === A));
    assert.ok(o.industries.some(i => i.key === 'hvac' && !i.started), 'planned industries are shown as not started');
});

test('the industry screen separates campaigns built for it from campaigns that merely reach it', () => {
    const records = [];
    for (let i = 0; i < 40; i++) records.push(rec(A));
    records.push(rec(T, { company: 'Jefferson Bank', source: {} }));
    records.push(rec(T, { company: 'Boot Civil', source: {} }));
    records.push(rec(T, { company: 'Realty Pix Media', source: { excerpt: 'Property photography for agents.' } }));
    const v = industryView(records, 're-media', {}, NOW);
    assert.equal(v.industry.label, 'Real estate media');
    assert.deepEqual(v.campaigns.map(c => c.id), [A], 'built for it');
    assert.equal(v.alsoReaching.length, 1);
    assert.equal(v.alsoReaching[0].id, T);
    assert.equal(v.alsoReaching[0].here, 1, 'one of the CEOs runs a real estate media business');
    assert.equal(v.funnel.total, 41, 'and that person is counted in the industry, once');
    assert.equal(v.funnel.replyRate.label, '0%', '41 contacted, nobody replied: a real zero, not a dash');
});

test('the campaign screen carries the words: the sequence, the replies, the callbacks', () => {
    const records = [
        rec(A, { bodyText: 'Hi Pat, first email.', subject: 'A quick hello', followupBodies: { 2: 'Second.', 3: 'Third.', 4: 'Fourth.' } }),
        rec(A, { status: 'human_reply_hold', events: [{ kind: 'sent', at: '2026-10-01T12:00:00Z' }, { kind: 'received', at: '2026-10-05T09:00:00Z', subject: 'Re: A quick hello', body: 'What would this actually cost us monthly?' }] }),
        rec(A, { callOutcome: 'callback', nextCallAt: '2026-10-22T18:00:00Z', callOwner: 'milton@trystaffify.com', callHistory: [{ at: '2026-10-21T20:00:00Z', outcome: 'callback' }] }),
        rec(A, { callReady: true, callContact: { phone: '+15125550100', phoneStatus: 'available' } }),
    ];
    const v = campaignView(records, A, {}, NOW);
    assert.equal(v.sequence.length, 4);
    assert.equal(v.sequence[0].subject, 'A quick hello');
    assert.equal(v.sequence[3].body, 'Fourth.');
    assert.equal(v.replies.length, 1);
    assert.match(v.replies[0].excerpt, /What would this actually cost/);
    assert.equal(v.replies[0].needsHuman, true);
    assert.equal(v.calls.callbacks.length, 1);
    assert.equal(v.calls.callbacks[0].due, true);
    assert.equal(v.calls.callbacks[0].owner, 'milton@trystaffify.com');
    assert.equal(v.calls.attempts, 1);
    // Sorted so what needs a person is on top.
    assert.equal(v.prospects[0].state, 'reply');
    assert.equal(v.prospects[1].state, 'callback_due');
    assert.equal(v.prospects[2].state, 'ready');
    assert.equal(v.prospects[2].phone.number, '+15125550100');
    assert.equal(v.next.repliesWaiting, 1);
});

test('nothing leaks between campaigns', () => {
    const records = [rec(A, { status: 'human_reply_hold' }), rec(T)];
    const v = campaignView(records, T, {}, NOW);
    assert.equal(v.campaign.total, 1);
    assert.equal(v.replies.length, 0);
    assert.equal(v.prospects.length, 1);
});
