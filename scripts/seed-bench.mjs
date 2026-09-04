// Seed the real bench in Redis from scripts/bench-seed-data.json.
//
//   KV_REST_API_URL=... KV_REST_API_TOKEN=... node scripts/seed-bench.mjs
//   node scripts/seed-bench.mjs --dry     (print what would be written)
//
// Seeded profiles are written WITHOUT consent and WITHOUT a confirmation
// timestamp, which means they land on the bench hidden. That is deliberate:
// somebody has to record consent and press Confirm in /bench/admin/ before a
// person becomes publicly visible. Seeding is not consent.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');

const seed = JSON.parse(await readFile(join(ROOT, 'scripts/bench-seed-data.json'), 'utf8'));

if (!DRY && (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN)) {
    console.error('Missing KV_REST_API_URL / KV_REST_API_TOKEN. Pull them with `vercel env pull`, or run with --dry.');
    process.exit(1);
}

// Imported lazily so --dry works in a checkout with no node_modules.
let redis = null;
if (!DRY) {
    const { Redis } = await import('@upstash/redis');
    redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

const now = Date.now();
const slugify = (first, id) =>
    `${String(first).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'candidate'}-${String(id).slice(-6)}`;

let n = 0;
for (const p of seed.profiles) {
    const id = 'bp_' + (now + n).toString(36) + randomBytes(3).toString('hex');
    const slug = slugify(p.first_name, id);
    const rec = {
        id, slug,
        first_name: p.first_name,
        last_name: '', email: '', phone: '',
        role: p.role, seniority: p.seniority, region: p.region,
        country: p.country, timezone: p.timezone,
        headline: p.headline, summary: p.summary,
        years_experience: String(p.years_experience || 0),
        skills: JSON.stringify(p.skills || []),
        tools: JSON.stringify(p.tools || []),
        languages: JSON.stringify([]),
        english_cefr: p.english_cefr || '', english_score: p.english_score || '',
        salary_min: String(p.salary_min || 0), salary_max: String(p.salary_max || 0),
        availability: 'available',
        available_from: p.available_from || 'Now',
        video_intro_url: '',
        internal_notes: seed._demo ? 'DEMO SEED — replace with a real candidate.' : '',
        assessment: JSON.stringify(p.assessment || {}),
        consent: JSON.stringify({}),      // no consent yet — stays hidden
        archived: 'false',
        last_confirmed_at: '',            // never confirmed — stays hidden
        created_at: String(now), updated_at: String(now + n),
    };

    if (DRY) {
        console.log(`${slug.padEnd(24)} ${p.role.padEnd(11)} ${p.region.padEnd(6)} $${p.salary_min}`);
    } else {
        await redis.hset(`bench:profile:${id}`, rec);
        await redis.zadd('bench:index', { score: now + n, member: id });
        await redis.set(`bench:slug:${slug}`, id);
        console.log(`seeded ${slug}`);
    }
    n++;
}

console.log(`\n${DRY ? 'Would seed' : 'Seeded'} ${n} profiles.`);
console.log('All hidden until consent is recorded and availability confirmed in /bench/admin/.');
