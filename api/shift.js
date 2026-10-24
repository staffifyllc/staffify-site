// Shifts: Start, Break, Resume, End from the Hub; the owner's corrections; what the gate says.
// ------------------------------------------------------------------
// GET  /api/shift/?me=1            my state, gate, current shift and today's shifts
// POST /api/shift/ {action:'start'|'break'|'resume'|'end', page}
// POST /api/shift/ {action:'correct', user, day, shiftId, endedAt, note}   owners and admins only
//
// Identity is the server's: the signed-in rep, never a name posted by the page. The admin token is
// not a person and cannot hold a shift. One shift per person at a time, across tabs and devices:
// transitions run behind a four-second lock on the person, and the current shift is created with
// SET NX. Every transition is also written to the activity log as an event.
import { redis, requireAccess } from './_auth.js';
import { ownerFor } from './_outreach-queue.js';
import { financeAccess } from './_finance-access.js';
import { recordActivity, dayOf, norm } from './_hub-activity.js';
import { randomUUID } from 'node:crypto';
import { K, MAX_OPEN_MS, shiftRequired, stateOf, gate, start, startBreak, resume, end, correct, archiveStale, minutesOf, shiftsOn, liveCurrent, getLogged, putLogged, DECLARED_TEXT } from './_shift.js';

