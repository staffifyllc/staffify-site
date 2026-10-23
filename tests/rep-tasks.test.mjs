// A caller's own tasks: stored with us first, mirrored to HubSpot when the caller has a user there.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || 'https://example.invalid';
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || 'test';
const { addTask, completeTask, listTasks, TASKS_KEY } = await import('../api/_rep-tasks.js');

const store = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async set(k, v) { m.set(k, v); return 'OK'; } }; };
const milton = { email: 'miltion@trystaffify.com', name: 'Milton' };
const future = new Date(Date.now() + 3600000).toISOString();

test('a task is kept for the caller even when HubSpot has no user for them', async () => {
    const redis = store();
    const created = [];
    const r = await addTask(redis, { rep: milton, title: 'Send pricing', dueAt: future, notes: 'asked on the call', recordId: 'r1', company: 'Loft & Light', recipient: 'P@X.com',
        deps: { repOwnerId: async () => '', createTask: async t => { created.push(t); return { ok: true, id: '1' }; } } });
    assert.equal(r.ok, true);
    assert.equal(r.task.title, 'Send pricing');
    assert.equal(r.task.recipient, 'p@x.com');
    assert.deepEqual(r.task.hubspot, { ok: false, reason: 'no_owner' }, 'the rep is told the CRM will not remind them');
    assert.equal(created.length, 0, 'no unowned HubSpot task is created');
    const list = await listTasks(redis, 'MILTION@trystaffify.com');
    assert.equal(list.length, 1); assert.equal(list[0].doneAt, null);
});

test('with a HubSpot user, the task is mirrored with a reminder at the due time and linked to the contact', async () => {
    const redis = store();
    const created = [];
    const r = await addTask(redis, { rep: milton, title: 'Call the office manager', dueAt: future, contactId: '555', company: 'Zenoti',
        deps: { repOwnerId: async (name, email) => email === 'milton@trystaffify.com' ? 'OWN1' : '', createTask: async t => { created.push(t); return { ok: true, id: 'HS9' }; } } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.task.hubspot, { ok: true, id: 'HS9' });
    assert.equal(created[0].ownerId, 'OWN1', 'found through the alias spelling');
    assert.equal(created[0].contactId, '555');
    assert.equal(created[0].reminderAt, Date.parse(future));
    assert.equal(created[0].subject, 'Call the office manager');
});

test('bad input is refused with a reason, never half-saved', async () => {
    const redis = store();
    assert.equal((await addTask(redis, { rep: milton, title: '', dueAt: future })).reason, 'no_title');
    assert.equal((await addTask(redis, { rep: milton, title: 'x', dueAt: '2020-01-01T00:00:00Z' })).reason, 'time_in_past');
    assert.equal((await addTask(redis, { rep: {}, title: 'x', dueAt: future })).reason, 'no_rep');
    assert.equal((await addTask(redis, { rep: milton, title: 'x', dueAt: 'not a date' })).reason, 'time_in_past');
    assert.equal(redis.m.size, 0);
});

test('done is reversible and scoped to the caller; a failed read is an empty list, not a crash', async () => {
    const redis = store();
    const deps = { repOwnerId: async () => '', createTask: async () => ({ ok: true, id: 'x' }) };
    const a = await addTask(redis, { rep: milton, title: 'A', dueAt: future, deps });
    const d = await completeTask(redis, { email: milton.email, id: a.task.id });
    assert.equal(d.ok, true); assert.ok(d.task.doneAt);
    assert.equal((await completeTask(redis, { email: 'other@x.com', id: a.task.id })).reason, 'not_found');
    const u = await completeTask(redis, { email: milton.email, id: a.task.id, done: false });
    assert.equal(u.task.doneAt, null);
    const dead = { async get() { throw new Error('down'); }, async set() { throw new Error('down'); } };
    assert.deepEqual(await listTasks(dead, milton.email), []);
    assert.match((await addTask(dead, { rep: milton, title: 'A', dueAt: future, deps })).reason, /store failed/);
    assert.equal(TASKS_KEY('X@Y.com'), 'staffify:rep-tasks:x@y.com');
});
