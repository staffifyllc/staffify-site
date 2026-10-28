// Paul, 2026-10-28: "make sure that all of the sales reps are able to send emails out". Google refuses gostaffify.com
// accounts for the Hub's Gmail app (Internal to the Workspace with trystaffify.com), so a gostaffify.com login sends
// from that rep's own Staffify sending mailbox, and every send is still copied and routed to hello@.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.KV_REST_API_URL = 'https://example.invalid';
process.env.KV_REST_API_TOKEN = 'test';
delete process.env.REP_SEND_AS;
const R = await import('../api/_rep-email.js');

test('a gostaffify.com login sends from that rep\'s Staffify mailbox, routed to hello@', () => {
    assert.equal(R.mailboxFor({ email: 'hello@gostaffify.com' }), 'paul@trystaffify.com');
    assert.equal(R.mailboxFor({ email: 'madison@gostaffify.com' }), 'madison@trystaffify.com');
    assert.equal(R.mailboxFor({ email: 'miltion@trystaffify.com' }), 'milton@trystaffify.com', 'Milton is unchanged');
    assert.equal(R.mailboxFor({ email: 'nobody@gostaffify.com' }), null);
    assert.equal(R.profileFor('paul@trystaffify.com').title, 'Founder'); assert.equal(R.profileFor('madison@trystaffify.com').name, 'Madison Sterling');
    assert.deepEqual(R.routeCopy('paul@trystaffify.com', 'Paul Chareth'), { bcc: 'hello@gostaffify.com', replyTo: '"Paul Chareth" <paul@trystaffify.com>, hello@gostaffify.com' }, 'Paul\'s sends land in hello@ too');
    assert.ok(R.TEAM_MAILBOXES.includes('madison@trystaffify.com') && R.TEAM_MAILBOXES.includes('paul@trystaffify.com'), 'their copies in hello@ are the team\'s mail');
});
