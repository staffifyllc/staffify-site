// Nobody reaches a caller without a number.
// ------------------------------------------------------------------
// Paul, 2026-10-22, relayed: "There needs to never be someone in there without a number, it
// shouldn't crash the entire system if it can't find it it should just do what it needs to in
// order to get the number."
//
// Two halves, and the second is the one that keeps the first honest.
//
// HOLD. A record with no usable number is not call-ready. It leaves Ready to call and sits in a
// research state with a reason, rather than being handed to a caller as a card they cannot work.
// It is never deleted and no number is ever invented for it.
//
// FIND. A background pass works that backlog on its own: the business's own website first because
// that is free, then a vendor direct dial, which is metered and therefore capped. Every attempt is
// recorded against the record, so a provider that is down, a token that expired or a site that
// times out costs one retry on a growing delay rather than the same spend every run.
//
// Nothing in here throws. One malformed record, one dead provider or one timeout must not take the
// queue down with it, so every step is isolated and the worst case is that one record stays in
// research while the rest of the queue carries on.

export const ATTEMPTS = email => 'staffify:number-research:' + String(email || '').toLowerCase();

// Bounded backoff. A site that has nothing today still has nothing in an hour, and a provider that
// is down deserves a retry, not a hammering. Hours, by attempt number.
const BACKOFF_HOURS = [0, 1, 6, 24, 72, 168];
export const nextTryAt = (attempt, from = Date.now()) =>
    from + (BACKOFF_HOURS[Math.min(attempt, BACKOFF_HOURS.length - 1)]) * 3600000;

/** Sources, cheapest first. A free source is always exhausted before a metered one. */
export const SOURCES = Object.freeze([
    { key: 'website', cost: 'free', needs: 'website' },
    { key: 'vendor', cost: 'metered', needs: 'email' },
]);

/**
 * What to do with one record right now. Pure, so the decision is testable without a network.
 * @returns {{action:'wait'|'try'|'exhausted', source?:string, reason:string, dueAt?:number}}
 */
export function decide(row, state, now = Date.now()) {
    const tried = new Set((state && state.tried) || []);
    const attempt = Number(state && state.attempts) || 0;
    const due = Number(state && state.nextTryAt) || 0;
    if (due > now) return { action: 'wait', reason: 'backing off after a failed attempt', dueAt: due };
    for (const s of SOURCES) {
        if (tried.has(s.key)) continue;
        if (s.needs === 'website' && !websiteOf(row)) continue;
        return { action: 'try', source: s.key, reason: `${s.key} not tried yet`, dueAt: now };
    }
    // Everything we have has been asked. Say so plainly rather than retrying for ever.
    return {
        action: 'exhausted',
        reason: attempt
            ? `No number found after ${attempt} attempt${attempt === 1 ? '' : 's'} across ${[...tried].join(' and ') || 'no usable source'}.`
            : 'No website on file and no vendor result, so there is nothing left to ask.',
    };
}

export const websiteOf = r => (r && ((r.source && r.source.url) || r.website)) || null;

/** Record an attempt. Never throws; a failed write costs a repeat, not a crash. */
export async function noteAttempt({ redis, email, source, found, detail, now = Date.now() }) {
    try {
        const prior = (await redis.get(ATTEMPTS(email))) || {};
        const tried = new Set([...(prior.tried || []), source]);
        const attempts = (Number(prior.attempts) || 0) + 1;
        const next = {
            tried: [...tried], attempts,
            lastSource: source, lastAt: new Date(now).toISOString(),
            lastDetail: String(detail || '').slice(0, 160),
            found: !!found,
            nextTryAt: found ? 0 : nextTryAt(attempts, now),
        };
        await redis.set(ATTEMPTS(email), next, { ex: 180 * 86400 });
        return next;
    } catch { return null; }
}

/**
 * The caller-facing status for a record with no number. This is what replaces a dead-end card.
 */
export function researchStatus(row, state, now = Date.now()) {
    const d = decide(row, state, now);
    if (d.action === 'exhausted') {
        return { state: 'exhausted', label: 'No number could be found', detail: d.reason,
            // Kept, not deleted, and not promoted. Somebody may still want to work it by email.
            callable: false };
    }
    if (d.action === 'wait') {
        return { state: 'researching', label: 'Finding a number',
            detail: `Tried ${((state && state.tried) || []).join(' and ') || 'nothing yet'}. Next attempt ${new Date(d.dueAt).toLocaleString()}.`,
            callable: false };
    }
    return { state: 'researching', label: 'Finding a number',
        detail: `Queued to check their ${d.source === 'website' ? 'website' : 'direct dial with a data vendor'}.`,
        callable: false };
}
