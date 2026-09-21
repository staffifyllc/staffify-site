#!/usr/bin/env node
// Refresh the shared client list and push it to gostaffify.com, hashed.
//
//   ADMIN_TOKEN=... node scripts/push-client-snapshot.mjs [--write-file]
//
// --write-file also updates api/_client-snapshot.json, the copy that ships with the code.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { loadClients, refresh } = require('/Users/paulchareth/Claude Code/staffify-client-guard.js');
const h = (v) => createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex').slice(0, 32);

const { customers, roster } = await refresh();
const g = loadClients({ quiet: true });
const csv = Math.max(0, g.emails.size - customers.length - roster.length);
const doc = {
    ts: new Date().toISOString(), algo: 'sha256-32',
    emails: [...g.emails].map(h), companies: [...g.companies].map(h),
    sources: [
        { source: 'hubspot-customers', count: customers.length },
        { source: 'talent-console-roster', count: roster.length },
        { source: 'active-clients-csv', count: csv },
    ],
    counts: { emails: g.emails.size, companies: g.companies.size },
};
console.log(`union: ${doc.counts.emails} emails, ${doc.counts.companies} companies`);
console.log('sources:', doc.sources.map((s) => `${s.source}=${s.count}`).join(' '));

if (process.argv.includes('--write-file')) {
    fs.writeFileSync(new URL('../api/_client-snapshot.json', import.meta.url), JSON.stringify(doc));
    console.log('wrote api/_client-snapshot.json. Commit and deploy to ship it.');
}

const token = process.env.ADMIN_TOKEN || process.env.CRON_SECRET || process.env.HUB_TOKEN;
if (!token) { console.log('no ADMIN_TOKEN in the environment, so nothing was pushed'); process.exit(0); }
const r = await fetch('https://www.gostaffify.com/api/client-snapshot/', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(doc),
});
console.log('push:', r.status, (await r.text()).slice(0, 300));
