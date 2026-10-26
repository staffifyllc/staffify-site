// Signed in, and numbers only on a running shift. One guard for the older endpoints that hand out
// prospect phone numbers.
// ------------------------------------------------------------------
// Paul, 2026-10-26 (through Codex): Milton must start a shift before calling through the Hub. These
// endpoints were open to anyone from 2026-07-27 (open-share) and would return prospect numbers to a
// signed-out request whenever they held data. Now: a Hub session or an admin/machine token
// (requireAccess), and for a caller who is not on a running shift every response leaves with its
// phone fields empty (withholdPhones, by field name). Writes still go through: logging what
// happened on a call is never gated. Owners are never gated; an unreadable shift reads as off.
import { requireAccess, redis } from './_auth.js';
import { ownerFor } from './_outreach-queue.js';
import { gateFor, withholdPhones } from './_shift.js';

/**
 * Answers 401 / 503 itself and returns null when the request may not proceed. Otherwise returns
 * { who, shiftGate } and, for a gated caller, wraps res.json so nothing leaves with a number in it.
 */
export async function phoneGuard(req, res) {
    let who = null;
    try { who = await requireAccess(req); }
    catch { res.status(503).json({ error: 'sign_in_check_unavailable', message: 'Your sign-in could not be checked just now. Try again.' }); return null; }
    if (!who) { res.status(401).json({ error: 'sign_in_required', message: 'Sign in to your Staffify account.' }); return null; }
    const shiftGate = await gateFor(redis, who, ownerFor);
    if (!shiftGate.allowed) {
        const json = res.json.bind(res);
        res.json = body => json(body && typeof body === 'object' && !Array.isArray(body) ? { ...withholdPhones(body, { deep: true }), phonesWithheld: true, shiftGate } : withholdPhones(body, { deep: true }));
    }
    return { who, shiftGate };
}
