// A caller's own tasks: "send pricing Friday", "call the office manager after 3".
// ------------------------------------------------------------------
// Paul, 2026-10-23: the dialer should let a rep "schedule follow ups (those followups have
// visibility etc) setting tasks etc". Callbacks already live on the queue record as nextCallAt.
// This is the other half: a task that is not a dial, kept where the dialer can always read it.
//
// Kept in our own store first, mirrored to a HubSpot task second. Milton has no HubSpot user, so a
// HubSpot-only task would be invisible to the one person it was for. The mirror is best effort and
// its result is recorded on the task, so the rep can see whether the CRM will remind them too.
import { createTask, repOwnerId } from './_hubspot.js';
import { loginAliases } from './_login-aliases.js';

export const TASKS_KEY = email => 'staffify:rep-tasks:' + String(email || '').toLowerCase();
const MAX = 300;
const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export async function listTasks(redis, email) {
  try { const v = await redis.get(TASKS_KEY(email)); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * Add a task for this caller. Validates the little that can be validated; never throws.
 * @returns {{ok:boolean, task?:object, reason?:string, hubspot?:object}}
 */
export async function addTask(redis, { rep, title, dueAt, notes = '', recordId = null, company = '', recipient = null, campaignId = null, contactId = null, deps = {} }) {
  const email = rep && rep.email;
  const t = String(title || '').trim().slice(0, 160);
  const due = Date.parse(dueAt);
  if (!email) return { ok: false, reason: 'no_rep' };
  if (!t) return { ok: false, reason: 'no_title' };
  if (!(due > Date.now() - 60000)) return { ok: false, reason: 'time_in_past' };
  const task = { id: newId(), title: t, dueAt: new Date(due).toISOString(), notes: String(notes || '').slice(0, 1200), recordId, company: String(company || '').slice(0, 120),
    recipient: recipient ? String(recipient).toLowerCase() : null, campaignId, createdAt: new Date().toISOString(), doneAt: null, hubspot: null };

  // The CRM mirror, when this caller has a HubSpot user. Reported, never required.
  const create = deps.createTask || createTask, resolveOwner = deps.repOwnerId || repOwnerId;
  try {
    let ownerId = '';
    for (const e of loginAliases(email)) { ownerId = await resolveOwner(rep.name, e, { redis }).catch(() => ''); if (ownerId) break; }
    if (ownerId) {
      const r = await create({ contactId, subject: t, body: [notes, company ? 'Company: ' + company : null, 'Set from the dialer by ' + (rep.name || email)].filter(Boolean).join('\n\n'), dueAt: due, ownerId, priority: 'MEDIUM', reminderAt: due });
      task.hubspot = r && r.ok ? { ok: true, id: r.id } : { ok: false, reason: (r && r.reason) || 'task_failed' };
    } else task.hubspot = { ok: false, reason: 'no_owner' };
  } catch (e) { task.hubspot = { ok: false, reason: String((e && e.message) || e).slice(0, 80) }; }

  try {
    const prior = await listTasks(redis, email);
    const next = [...prior, task].slice(-MAX);
    await redis.set(TASKS_KEY(email), next, { ex: 400 * 86400 });
    return { ok: true, task };
  } catch (e) { return { ok: false, reason: 'store failed: ' + String((e && e.message) || e).slice(0, 80) }; }
}

/** Mark one of this caller's tasks done (or undone). Never throws. */
export async function completeTask(redis, { email, id, done = true }) {
  try {
    const prior = await listTasks(redis, email);
    if (!prior.some(t => t.id === id)) return { ok: false, reason: 'not_found' };
    const next = prior.map(t => t.id === id ? { ...t, doneAt: done ? new Date().toISOString() : null } : t);
    await redis.set(TASKS_KEY(email), next, { ex: 400 * 86400 });
    return { ok: true, task: next.find(t => t.id === id) };
  } catch (e) { return { ok: false, reason: 'store failed: ' + String((e && e.message) || e).slice(0, 80) }; }
}
