// Admin bench management. Requires ADMIN_TOKEN / CRON_SECRET / HUB_TOKEN.
//
//   GET  /api/bench-admin                 -> every profile incl. hidden, with freshness state
//   POST /api/bench-admin  {action:'upsert', profile:{...}}
//   POST /api/bench-admin  {action:'confirm', id}          -> resets the decay clock
//   POST /api/bench-admin  {action:'availability', id, availability}
//   POST /api/bench-admin  {action:'consent', id, granted:true|false, method}
//   POST /api/bench-admin  {action:'archive', id}
//
// Consent is deliberately its own action rather than a field on upsert. Recording
// who consented, when, and by what method is the evidence the Philippine NPC and
// Colombia's SIC expect to see, and burying it in a bulk edit is how it gets lost.

import { redis, readBody, adminAuthorized } from './_auth.js';
import {
    KEY, ROLES, REGIONS, SENIORITY, AVAILABILITY, STALE_DAYS,
    serialize, deserialize, allProfiles, getProfileById,
    confirmedState, consentValid, isPubliclyVisible,
    newProfileId, slugify, clean, now,
} from './_bench.js';

const numOr = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

function normalizeProfile(body, existing) {
    const id = existing?.id || newProfileId();
    const first = clean(body.first_name, 40) || existing?.first_name || '';
    const p = {
        id,
        slug: existing?.slug || slugify(first, id),
        first_name: first,
        // Surname is stored so the team can identify the person internally. It is
        // not in the public allowlist and must never be added to it.
        last_name: clean(body.last_name ?? existing?.last_name, 60),
        email: clean(body.email ?? existing?.email, 254).toLowerCase(),
        phone: clean(body.phone ?? existing?.phone, 40),

        role: ROLES[body.role] ? body.role : (existing?.role || 'admin'),
        seniority: SENIORITY[body.seniority] ? body.seniority : (existing?.seniority || 'mid'),
        region: REGIONS[body.region] ? body.region : (existing?.region || 'ph'),
        country: clean(body.country ?? existing?.country, 60),
        timezone: clean(body.timezone ?? existing?.timezone, 40),

        headline: clean(body.headline ?? existing?.headline, 120),
        summary: clean(body.summary ?? existing?.summary, 900),
        years_experience: numOr(body.years_experience ?? existing?.years_experience),

        skills: Array.isArray(body.skills) ? body.skills.slice(0, 20).map(s => clean(s, 40)) : (existing?.skills || []),
        tools: Array.isArray(body.tools) ? body.tools.slice(0, 20).map(s => clean(s, 40)) : (existing?.tools || []),
        languages: Array.isArray(body.languages) ? body.languages.slice(0, 8).map(s => clean(s, 30)) : (existing?.languages || []),

        english_cefr: clean(body.english_cefr ?? existing?.english_cefr, 4),
        english_score: clean(body.english_score ?? existing?.english_score, 6),

        salary_min: numOr(body.salary_min ?? existing?.salary_min),
        salary_max: numOr(body.salary_max ?? existing?.salary_max),

        availability: AVAILABILITY[body.availability] ? body.availability : (existing?.availability || 'available'),
        available_from: clean(body.available_from ?? existing?.available_from, 20),

        video_intro_url: clean(body.video_intro_url ?? existing?.video_intro_url, 300),
        internal_notes: clean(body.internal_notes ?? existing?.internal_notes, 2000),

        assessment: (body.assessment && typeof body.assessment === 'object')
            ? body.assessment : (existing?.assessment || {}),
        consent: existing?.consent || {},

        archived: existing?.archived === 'true' || existing?.archived === true ? 'true' : 'false',
        // A new profile starts unconfirmed on purpose. Someone has to say out loud
        // that this person is available before the bench will show them.
        last_confirmed_at: existing?.last_confirmed_at || '',
        created_at: existing?.created_at || String(now()),
        updated_at: String(now()),
    };
    return p;
}

async function save(p) {
    await redis.hset(KEY.profile(p.id), serialize(p));
    await redis.zadd(KEY.index, { score: Number(p.updated_at), member: p.id });
    await redis.set(KEY.slug(p.slug), p.id);
    return p;
}

export default async function handler(req, res) {
    if (!adminAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'GET') {
        const profiles = await allProfiles();
        const rows = profiles.map(p => {
            const conf = confirmedState(p);
            return {
                id: p.id, slug: p.slug,
                name: [p.first_name, p.last_name].filter(Boolean).join(' '),
                role: p.role, seniority: p.seniority, region: p.region,
                headline: p.headline,
                salary_min: p.salary_min, salary_max: p.salary_max,
                availability: p.availability,
                archived: p.archived === 'true' || p.archived === true,
                consent_ok: consentValid(p),
                consent_granted_at: p.consent?.granted_at || '',
                confirm_state: conf.state, confirm_days: conf.days,
                live: isPubliclyVisible(p),
            };
        });
        const summary = {
            total: rows.length,
            live: rows.filter(r => r.live).length,
            stale: rows.filter(r => r.confirm_state === 'stale').length,
            aging: rows.filter(r => r.confirm_state === 'aging').length,
            never: rows.filter(r => r.confirm_state === 'never').length,
            no_consent: rows.filter(r => !r.consent_ok && !r.archived).length,
            stale_days: STALE_DAYS,
        };
        return res.status(200).json({ summary, rows });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    const b = readBody(req) || {};
    const action = clean(b.action, 24);

    try {
        if (action === 'upsert') {
            const body = b.profile || {};
            const existing = body.id ? await getProfileById(clean(body.id, 40)) : null;
            if (!clean(body.first_name, 40) && !existing) {
                return res.status(400).json({ error: 'first_name_required' });
            }
            const p = await save(normalizeProfile(body, existing));
            return res.status(200).json({ ok: true, id: p.id, slug: p.slug });
        }

        const id = clean(b.id, 40);
        if (!id) return res.status(400).json({ error: 'id_required' });
        const p = await getProfileById(id);
        if (!p) return res.status(404).json({ error: 'not_found' });

        if (action === 'confirm') {
            p.last_confirmed_at = String(now());
            p.updated_at = String(now());
            await save(p);
            return res.status(200).json({ ok: true, confirmed_at: p.last_confirmed_at });
        }

        if (action === 'availability') {
            if (!AVAILABILITY[b.availability]) return res.status(400).json({ error: 'bad_availability' });
            p.availability = b.availability;
            // Marking someone available is itself a confirmation that they are.
            if (b.availability === 'available') p.last_confirmed_at = String(now());
            p.updated_at = String(now());
            await save(p);
            return res.status(200).json({ ok: true, availability: p.availability });
        }

        if (action === 'consent') {
            const granted = b.granted !== false;
            p.consent = granted
                ? {
                    granted_at: String(now()),
                    method: clean(b.method, 60) || 'written',
                    recorded_by: clean(b.recorded_by, 80) || 'admin',
                    scope: 'public_listing_redacted',
                    withdrawn_at: '',
                }
                : { ...(p.consent || {}), withdrawn_at: String(now()) };
            p.updated_at = String(now());
            await save(p);
            return res.status(200).json({ ok: true, consent: p.consent });
        }

        if (action === 'archive') {
            p.archived = 'true';
            p.availability = 'paused';
            p.updated_at = String(now());
            await save(p);
            return res.status(200).json({ ok: true });
        }

        return res.status(400).json({ error: 'unknown_action' });
    } catch (e) {
        return res.status(500).json({ error: 'write_failed' });
    }
}
