// Shared bench helpers: schema, redaction, availability decay.
// Files in /api starting with "_" are not routed as endpoints.
//
// The bench is a browsable roster of pre-vetted candidates. Two rules govern
// every read path and neither is negotiable:
//
//   1. REDACTION. Nothing that identifies a candidate to a stranger ever leaves
//      this file. Surname, email, phone, exact employers, resume file, and the
//      internal assessment notes stay server-side. The public payload is built
//      by an allowlist (publicProfile below), not by deleting keys from the
//      private record — a deny-list leaks the moment someone adds a field.
//
//   2. CONSENT. Under the Philippine Data Privacy Act the NPC has ruled implied
//      consent is not consent. A profile is invisible until someone recorded an
//      explicit grant, and it goes invisible again the moment it is withdrawn.
//      Colombia is stricter still. Treat consent.granted_at as load-bearing.
//
// Availability decay is the third rule and it is operational rather than legal:
// a candidate who was free in March is under contract by June. Profiles hide
// themselves after STALE_DAYS without a re-confirmation so the bench never shows
// a ghost. See confirmedState().

import { redis, newToken } from './_auth.js';

export const KEY = {
    profile: id => `bench:profile:${id}`,
    index: 'bench:index',              // zset, score = updated_at
    slug: slug => `bench:slug:${slug}`, // slug -> id
    reserves: 'bench:reserves:by_date',
};

export const STALE_DAYS = 14;          // hide after this long with no re-confirm
export const WARN_DAYS = 10;           // nudge the team before it hides

export const ROLES = {
    admin: 'Executive & Admin',
    csr: 'Customer Support',
    editor: 'Video Editor',
    bookkeeper: 'Bookkeeping',
    sdr: 'Sales Development',
    marketing: 'Marketing & Social',
    ops: 'Operations',
};

export const SENIORITY = { entry: 'Entry', mid: 'Mid', senior: 'Senior', lead: 'Lead' };
export const REGIONS = { ph: 'Philippines', latam: 'Latin America', za: 'South Africa' };
export const AVAILABILITY = { available: 'Available', reserved: 'Reserved', placed: 'Placed', paused: 'Paused' };

const DAY = 86400000;
export const now = () => Date.now();
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

export function slugify(first, id) {
    const base = clean(first, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'candidate';
    return `${base}-${String(id).slice(-6)}`;
}

export function newProfileId() {
    return 'bp_' + Date.now().toString(36) + newToken(3);
}

// Redis hashes are flat strings. Nested fields round-trip as JSON.
const JSON_FIELDS = ['skills', 'tools', 'assessment', 'consent', 'languages'];

export function serialize(p) {
    const out = {};
    for (const [k, v] of Object.entries(p)) {
        if (v === undefined || v === null) continue;
        out[k] = JSON_FIELDS.includes(k) || typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return out;
}

export function deserialize(raw) {
    if (!raw || !raw.id) return null;
    const p = { ...raw };
    for (const f of JSON_FIELDS) {
        if (typeof p[f] === 'string') { try { p[f] = JSON.parse(p[f]); } catch { p[f] = null; } }
    }
    p.skills = Array.isArray(p.skills) ? p.skills : [];
    p.tools = Array.isArray(p.tools) ? p.tools : [];
    p.languages = Array.isArray(p.languages) ? p.languages : [];
    p.assessment = p.assessment && typeof p.assessment === 'object' ? p.assessment : {};
    p.consent = p.consent && typeof p.consent === 'object' ? p.consent : {};
    p.years_experience = num(p.years_experience);
    p.salary_min = num(p.salary_min);
    p.salary_max = num(p.salary_max);
    return p;
}

// Has this candidate given a live, un-withdrawn consent to be listed publicly?
export function consentValid(p) {
    const c = p.consent || {};
    return Boolean(c.granted_at) && !c.withdrawn_at;
}

// Freshness. Returns the state plus the age in days so the admin view can show
// a countdown instead of a binary.
export function confirmedState(p) {
    const last = num(p.last_confirmed_at);
    if (!last) return { state: 'never', days: null, visible: false };
    const days = Math.floor((now() - last) / DAY);
    if (days >= STALE_DAYS) return { state: 'stale', days, visible: false };
    if (days >= WARN_DAYS) return { state: 'aging', days, visible: true };
    return { state: 'fresh', days, visible: true };
}

// The single gate every public read goes through.
export function isPubliclyVisible(p) {
    if (!p || p.archived === 'true' || p.archived === true) return false;
    if (p.availability !== 'available') return false;
    if (!consentValid(p)) return false;
    return confirmedState(p).visible;
}

// ---------------------------------------------------------------------------
// The allowlist. Anything not named here never reaches a browser.
// ---------------------------------------------------------------------------
export function publicProfile(p) {
    const conf = confirmedState(p);
    return {
        slug: p.slug,
        first_name: p.first_name,
        role: p.role,
        role_label: ROLES[p.role] || p.role,
        seniority: p.seniority,
        seniority_label: SENIORITY[p.seniority] || p.seniority,
        region: p.region,
        region_label: REGIONS[p.region] || p.region,
        country: p.country,
        timezone: p.timezone,
        headline: p.headline,
        summary: p.summary,
        years_experience: p.years_experience,
        skills: p.skills,
        tools: p.tools,
        languages: p.languages,
        english_cefr: p.english_cefr,
        english_score: p.english_score,
        salary_min: p.salary_min,
        salary_max: p.salary_max,
        available_from: p.available_from,
        video_intro_url: p.video_intro_url || '',
        // Assessment is surfaced as verified booleans and scores only. No notes,
        // no reviewer names, no raw test output.
        verified: {
            english_test: Boolean(p.assessment?.english_test),
            skills_test: Boolean(p.assessment?.skills_test),
            reference_check: Boolean(p.assessment?.reference_check),
            id_verified: Boolean(p.assessment?.id_verified),
            video_intro: Boolean(p.video_intro_url),
        },
        skills_score: p.assessment?.skills_score ? num(p.assessment.skills_score) : null,
        confirmed_days_ago: conf.days,
    };
}

export async function getProfileById(id) {
    const raw = await redis.hgetall(KEY.profile(id));
    return deserialize(raw);
}

export async function getProfileBySlug(slug) {
    const id = await redis.get(KEY.slug(slug));
    return id ? getProfileById(id) : null;
}

// Reads the whole bench. Fine at bench scale (hundreds, not millions) and it
// keeps filtering honest: every filter runs against the same visibility gate.
export async function allProfiles() {
    const ids = await redis.zrange(KEY.index, 0, -1, { rev: true });
    if (!ids || !ids.length) return [];
    const rows = await Promise.all(ids.map(id => redis.hgetall(KEY.profile(id))));
    return rows.map(deserialize).filter(Boolean);
}
