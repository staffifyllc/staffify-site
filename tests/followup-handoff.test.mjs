// The "15 tasks" opener promised the list with no call required; its first follow-up keeps that promise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { followup } from '../api/_outreach-policy.js';
import { copyIssue } from '../api/_outreach-copy.js';

test('the first follow-up to the handoff-list opener delivers the list and asks for no call', () => {
    for (const owner of ['Paul', 'Madison']) {
        const body = followup({ campaignId: 'staffify-agency-outreach', copyVersion: 'handoff-list-2026-10-23', sentTouches: 1, verifiedFirstName: 'Tom', owner });
        assert.match(body, /Here is the list I mentioned/);
        assert.match(body, /real-estate-photography-tasks-to-delegate/);
        assert.match(body, /No call needed/);
        assert.ok(!/calendly/i.test(body), 'no booking link on a touch that promised no call');
        assert.ok(!/—/.test(body));
        assert.equal(copyIssue({ owner, bodyText: body, subject: 'Re: 15 tasks to hand off after the shoot' }), null);
    }
    // Every other opener keeps the shared second touch, and later touches are untouched for all.
    assert.match(followup({ campaignId: 'staffify-agency-outreach', copyVersion: 'conversational-2026-10-04', sentTouches: 1, verifiedFirstName: 'Tom', owner: 'Paul' }), /15-minute chat/);
    const t3a = followup({ campaignId: 'staffify-agency-outreach', copyVersion: 'handoff-list-2026-10-23', sentTouches: 2, verifiedFirstName: 'Tom', owner: 'Paul' });
    const t3b = followup({ campaignId: 'staffify-agency-outreach', copyVersion: 'conversational-2026-10-04', sentTouches: 2, verifiedFirstName: 'Tom', owner: 'Paul' });
    assert.equal(t3a, t3b);
});
