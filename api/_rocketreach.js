// RocketReach client. Direct-dial numbers for contacts whose number is not published anywhere.
// ------------------------------------------------------------------
// Paul, 2026-10-20, for the Tobit CEO cohort: twenty-one chief executives at real companies, four
// emails sent to each, and not one phone number. Findymail and the site-scraping path both find
// nothing there because a CEO's direct line is not on the corporate website, which is exactly the
// gap this vendor fills.
//
// Env: ROCKETREACH_KEY (also accepts ROCKETREACH_API_KEY / ROCKET_REACH_KEY).
//
// EVERY LOOKUP COSTS A CREDIT, so nothing here is speculative: `account()` is free and is used to
// prove the key and read the balance before any spend, and a lookup is only ever made for a record
// that has no number at all.
const BASE = 'https://api.rocketreach.co/api/v2';

export const rrKey = () => process.env.ROCKETREACH_KEY || process.env.ROCKETREACH_API_KEY || process.env.ROCKET_REACH_KEY || '';
export const rrConfigured = () => !!rrKey();

async function call(path, { timeout = 15000 } = {}) {
    const key = rrKey();
    if (!key) return { ok: false, status: 0, error: 'ROCKETREACH_KEY not set' };
    try {
        const r = await fetch(BASE + path, {
            headers: { 'Api-Key': key, Accept: 'application/json' },
            signal: AbortSignal.timeout(timeout),
        });
        const text = await r.text();
        let body; try { body = JSON.parse(text); } catch { body = text; }
        return { ok: r.ok, status: r.status, body };
    } catch (e) { return { ok: false, status: 0, error: String((e && e.message) || e).slice(0, 120) }; }
}

/** Free. Proves the key and reports the remaining lookup allowance. Never spends a credit. */
export async function account() {
    const r = await call('/account');
    if (!r.ok) return { ok: false, error: r.error || `http ${r.status}`, status: r.status };
    const b = r.body || {};
    // The live account payload carries credit_usage and rate_limits rather than a flat balance,
    // and the shape differs by plan, so both are passed through untouched. Guessing at a single
    // "remaining" number on a metered API is how you spend more than you meant to.
    const u = b.credit_usage || {};
    return {
        ok: true,
        plan: b.plan_name || b.plan || u.plan || null,
        lookupsRemaining: u.lookup_credit_balance ?? u.remaining ?? u.credits_remaining ?? null,
        creditUsage: u,
        rateLimits: b.rate_limits || null,
        accountState: b.state || null,
    };
}

const digits = v => String(v || '').replace(/[^\d+]/g, '');

/**
 * One person, by email. Returns the numbers RocketReach holds, newest-confidence first, with the
 * vendor's own type label carried through untouched. It is NOT treated as proof of a mobile: the
 * caller runs its own carrier check, because a vendor label is a claim and a carrier answer is
 * evidence.
 *
 * `pending` means RocketReach accepted the lookup but is still working: the credit is spent and the
 * result arrives later, so that is reported rather than being mistaken for "no number".
 */
export async function lookupByEmail(email) {
    const r = await call(`/person/lookup?email=${encodeURIComponent(email)}`);
    if (!r.ok) {
        if (r.status === 404) return { found: false, reason: 'not in RocketReach' };
        if (r.status === 429) return { found: false, reason: 'rate limited', retryable: true };
        if (r.status === 401 || r.status === 403) return { found: false, reason: 'key rejected', fatal: true };
        return { found: false, reason: r.error || `http ${r.status}`, retryable: r.status >= 500 };
    }
    const b = r.body || {};
    if (b.status && /progress|searching|pending/i.test(String(b.status))) {
        return { found: false, pending: true, id: b.id || null, reason: 'RocketReach is still searching; the credit is spent and the result lands later' };
    }
    const phones = (Array.isArray(b.phones) ? b.phones : [])
        .map(p => (typeof p === 'string' ? { number: p, type: null } : p))
        .map(p => ({ number: digits(p.number || p.phone), type: p.type || p.phone_type || null, recommended: !!p.recommended }))
        .filter(p => p.number.length >= 10);
    return {
        found: !!phones.length,
        reason: phones.length ? null : 'no number on the RocketReach record',
        name: b.name || [b.first_name, b.last_name].filter(Boolean).join(' ') || null,
        title: b.current_title || b.title || null,
        employer: b.current_employer || null,
        linkedin: b.linkedin_url || null,
        phones,
    };
}
