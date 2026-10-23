// "Bad time" becomes a callback with a reminder, and a due callback comes first.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "if they select bad time can we make a task time to call them back that
// reminds the sales person to call them back."
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderCallQueue } from '../assets/js/call-queue-order.js';
import { scheduleCallbackTask, taskFor, TASK_KEY } from '../api/_callback-task.js';

const rec = (id, over = {}) => ({ id, campaignId: 'c', owner: 'Paul', callReady: true, unclaimed: true,
    lastSentAt: '2026-10-01T12:00:00Z', callContact: { phone: '+15125550100', phoneStatus: 'available' }, ...over });

// ---------- the queue ----------

test('the numbers found today are actually offered to the caller', () => {
    // The ladder gained site_main and crm_unconfirmed on 2026-10-22 and the queue's allow-list did
    // not, so the six Spearhead numbers pulled off company websites were filtered straight back out.
    const q = orderCallQueue([
        rec('site', { callContact: { phone: '+15122981700', phoneStatus: 'site_main' } }),
        rec('crm', { callContact: { phone: '+13055551234', phoneStatus: 'crm_unconfirmed' } }),
        rec('none', { callContact: { phone: null, phoneStatus: 'missing' } }),
        rec('old', { callContact: { phone: '+13055550000', phoneStatus: 'needs_confirmation' } }),
    ]);
    const ids = q.map(r => r.id);
    assert.ok(ids.includes('site'), 'a published main line is dialable');
    assert.ok(ids.includes('crm'), 'a labelled CRM number is dialable');
    assert.ok(!ids.includes('none'), 'no number is still not offered');
    assert.ok(!ids.includes('old'), 'the legacy unconfirmed status is still held back');
});

test('a callback that has come due goes ahead of everything, earliest first', () => {
    const now = Date.now();
    const q = orderCallQueue([
        rec('listed', { callContact: { phone: '+1', phoneStatus: 'business_listed' } }),
        rec('due-late', { callOutcome: 'callback', nextCallAt: new Date(now - 60000).toISOString(), dueForMe: true }),
        rec('due-early', { callOutcome: 'callback', nextCallAt: new Date(now - 3600000).toISOString(), dueForMe: true }),
        rec('fresh'),
    ]);
    assert.deepEqual(q.slice(0, 2).map(r => r.id), ['due-early', 'due-late'], 'promised callbacks first, oldest promise first');
    assert.equal(q[2].id, 'listed', 'then corroborated numbers, as before');
});

test('a callback that is not due yet is not promoted', () => {
    const q = orderCallQueue([
        rec('listed', { callContact: { phone: '+1', phoneStatus: 'business_listed' } }),
        rec('later', { callOutcome: 'callback', nextCallAt: new Date(Date.now() + 86400000).toISOString(), dueForMe: true }),
    ]);
    assert.equal(q[0].id, 'listed');
});

// ---------- the task ----------

const ROW = { id: 'r1', recipient: 'krista@cincyphotopro.com', verifiedFirstName: 'Krista', company: 'Cincy Photo Pro',
    campaignId: 'staffify-agency-outreach', hubspotId: '9001', callContact: { phone: '+15137408860' } };
const store = (seed = {}) => ({ _: seed, async get(k) { return seed[k] ?? null; }, async set(k, v) { seed[k] = v; return 'OK'; } });
const WHEN = new Date(Date.now() + 86400000).toISOString();

test('the task is owned by the caller, due at the agreed time, with the reminder set for it', async () => {
    let made = null;
    const r = await scheduleCallbackTask({ redis: store(), row: ROW, rep: { name: 'Milton', email: 'miltion@trystaffify.com' },
        nextCallAt: WHEN, notes: 'Bad time, in a shoot.',
        deps: { repOwnerId: async (n, email) => (email === 'milton@trystaffify.com' ? 'OWNER-42' : ''),
                createTask: async args => { made = args; return { ok: true, id: 'T1', linked: true }; } } });
    assert.equal(r.ok, true);
    assert.equal(made.ownerId, 'OWNER-42', 'found through the contract spelling of his address');
    assert.equal(made.dueAt, Date.parse(WHEN));
    assert.equal(made.reminderAt, Date.parse(WHEN), 'HubSpot reminds him at the agreed time');
    assert.equal(made.contactId, '9001');
    assert.match(made.subject, /Call back Krista at Cincy Photo Pro/);
    assert.match(made.body, /Bad time, in a shoot\./);
    assert.match(made.body, /\+15137408860/);
});

test('a double click does not stack a second task for the same callback', async () => {
    let calls = 0;
    const redis = store();
    const deps = { repOwnerId: async () => 'O', createTask: async () => { calls++; return { ok: true, id: 'T' + calls }; } };
    await scheduleCallbackTask({ redis, row: ROW, rep: { name: 'M', email: 'm@x.com' }, nextCallAt: WHEN, deps });
    const again = await scheduleCallbackTask({ redis, row: ROW, rep: { name: 'M', email: 'm@x.com' }, nextCallAt: WHEN, deps });
    assert.equal(calls, 1);
    assert.equal(again.reused, true);
    // A genuinely rescheduled callback gets its own task.
    const later = new Date(Date.parse(WHEN) + 3600000).toISOString();
    await scheduleCallbackTask({ redis, row: ROW, rep: { name: 'M', email: 'm@x.com' }, nextCallAt: later, deps });
    assert.equal(calls, 2);
    assert.notEqual(TASK_KEY('r1', WHEN), TASK_KEY('r1', later));
});

test('no HubSpot user means no task, said plainly, and never an unowned task', async () => {
    let created = false;
    const r = await scheduleCallbackTask({ redis: store(), row: ROW, rep: { name: 'Milton', email: 'miltion@trystaffify.com' }, nextCallAt: WHEN,
        deps: { repOwnerId: async () => '', createTask: async () => { created = true; return { ok: true }; } } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_owner');
    assert.equal(created, false, 'a task nobody owns is not somebody\'s job');
    assert.match(r.detail, /will come back to the top of the queue/);
});

test('a CRM failure never throws, so it can never lose the saved callback', async () => {
    const r = await scheduleCallbackTask({ redis: store(), row: ROW, rep: { name: 'M', email: 'm@x.com' }, nextCallAt: WHEN,
        deps: { repOwnerId: async () => { throw new Error('HubSpot 503'); }, createTask: async () => { throw new Error('boom'); } } });
    assert.equal(r.ok, false);
    const r2 = await scheduleCallbackTask({ redis: store(), row: ROW, rep: { name: 'M', email: 'm@x.com' }, nextCallAt: WHEN,
        deps: { repOwnerId: async () => 'O', createTask: async () => { throw new Error('boom'); } } });
    assert.equal(r2.ok, false);
    assert.match(r2.detail, /boom/);
});

test('the task text comes from the record, with a link back to the card', () => {
    const t = taskFor({ row: ROW, caller: 'Milton', nextCallAt: WHEN, notes: '' });
    assert.match(t.body, /Milton agreed to call back at/);
    assert.match(t.body, /bad time/i);
    assert.match(t.body, /https:\/\/www\.gostaffify\.com\/dialer\/\?campaign=staffify-agency-outreach/);
    assert.ok(!/Notes from the call/.test(t.body), 'no empty notes line');
});
