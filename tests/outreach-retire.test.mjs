// Paul, 2026-10-29: "I don't have that email anymore, that email is milton@trystaffify.com".
import test from 'node:test';
import assert from 'node:assert/strict';
import { retireSender } from '../api/_outreach-retire.js';

const acct = (email, owner = 'Paul') => ({ email, owner, brand: 'Staffify', draftEnabled: true, dailyLimit: 50 });
const CFG = { enabled: true, sendingEnabled: true, expectedAccounts: 4, allowedCampaignIds: ['staffify-talent-network-outreach'], accounts: [acct('paul@trystaffify.com'), acct('paul@staffifyhq.com'), acct('paul@hirestaffify.com'), acct('madison@staffifyhq.com', 'Madison')] };
const row = (id, over) => ({ id, campaignId: 'staffify-talent-network-outreach', owner: 'Paul', sender: 'paul@trystaffify.com', recipient: id + '@x.com', status: 'prepared', sentTouches: 0, ...over });
const STATE = { revision: 7, records: [
    row('new1'), row('new2', { status: 'contact_research_hold', recipient: '' }),
    row('mid', { status: 'sent', sentTouches: 2, threadId: 't1' }), row('draft', { status: 'draft_saved', sentTouches: 1, draftId: 'd1', threadId: 't2' }),
    row('done', { status: 'sent', sentTouches: 4, threadId: 't3' }), row('stop', { status: 'suppressed', sentTouches: 2 }),
    row('other', { sender: 'paul@staffifyhq.com' }), row('other2', { sender: 'paul@staffifyhq.com' }),
] };

test('a renamed mailbox leaves the worker: unstarted prospects move, sequences under way are held, nothing else changes', () => {
    const { cfg, state, summary } = retireSender({ cfg: CFG, state: STATE, email: 'paul@trystaffify.com', replacedBy: 'milton@trystaffify.com', now: 'T' });
    assert.deepEqual(cfg.accounts.map(a => a.email), ['paul@staffifyhq.com', 'paul@hirestaffify.com', 'madison@staffifyhq.com']);
    assert.equal(cfg.expectedAccounts, 3); assert.deepEqual(cfg.retiredAccounts, [{ email: 'paul@trystaffify.com', owner: 'Paul', at: 'T', replacedBy: 'milton@trystaffify.com' }]);
    assert.deepEqual(cfg.allowedCampaignIds, CFG.allowedCampaignIds, 'the campaign list is untouched');
    const by = Object.fromEntries(state.records.map(r => [r.id, r]));
    assert.equal(by.new1.sender, 'paul@hirestaffify.com', 'to the least-used mailbox of the same owner');
    assert.equal(by.new2.sender, 'paul@hirestaffify.com'); assert.equal(by.new1.senderMoved.from, 'paul@trystaffify.com');
    assert.equal(by.mid.status, 'sender_retired_hold'); assert.equal(by.mid.heldFrom, 'sent'); assert.match(by.mid.heldWhy, /milton@trystaffify\.com/);
    assert.equal(by.mid.sender, 'paul@trystaffify.com', 'a held sequence keeps its sender, so its history still reads true');
    assert.equal(by.draft.status, 'sender_retired_hold', 'a saved draft in the old mailbox is not sent from anywhere');
    assert.equal(by.done.status, 'sent', 'a finished sequence is untouched'); assert.equal(by.stop.status, 'suppressed', 'and so is a stop');
    assert.equal(by.other.sender, 'paul@staffifyhq.com');
    assert.deepEqual(summary, { moved: 2, held: 2, untouched: 2, byStatus: { sent: 1, draft_saved: 1 } });
    assert.equal(state.revision, 8); assert.equal(STATE.records[0].sender, 'paul@trystaffify.com', 'the input is not changed');
});

test('a mailbox the worker does not have, or an owner with nowhere to move to, is refused', () => {
    assert.throws(() => retireSender({ cfg: CFG, state: STATE, email: 'nobody@trystaffify.com' }), /not in the worker inventory/);
    assert.throws(() => retireSender({ cfg: CFG, state: STATE, email: 'madison@staffifyhq.com' }), /No other Madison mailbox/);
});
