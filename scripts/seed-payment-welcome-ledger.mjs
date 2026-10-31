#!/usr/bin/env node
// Seed the cloud payment welcome ledger from the Mac, so going live never re-sends to anyone the Mac
// already welcomed. Run it on the Mac, by hand, once before PAYMENT_WELCOME_SEND is turned on.
//
//   node scripts/seed-payment-welcome-ledger.mjs <staffify-email-log.jsonl> \
//        [--suppression <staffify-suppression-list.txt>] [--substring <text>]... [--post] [--url <endpoint>]
//
// Without --post it only prints what it would send: counts and the first characters of each hash.
// With --post it sends ONE request to the owner-only import action of /api/payment-welcome/, with the
// token from PAYMENT_WELCOME_TOKEN (or ADMIN_TOKEN) in the environment.
//
// What leaves the Mac: sha256(lowercased, trimmed email) for every non-dry "welcome-strategy-call"
// row in the log (the desktop's own dedupe rule counts a failed send as welcomed, so this does too),
// the send time, and the same hashes for the suppression list (an @domain line is hashed as
// "@domain"). No address, name or amount. --substring passes a text rule as typed (the desktop
// job also skips any address containing a hard-coded name); it is stored in Redis, never in the repo.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { emailHash, WELCOME_KIND } from '../api/_welcome-ledger.js';

/** The dedupe keys in a staffify-email-log.jsonl, one per person, plus counts. */
export function parseLog(text) {
    const keys = [];
    const counts = { rows: 0, dry: 0, unreadable: 0, failed: 0 };
    for (const line of String(text).split('\n')) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { counts.unreadable++; continue; }
        if (!e || e.type !== WELCOME_KIND) continue;
        counts.rows++;
        if (e.dry) { counts.dry++; continue; } // a dry run is not a send
        if (!e.to) { counts.unreadable++; continue; }
        if (e.ok === false) counts.failed++;
        keys.push({ kind: WELCOME_KIND, hash: emailHash(e.to), at: typeof e.ts === 'string' ? e.ts : null, ok: e.ok !== false });
    }
    return { keys: [...new Map(keys.map(k => [k.hash, k])).values()], counts };
}

/** The desktop suppression list as hashes: full emails, and @domain lines hashed with their @. */
export function parseSuppression(text) {
    const out = [];
    for (const raw of String(text).split('\n')) {
        const line = raw.trim().toLowerCase();
        if (!line || line.startsWith('#')) continue;
        out.push(emailHash(line));
    }
    return [...new Set(out)];
}

async function main(args) {
    const flag = name => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : null; };
    const all = name => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
    const logPath = args[0] && !args[0].startsWith('--') ? args[0] : null;
    if (!logPath) { console.error('Usage: node scripts/seed-payment-welcome-ledger.mjs <staffify-email-log.jsonl> [--suppression <file>] [--substring <text>] [--post]'); return 1; }
    const url = flag('--url') || 'https://www.gostaffify.com/api/payment-welcome/';
    const { keys, counts } = parseLog(fs.readFileSync(logPath, 'utf8'));
    const supPath = flag('--suppression');
    const suppressed = supPath ? parseSuppression(fs.readFileSync(supPath, 'utf8')) : [];
    const substrings = all('--substring');

    console.log(`welcome rows: ${counts.rows} (dry runs skipped: ${counts.dry}, unreadable: ${counts.unreadable}, failed sends kept as welcomed: ${counts.failed})`);
    console.log(`unique welcomed keys: ${keys.length}`);
    for (const k of keys) console.log(`  ${k.kind}  ${k.hash.slice(0, 10)}...  ${k.at || 'no time'}${k.ok ? '' : '  (send failed on the Mac)'}`);
    console.log(`suppression hashes: ${suppressed.length}, text rules: ${substrings.length}`);

    if (!args.includes('--post')) { console.log('\nNothing sent. Add --post to import these keys.'); return 0; }
    const token = process.env.PAYMENT_WELCOME_TOKEN || process.env.ADMIN_TOKEN;
    if (!token) { console.error('Set PAYMENT_WELCOME_TOKEN (or ADMIN_TOKEN) to an owner token first.'); return 1; }
    const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', source: 'desktop-log', keys, suppressed, substrings }),
    });
    const body = await r.json().catch(() => ({}));
    console.log(`\nimport ${r.status}:`, JSON.stringify(body));
    return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e.message || e); process.exit(1); });
}
