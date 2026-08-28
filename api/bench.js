// GET /api/bench            -> every publicly visible profile, redacted
// GET /api/bench?slug=abc   -> one profile, redacted
//
// Public and unauthenticated by design: browsing the bench is the whole point.
// Every record passes through isPubliclyVisible() and then publicProfile(),
// which is an allowlist. See _bench.js for why both exist.

import { allProfiles, getProfileBySlug, isPubliclyVisible, publicProfile, ROLES, REGIONS, SENIORITY } from './_bench.js';

const ALLOWED_ORIGINS = [
    'https://www.gostaffify.com',
    'https://gostaffify.com',
    'http://localhost:3000',
    'http://localhost:8899',
];

function cors(req, res) {
    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
}

export default async function handler(req, res) {
    cors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    // Short cache: the bench changes when someone is reserved, and a stale card
    // that says "available" is the failure mode we care most about avoiding.
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=120');

    const slug = (req.query?.slug || '').toString().trim();

    try {
        if (slug) {
            const p = await getProfileBySlug(slug);
            if (!p || !isPubliclyVisible(p)) return res.status(404).json({ error: 'not_found' });
            return res.status(200).json({ profile: publicProfile(p) });
        }

        const profiles = (await allProfiles()).filter(isPubliclyVisible).map(publicProfile);

        // Facets are computed from what is actually on the bench right now, so
        // the filter rail never offers a role with zero people behind it.
        const facet = (key) => {
            const counts = {};
            for (const p of profiles) if (p[key]) counts[p[key]] = (counts[p[key]] || 0) + 1;
            return counts;
        };

        return res.status(200).json({
            count: profiles.length,
            profiles,
            facets: {
                role: facet('role'),
                region: facet('region'),
                seniority: facet('seniority'),
            },
            labels: { roles: ROLES, regions: REGIONS, seniority: SENIORITY },
        });
    } catch (e) {
        return res.status(500).json({ error: 'read_failed' });
    }
}
