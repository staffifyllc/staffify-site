// A callback is a task with a time on it, owned by the person who promised it.
// ------------------------------------------------------------------
// Paul, 2026-10-22, on the "Bad time" step of the call script: "if they select bad time can we
// make a task time to call them back that reminds the sales person to call them back."
//
// Two reminders, because either one alone has a way to fail:
//
//   1. A HUBSPOT TASK, owned by the caller, due at the agreed time, with HubSpot's own reminder set
//      for that moment. HubSpot sends the notification; we do not run a reminder service. The caller
//      sees it in the CRM they already use.
//   2. THE QUEUE ITSELF. A callback that comes due goes to the top of its owner's queue, ahead of
//      everything else. That works even when HubSpot does not: no owner mapping, a token problem,
//      an outage.
//
// The task is created strictly AFTER the callback is saved, and it can never fail the save. A
// caller who just agreed a time on the phone must never be told their callback was lost because
// the CRM was slow. If the task cannot be made, the response says so plainly and the queue still
// brings the callback back.
//
// One task per callback: the agreed time is part of the key, so a double-click or a retried save
// does not stack duplicate tasks, while a genuinely rescheduled callback gets a fresh one.
import { createTask, repOwnerId } from './_hubspot.js';
import { loginAliases } from './_login-aliases.js';

export const TASK_KEY = (id, at) => 'staffify:callback-task:' + String(id) + ':' + String(at);

const fmt = iso => {
    const d = new Date(iso);
    if (Number.isNaN(+d)) return String(iso);
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d) + ' ET';
};

/** The task text. Built from the record, never from anything typed in the browser except the note. */
export function taskFor({ row, caller, nextCallAt, notes }) {
    const who = [row.verifiedFirstName, row.company].filter(Boolean).join(' at ') || row.recipient;
    const phone = (row.callContact && row.callContact.phone) || row.phone || null;
    return {
        subject: `Call back ${who}`.slice(0, 250),
        body: [
            `${caller || 'The caller'} agreed to call back at ${fmt(nextCallAt)}. They said it was a bad time.`,
            phone ? `Number: ${phone}` : 'No number on the record yet.',
            notes ? `Notes from the call: ${String(notes).slice(0, 1200)}` : null,
            `Open the card: https://www.gostaffify.com/dialer/?campaign=${encodeURIComponent(row.campaignId || 'all')}`,
        ].filter(Boolean).join('\n\n'),
    };
}

/**
 * Create the task. Never throws.
 * @returns {{ok:boolean, reason?:string, id?:string, owner?:string}}
 */
export async function scheduleCallbackTask({ redis, row, rep, nextCallAt, notes, deps = {} }) {
    const create = deps.createTask || createTask;
    const resolveOwner = deps.repOwnerId || repOwnerId;
    try {
        if (!row || !nextCallAt || !(Date.parse(nextCallAt) > 0)) return { ok: false, reason: 'no_time' };
        const key = TASK_KEY(row.id, nextCallAt);
        const prior = await redis.get(key).catch(() => null);
        if (prior && prior.id) return { ok: true, id: prior.id, reused: true };

        // Whoever owns the HubSpot user for this caller. Every spelling of their address is tried,
        // because Milton signs in as the misspelled one and his CRM user may carry either.
        let ownerId = '';
        for (const email of loginAliases(rep && rep.email)) {
            ownerId = await resolveOwner(rep && rep.name, email, { redis }).catch(() => '');
            if (ownerId) break;
        }
        if (!ownerId) {
            return { ok: false, reason: 'no_owner',
                detail: 'No HubSpot user matches this caller, so no CRM task was made. The callback is still saved and will come back to the top of the queue at that time.' };
        }

        const contactId = row.hubspotId || row.crmContactId || null;
        const t = taskFor({ row, caller: rep && rep.name, nextCallAt, notes });
        const due = Date.parse(nextCallAt);
        const r = await create({ contactId, subject: t.subject, body: t.body, dueAt: due, ownerId, priority: 'HIGH', reminderAt: due });
        if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || 'task_failed', detail: r && r.detail };
        await redis.set(key, { id: r.id, at: new Date().toISOString(), owner: ownerId }, { ex: 120 * 86400 }).catch(() => {});
        return { ok: true, id: r.id, owner: ownerId, linked: r.linked !== false };
    } catch (e) {
        return { ok: false, reason: 'task_error', detail: String((e && e.message) || e).slice(0, 160) };
    }
}