const canCorrect = rep => !!rep && (rep.role === 'admin' || financeAccess(rep));
const readBody = req => { try { return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch { return {}; } };
const STATUS = { already_on_shift: 409, already_on_break: 409, not_on_shift: 409, not_on_break: 409, shift_too_long: 409, busy: 409, still_running: 409, no_such_shift: 404, note_required: 400, bad_time: 400, before_start: 400, cannot_lengthen: 400 };
const WHY = {
    already_on_shift: 'A shift is already running, possibly from another tab or device.', already_on_break: 'You are already on a break.', not_on_shift: 'No shift is running.',
    not_on_break: 'You are not on a break.', shift_too_long: 'This shift has been open for more than 12 hours. End it, then start a fresh one.', busy: 'Another change is being saved. Try again in a moment.',
    still_running: 'That shift is still running and under 12 hours old. Only the rep can end it.', no_such_shift: 'That shift was not found.', note_required: 'A correction needs a note saying why.', bad_time: 'That is not a valid time.', before_start: 'A shift cannot end before it started.', cannot_lengthen: 'A correction can only shorten a shift.',
};
const EVENT = { start: 'shift_start', break: 'shift_break', resume: 'shift_resume', end: 'shift_end' };
const etText = s => new Date(s).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';

async function view(rep, now) {
    const email = norm(rep.email);
    const required = shiftRequired(rep, ownerFor);
    const cur = await liveCurrent(redis, email);
    const today = await shiftsOn(redis, email, dayOf(now), now, cur);
    return { now: new Date(now).toISOString(), required, state: stateOf(cur, now), gate: gate(cur, now, { required }), shift: cur ? { ...cur, ...minutesOf(cur, now) } : null, today, maxOpenMs: MAX_OPEN_MS, definitions: DECLARED_TEXT };
}

/** Run one transition for one person, behind a lock, writing what changed. */
// The log is written BEFORE the current slot is cleared, so a failure in between leaves a ghost
// that liveCurrent() recognises and clears, never a shift that vanished. The lock carries a nonce
// and is released only by its holder, so a slow request cannot free a newer request's lock.
async function transition(email, action, now, page) {
    const nonce = randomUUID();
    const held = await redis.set(K.lock(email), nonce, { nx: true, px: 4000 });
    if (held === null) return { ok: false, error: 'busy' };
    try {
        const cur = await liveCurrent(redis, email);
        if (action === 'start') {
            const r = start(cur, now, { page });
            if (!r.ok) return r;
            if (r.archived) { await putLogged(redis, email, r.archived); await redis.del(K.current(email)); }
            const made = await redis.set(K.current(email), r.doc, { nx: true });
            if (made === null) return { ok: false, error: 'already_on_shift', doc: await liveCurrent(redis, email) };
            return { ok: true, doc: r.doc, archived: r.archived || null };
        }
        const r = action === 'break' ? startBreak(cur, now) : action === 'resume' ? resume(cur, now) : end(cur, now);
        if (!r.ok) return r;
        if (action === 'end') { await putLogged(redis, email, r.doc); await redis.del(K.current(email)); return { ok: true, doc: null, ended: r.doc }; }
        await redis.set(K.current(email), r.doc);
        return { ok: true, doc: r.doc };
    } finally {
        try { if ((await redis.get(K.lock(email))) === nonce) await redis.del(K.lock(email)); } catch { /* it expires in four seconds */ }
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    const rep = await requireAccess(req);
    if (!rep) return res.status(401).json({ error: 'Sign in to your Staffify account' });
    const me = norm(rep.email);
    const now = Date.now();

    if (req.method === 'GET') {
        if (me === 'admin') return res.status(400).json({ error: 'An admin token has no shift of its own.' });
        try { return res.status(200).json(await view(rep, now)); }
        catch (e) { return res.status(503).json({ error: 'Shift state could not be read: ' + String((e && e.message) || e).slice(0, 120) }); }
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = readBody(req);
    const action = String(b.action || '');

    if (action === 'correct') {
        // A correction names the person who made it, so the shared admin token cannot make one.
        if (me === 'admin') return res.status(403).json({ error: 'Corrections need a signed-in owner, so the record names who made them.' });
        if (!canCorrect(rep)) return res.status(403).json({ error: 'Owners and admins only' });
        const user = norm(b.user), day = String(b.day || ''), shiftId = String(b.shiftId || '');
        if (!user || user === 'admin' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^sh-[a-z0-9]{1,16}$/.test(shiftId)) return res.status(400).json({ error: 'user, day and shiftId are required' });
        try {
            let shift = await getLogged(redis, user, day, shiftId), fromCurrent = false;
            // A forgotten shift still in the current slot: past twelve hours an owner may archive it
            // (open, no end, flagged) and set its end in the same step. Under twelve hours it is the
            // rep's running shift and only the rep can end it.
            if (!shift) {
                const cur = await liveCurrent(redis, user);
                if (!cur || cur.id !== shiftId || cur.day !== day) return res.status(404).json({ error: WHY.no_such_shift, reason: 'no_such_shift' });
                const a = archiveStale(cur, now, me);
                if (!a.ok) return res.status(STATUS[a.error] || 409).json({ error: WHY[a.error] || a.error, reason: a.error });
                shift = a.doc; fromCurrent = true;
            }
            const r = correct(shift, { endedAt: b.endedAt, note: b.note, by: me, at: now });
            if (!r.ok) return res.status(STATUS[r.error] || 400).json({ error: WHY[r.error] || r.error, reason: r.error });
            await putLogged(redis, user, r.doc);
            if (fromCurrent) await redis.del(K.current(user));
            // An event on the rep's log so the change is visible to them, without counting as their presence.
            await recordActivity(redis, { email: user, kind: 'shift_corrected', page: '/activity/', detail: 'End set to ' + etText(r.doc.correctedEndedAt) + ' by ' + me + ': ' + r.doc.corrections.slice(-1)[0].note, at: now, presence: false });
            return res.status(200).json({ ok: true, shift: { ...r.doc, ...minutesOf(r.doc, now) }, archivedFromCurrent: fromCurrent });
        } catch (e) { return res.status(503).json({ error: 'Not saved: ' + String((e && e.message) || e).slice(0, 120) }); }
    }

    if (!EVENT[action]) return res.status(400).json({ error: 'Unknown action' });
    if (me === 'admin') return res.status(403).json({ error: 'An admin token is not a person; it cannot hold a shift.' });
    const page = String(b.page || '').slice(0, 120) || null;
    try {
        const r = await transition(me, action, now, page);
        if (!r.ok) return res.status(STATUS[r.error] || 409).json({ error: WHY[r.error] || r.error, reason: r.error, ...(await view(rep, now)) });
        const detail = action === 'end' && r.ended ? (r.ended.status === 'needs_review' ? 'Flagged: open more than 12 hours' : minutesOf(r.ended, now).clockedMinutes + ' min clocked') : r.archived ? 'Previous shift archived for review (never ended)' : null;
        await recordActivity(redis, { email: me, kind: EVENT[action], page, detail, at: now });
        if (r.archived) await recordActivity(redis, { email: me, kind: 'shift_flagged', page, detail: 'Shift from ' + etText(r.archived.startedAt) + ' was never ended; archived for review', at: now });
        return res.status(200).json({ ok: true, action, ...(await view(rep, now)), ended: r.ended ? { ...r.ended, ...minutesOf(r.ended, now) } : undefined, archived: r.archived || undefined });
    } catch (e) { return res.status(503).json({ error: 'Not saved: ' + String((e && e.message) || e).slice(0, 120) }); }
}
