#!/usr/bin/env node
// Seed the cloud pre-call ledger from the Mac's sent log, so going live never re-sends to anyone the
// desktop job already emailed. Live mode refuses until this has been posted (precall:seeded).
//
//   node scripts/seed-precall-ledger.mjs "/Users/paulchareth/Claude Code/staffify-precall-log.jsonl"
//       reads the log and prints what it would import: counts and the newest time only, no addresses
//   ADMIN_TOKEN=... node scripts/seed-precall-ledger.mjs <log.jsonl> --post [--base https://www.gostaffify.com]
//       posts it to /api/cron-precall/?action=import
//
// What leaves the Mac per log line: the address's sha256 (32 hex, the same hash the client snapshot
// uses), the email number (1 or 2), when it went, its role, and whether it counted as sent. No address,
// no name, no booking answer. The time and role are there because email #2 is timed from email #1 and
// takes its role; ok:false (a hold or a failed send) blocks both emails, as it does on the Mac.
// The import never overwrites an entry the cloud already has, so running it twice is safe.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const hash = e => createHash('sha256').update(String(e || '').trim().toLowerCase()).digest('hex').slice(0, 32);
const EPOCH = new Date(0).toISOString();

/**
 * The ledger entries for a log's lines, read the way the desktop reads them: an entry with no stage is
 * email #1, and the first entry for a person and email wins. Two differences, both on the side of
 * sending less: a hand-written line with its quotes escaped (\") is read after unescaping them, since
 * that person was emailed even though the Mac cannot parse the line; and an entry whose time cannot be
 * read is imported as a hold at the epoch, because the Mac counts it as sent and never sends #2 after it.
 */
export function ledgerEntries(lines) {
    const out = new Map();
    let unreadable = 0, noAddress = 0, recovered = 0, untimed = 0;
    for (const line of lines) {
        if (!String(line).trim()) continue;
        let e;
        try { e = JSON.parse(line); }
        catch {
            try { e = JSON.parse(String(line).replace(/\\"/g, '"')); recovered++; }
            catch { unreadable++; continue; }
        }
        if (!e || !e.to) { noAddress++; continue; }
        const stage = Number(e.stage || 1);
        if (stage !== 1 && stage !== 2) continue;
        const key = hash(e.to);
        const id = key + ':' + stage;
        if (out.has(id)) continue;
        const role = /^[a-z]{1,16}$/.test(String(e.role || '')) ? e.role : null;
        const t = Date.parse(e.ts);
        if (Number.isFinite(t)) out.set(id, { key, stage, ts: new Date(t).toISOString(), role, ok: e.ok !== false });
        else { untimed++; out.set(id, { key, stage, ts: EPOCH, role, ok: false }); }
    }
    const entries = [...out.values()];
    const times = entries.map(x => Date.parse(x.ts)).filter(t => t > 0);
    return { entries, unreadable, noAddress, recovered, untimed, latestTs: times.length ? new Date(Math.max(...times)).toISOString() : null };
}

async function main(argv) {
    const file = argv.find(a => !a.startsWith('--') && !/^https?:/.test(a));
    if (!file) { console.error('Usage: node scripts/seed-precall-ledger.mjs <staffify-precall-log.jsonl> [--post] [--base <url>]'); process.exit(1); }
    const { entries, unreadable, noAddress, recovered, untimed, latestTs } = ledgerEntries(fs.readFileSync(file, 'utf8').split('\n'));
    const by = s => entries.filter(e => e.stage === s);
    console.log(`entries: ${entries.length} (email #1: ${by(1).length}, email #2: ${by(2).length}, held or failed: ${entries.filter(e => !e.ok).length}); newest: ${latestTs || 'none'}`);
    console.log(`lines: ${recovered} read after unescaping quotes, ${untimed} with no readable time (imported as holds), ${unreadable} unreadable, ${noAddress} without an address`);
    if (!argv.includes('--post')) { console.log('read only. Add --post to import them.'); return; }

    const token = process.env.ADMIN_TOKEN || process.env.CRON_SECRET || process.env.HUB_TOKEN;
    if (!token) { console.log('no ADMIN_TOKEN in the environment, so nothing was posted'); process.exit(1); }
    const i = argv.indexOf('--base');
    const base = (i >= 0 && argv[i + 1]) || 'https://www.gostaffify.com';
    const r = await fetch(`${base.replace(/\/$/, '')}/api/cron-precall/?action=import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ entries }),
    });
    console.log('import:', r.status, (await r.text()).slice(0, 600));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main(process.argv.slice(2));
