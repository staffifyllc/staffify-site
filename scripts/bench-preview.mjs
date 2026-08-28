// Local preview of the bench — no Redis, no deploy, no Vercel.
//
//   node scripts/bench-preview.mjs
//   open http://localhost:8899/bench/
//
// Serves the real /bench/ page against a fake /api/bench built from
// scripts/bench-seed-data.json, so the browse experience can be reviewed and
// changed before anything touches production. Reserve posts are logged to the
// terminal instead of hitting Redis or Slack.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 8899;

const ROLES = { admin: 'Executive & Admin', csr: 'Customer Support', editor: 'Video Editor', bookkeeper: 'Bookkeeping', sdr: 'Sales Development', marketing: 'Marketing & Social', ops: 'Operations' };
const SENIORITY = { entry: 'Entry', mid: 'Mid', senior: 'Senior', lead: 'Lead' };
const REGIONS = { ph: 'Philippines', latam: 'Latin America', za: 'South Africa' };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

const seed = JSON.parse(await readFile(join(ROOT, 'scripts/bench-seed-data.json'), 'utf8'));

// Mirrors publicProfile() in api/_bench.js. Spread across a couple of days of
// "last confirmed" so the freshness badge and the aging state are both visible.
const profiles = seed.profiles.map((p, i) => ({
    slug: `${p.first_name.toLowerCase()}-${String(i).padStart(3, '0')}`,
    first_name: p.first_name,
    role: p.role, role_label: ROLES[p.role] || p.role,
    seniority: p.seniority, seniority_label: SENIORITY[p.seniority] || p.seniority,
    region: p.region, region_label: REGIONS[p.region] || p.region,
    country: p.country, timezone: p.timezone,
    headline: p.headline, summary: p.summary,
    years_experience: p.years_experience,
    skills: p.skills || [], tools: p.tools || [], languages: [],
    english_cefr: p.english_cefr, english_score: p.english_score,
    salary_min: p.salary_min, salary_max: p.salary_max,
    available_from: p.available_from,
    video_intro_url: '',
    verified: {
        english_test: !!p.assessment?.english_test,
        skills_test: !!p.assessment?.skills_test,
        reference_check: !!p.assessment?.reference_check,
        id_verified: !!p.assessment?.id_verified,
        video_intro: false,
    },
    skills_score: p.assessment?.skills_score || null,
    confirmed_days_ago: i % 13,
}));

const facet = key => profiles.reduce((a, p) => (p[key] && (a[p[key]] = (a[p[key]] || 0) + 1), a), {});

const send = (res, code, body, type) => {
    res.writeHead(code, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
};

createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    if (path === '/api/bench') {
        const slug = url.searchParams.get('slug');
        if (slug) {
            const p = profiles.find(x => x.slug === slug);
            return p ? send(res, 200, JSON.stringify({ profile: p })) : send(res, 404, '{"error":"not_found"}');
        }
        return send(res, 200, JSON.stringify({
            count: profiles.length, profiles,
            facets: { role: facet('role'), region: facet('region'), seniority: facet('seniority') },
            labels: { roles: ROLES, regions: REGIONS, seniority: SENIORITY },
        }));
    }

    if (path === '/api/bench-reserve') {
        let raw = '';
        for await (const c of req) raw += c;
        console.log('\n  RESERVE →', raw, '\n');
        return send(res, 200, '{"ok":true}');
    }

    // Static: /bench/ -> bench/index.html
    let file = path.endsWith('/') ? join(path, 'index.html') : path;
    try {
        const buf = await readFile(join(ROOT, file));
        return send(res, 200, buf, MIME[extname(file)] || 'application/octet-stream');
    } catch {
        return send(res, 404, 'Not found', 'text/plain');
    }
}).listen(PORT, () => {
    console.log(`\n  Bench preview  →  http://localhost:${PORT}/bench/`);
    console.log(`  ${profiles.length} demo profiles. No Redis, no Slack, nothing live.\n`);
});
