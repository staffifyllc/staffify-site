// A number a caller has proven wrong is never offered for that person again.
// ------------------------------------------------------------------
// Codex's reliability brief, 2026-10-22: "Missing, invalid or wrong-party numbers go to automatic
// background number research, not a dead-end caller card."
//
// That last case was not actually covered. When Milton logged Zenoti as a wrong number that day,
// the eligibility rule stopped offering the lead for good and nothing sent it back to research.
// The number was the main line taken off Zenoti's own homepage, so the very source that found it
// would have offered it again, and the lead sat dead.
//
// So a wrong-number outcome records WHICH number was wrong, for that person only. Every source in
// the phone ladder skips it from then on, the research attempts are reset so the background pass
// looks again, and when a different number turns up the lead is callable through the normal rules.
// The history of the wrong call is kept on the record either way.
export const BAD_KEY = email => 'staffify:bad-numbers:' + String(email || '').toLowerCase();
export const digits10 = s => String(s || '').replace(/\D/g, '').slice(-10);

/** Every number a caller has proven wrong for this person, as last-ten digits. Never throws. */
export async function loadBad(redis, email) {
    try {
        const v = await redis.get(BAD_KEY(email));
        return new Set((v && Array.isArray(v.numbers) ? v.numbers : []).map(digits10).filter(Boolean));
    } catch { return new Set(); }
}

export const isBad = (bad, phone) => !!phone && bad.has(digits10(phone));

/**
 * Record a number as wrong. The number must be one this person actually had on file, so a request
 * cannot plant an arbitrary number against somebody. Never throws.
 */
export async function markBad(redis, { email, phone, known = [], by, at = new Date().toISOString() }) {
    const d = digits10(phone);
    if (d.length !== 10) return { ok: false, reason: 'not a usable number' };
    if (!known.map(digits10).includes(d)) return { ok: false, reason: 'that number was not on file for this person' };
    try {
        const prior = (await redis.get(BAD_KEY(email))) || { numbers: [], log: [] };
        const numbers = [...new Set([...(prior.numbers || []), d])];
        const log = [...(prior.log || []), { number: d, by: by || null, at }].slice(-20);
        await redis.set(BAD_KEY(email), { numbers, log }, { ex: 365 * 86400 });
        return { ok: true, numbers };
    } catch (e) {
        return { ok: false, reason: 'store failed: ' + String((e && e.message) || e).slice(0, 80) };
    }
}
