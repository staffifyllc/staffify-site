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

async function call(path, { timeout = 15000, method = 'GET', payload = undefined } = {}) {
    const key = rrKey();
    if (!key) return { ok: false, status: 0, error: 'ROCKETREACH_KEY not set' };
    try {
        const r = await fetch(BASE + path, {
            method,
            headers: { 'Api-Key': key, Accept: 'application/json', ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            body: payload !== undefined ? JSON.stringify(payload) : undefined,
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

/**
 * Collect lookups that came back as "searching". RocketReach charges the credit at request time
 * and resolves asynchronously, so without this the money is spent and the answer thrown away.
 * checkStatus is free: it reads results already paid for and never starts a new search.
 */
export async function checkStatus(ids) {
    const list = [...new Set((ids || []).filter(Boolean))].slice(0, 100);
    if (!list.length) return {};
    const r = await call(`/person/checkStatus?ids=${list.join(',')}`);
    if (!r.ok) return {};
    const rows = Array.isArray(r.body) ? r.body : (Array.isArray(r.body?.profiles) ? r.body.profiles : []);
    const out = {};
    for (const b of rows) {
        if (!b || b.id == null) continue;
        // Finished only when RocketReach says so: 'waiting' and 'not queued' are still on the way.
        const done = !b.status || /^(complete|failed)$/i.test(String(b.status));
        const phones = (Array.isArray(b.phones) ? b.phones : [])
            .map(p => (typeof p === 'string' ? { number: p, type: null } : p))
            .map(p => ({ number: digits(p.number || p.phone), type: p.type || p.phone_type || null, recommended: !!p.recommended }))
            .filter(p => p.number.length >= 10);
        out[String(b.id)] = {
            done, found: done && !!phones.length, phones,
            name: b.name || null, title: b.current_title || b.title || null,
            profile: profileOf(b),
        };
    }
    return out;
}

/** A profile as the Hub keeps it: who, where, the employer and its domain, and each number with RocketReach's own type and grade. */
export function profileOf(b) {
    const phones = (Array.isArray(b && b.phones) ? b.phones : [])
        .map(p => (typeof p === 'string' ? { number: p } : p))
        .map(p => ({ number: digits(p.e164 || p.number || p.phone), type: p.type || p.phone_type || null, grade: p.grade || null, valid: p.validity ? p.validity === 'valid' : null, recommended: !!p.recommended }))
        .filter(p => p.number.replace(/\D/g, '').length >= 10);
    // The person's addresses with RocketReach's own mail check ('valid': their server accepted it; 'accept-all': the
    // domain takes any address) and its grade. Only a valid, A-graded one is ever put on a card (_hiring-run.js ownerEmail).
    const emails = (Array.isArray(b && b.emails) ? b.emails : [])
        .map(e => (typeof e === 'string' ? { email: e } : e || {}))
        .map(e => ({ email: String(e.email || '').trim().toLowerCase(), type: e.type || null, grade: e.grade || null, smtp: e.smtp_valid || null }))
        .filter(e => /^[^\s@<>()",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e.email));
    return {
        id: b && b.id || null, name: b && (b.name || [b.first_name, b.last_name].filter(Boolean).join(' ')) || null, title: b && (b.current_title || b.title) || null,
        employer: b && b.current_employer || null, employerDomain: b && b.current_employer_domain || null,
        location: b && b.location || null, region: String(b && b.region || '').trim() || null, linkedin: b && b.linkedin_url || null, phones, emails,
    };
}

/**
 * One person by RocketReach profile id, or by name at an employer, as a premium lookup (the one that
 * carries phone numbers). A lookup that finds nobody costs nothing; one that finds someone spends a
 * credit even when RocketReach is still "searching" (`pending`), so that id is kept and collected
 * later with checkStatus, which is free.
 */
export async function lookupPerson({ id, name, employer } = {}) {
    const q = id ? `id=${encodeURIComponent(id)}` : name && employer ? `name=${encodeURIComponent(name)}&current_employer=${encodeURIComponent(employer)}` : null;
    if (!q) return { found: false, reason: 'no id or name' };
    const r = await call(`/person/lookup?${q}&lookup_type=premium`);
    if (!r.ok) {
        if (r.status === 404) return { found: false, reason: 'not in RocketReach' };
        if (r.status === 429) return { found: false, reason: 'rate limited', retryable: true };
        if (r.status === 401 || r.status === 403) return { found: false, reason: 'key rejected', fatal: true };
        return { found: false, reason: r.error || `http ${r.status}`, retryable: r.status >= 500 || r.status === 0 };
    }
    const b = r.body || {};
    // Finished only when RocketReach says complete or failed (the same rule as checkStatus): anything else is on its way.
    if (b.status && !/^(complete|failed)$/i.test(String(b.status))) return { found: false, pending: true, id: b.id || null, profile: profileOf(b), reason: 'RocketReach is still searching; the credit is spent and the result lands later' };
    const profile = profileOf(b);
    return { found: !!profile.phones.length, profile, reason: profile.phones.length ? null : 'no number on the RocketReach record' };
}

/** Company names as RocketReach spells them, for a loose match: "McKinstry Co." ~ "mckinstry". */
const norm = s => String(s || '').toLowerCase().replace(/\b(inc|llc|ltd|co|corp|corporation|company|group|holdings|the)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const sameCompany = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x) || x.includes(y) || y.includes(x)); };

/**
 * Who works at a company, by title. POST /api/v2/person/search returns profiles WITHOUT contact
 * data (name, current_title, current_employer, linkedin_url) and the docs reserve credits for the
 * lookup call, so this is the question to ask about a shared inbox. Profiles from a different
 * employer with a similar name are dropped rather than passed off as the company's people.
 * @returns {{profiles:object[], retryable?:boolean, reason?:string}}
 */
export async function searchPeople({ company, titles = ['CEO', 'Chief Executive Officer', 'Owner', 'Founder', 'Co-Founder', 'President', 'Managing Director', 'Principal', 'COO', 'General Manager'], size = 10 } = {}) {
    const name = String(company || '').trim();
    if (!name) return { profiles: [], reason: 'no company' };
    const r = await call('/person/search', { method: 'POST', payload: { query: { company_name: [name], current_title: titles }, start: 1, page_size: size, order_by: 'relevance' } });
    if (!r.ok) {
        if (r.status === 429) return { profiles: [], retryable: true, reason: 'rate limited' };
        if (r.status === 401 || r.status === 403) return { profiles: [], reason: 'key rejected', fatal: true };
        if (r.status >= 500 || r.status === 0) return { profiles: [], retryable: true, reason: r.error || ('http ' + r.status) };
        return { profiles: [], reason: r.error || ('http ' + r.status) };
    }
    const body = r.body;
    const list = Array.isArray(body) ? body : Array.isArray(body && body.profiles) ? body.profiles : Array.isArray(body && body.results) ? body.results : [];
    const profiles = list.filter(p => p && p.name && (!p.current_employer || sameCompany(p.current_employer, name))).map(p => ({
        id: p.id || null, name: p.name, current_title: p.current_title || p.title || null, current_employer: p.current_employer || null, linkedin_url: p.linkedin_url || null, location: p.location || null }));
    return { profiles, total: list.length };
}
