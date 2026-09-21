// The state an inbound role-map request may be in, and what each state demands before it may be set.
// Kept separate from the endpoint so the gate can be tested without Redis or a session.
//
// This is where "a request is not a booking" and "a task is not a send" are enforced for inbound.

export const REQUEST_STATES = Object.freeze({
    REQUESTED:      { needs: [], label: 'Asked for a role map' },
    ANSWERED:       { needs: ['answeredAt'], label: 'Paul replied' },
    ROLE_MAP_SENT:  { needs: ['roleMapSentAt', 'roleMapArtifact'], label: 'Role map sent' },
    TIME_AGREED:    { needs: ['agreedFor'], label: 'Time agreed, not booked' },
    BOOKED:         { needs: ['agreedFor', 'bookingRef'], label: 'On a calendar' },
    HELD:           { needs: ['bookingRef', 'heldAt'], label: 'Call held' },
    CLOSED:         { needs: ['answerKind'], label: 'Closed' },
});

export const ANSWER_KINDS = Object.freeze(['NO_RESPONSE', 'ALREADY_COVERED', 'NOT_NOW', 'NO_NEED', 'DECLINED', 'SUPPRESSED']);
export const WORDLESS_ANSWERS = Object.freeze(['NO_RESPONSE', 'SUPPRESSED']);

const S = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);

/**
 * Can this record move to this state, given what the operator just typed?
 * @returns {{ok:true, patch:object}|{ok:false, error:string, hint?:string}}
 */
export function validateTransition(existing = {}, state = '', set = {}) {
    if (!REQUEST_STATES[state]) return { ok: false, error: 'unknown state' };
    const patch = { state, updatedAt: new Date().toISOString(), owner: S(set.owner, 60) || existing.owner || 'Paul' };
    for (const f of ['answeredAt', 'roleMapSentAt', 'roleMapArtifact', 'agreedFor', 'bookingRef', 'heldAt', 'answerWords', 'notes']) {
        if (set[f] !== undefined) patch[f] = S(set[f], (f === 'notes' || f === 'answerWords') ? 1200 : 200);
    }
    if (set.answerKind !== undefined) {
        const k = S(set.answerKind, 30).toUpperCase();
        if (k && !ANSWER_KINDS.includes(k)) return { ok: false, error: 'unknown answer' };
        patch.answerKind = k;
    }
    const merged = { ...existing, ...patch };
    const missing = REQUEST_STATES[state].needs.filter((f) => !S(merged[f], 200));
    if (missing.length) {
        return { ok: false, error: `${state} needs ${missing.join(' and ')}`,
            hint: state === 'BOOKED' ? 'An agreed time is not a booking. Put in the calendar reference.'
                : state === 'ROLE_MAP_SENT' ? 'A task is not a send. Name what you actually sent.'
                : state === 'CLOSED' ? 'Record what they said, in their words.' : '' };
    }
    if (state === 'CLOSED' && merged.answerKind && !WORDLESS_ANSWERS.includes(merged.answerKind)
        && !S(merged.answerWords, 1200)) {
        return { ok: false, error: 'a reason is only a reason when they said it. Paste their words.' };
    }
    return { ok: true, patch };
}
