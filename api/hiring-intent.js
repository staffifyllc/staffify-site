// Hiring now: the cloud run, the seed list and the owner's status view.
// ------------------------------------------------------------------
//   GET  (cron, Bearer CRON_SECRET)          one run: re-check ready cards, work the pending queue and
//                                            due research, then discovery. ?discover=0
//                                            skips the paid search; ?searches= and ?candidates= cap it.
//   GET  ?view=status (owner)                counts, the research backlog, the last runs, credits
//   GET  ?view=records (owner)               every card with its evidence, for read-back
//   POST {action:'seed', urls:[...]}         owner or machine: official job URLs to qualify next run
// Logic lives in api/_hiring-intent.js and api/_hiring-run.js; this file only wires the real
// services in. Nothing here dials, texts or emails anyone.
import { randomUUID } from 'node:crypto';
import { redis, requireAccess, adminAuthorized, readBody, SITE } from './_auth.js';
import { ownerFor, KEY } from './_outreach-queue.js';
import { site } from './_outreach-supply.js';
import { findSitePhone } from './_site-phone.js';
import { verifyEmail } from './_outreach-verification.js';
import { isOptedOut } from './_optout.js';
import { clientCheck } from './_client-guard.js';
import { contact as crmContact } from './_outreach-crm.js';
import { crmStop } from './_rep-email-gates.js';
import { loadBad, isBad } from './_bad-numbers.js';
import { HK, HIRING_ID, parseAts, allRecords, allBacklog, parseValue, hiringCallReady } from './_hiring-intent.js';
import { runHiring, addPending } from './_hiring-run.js';

const FREE = /^(gmail|yahoo|hotmail|outlook|aol|icloud|me|live|msn|proton|protonmail)\./i;
async function getJson(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'staffify-hub/1.0' }, signal: AbortSignal.timeout(15000) });
    let body = null; try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
}
async function getPage(url) {
    const p = await site(url);
    if (!p) return null;
    const title = (String(p.html || '').match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    return { ...p, title };
}
async function serpAccount() {
    const r = await fetch('https://serpapi.com/account.json?api_key=' + encodeURIComponent(process.env.SERPAPI_KEY || ''), { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (!r.ok || j.error) throw Error('SerpApi account unavailable (' + r.status + ')');
    return { left: Number(j.total_searches_left ?? j.plan_searches_left), plan: j.plan_name || null, perMonth: j.searches_per_month ?? null, thisMonth: j.this_month_usage ?? null };
}
async function serpSearch(q) {
    const u = 'https://serpapi.com/search.json?engine=google&hl=en&gl=us&num=10&tbs=qdr:w&q=' + encodeURIComponent(q) + '&api_key=' + encodeURIComponent(process.env.SERPAPI_KEY || '');
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    if (!r.ok || (j.error && !/hasn't returned any results/i.test(j.error))) throw Error('SerpApi search failed (' + r.status + ')');
    return { links: (j.organic_results || []).map(x => x.link).filter(Boolean) };
}
const fmHeaders = () => ({ Authorization: 'Bearer ' + process.env.FINDYMAIL_KEY, 'Content-Type': 'application/json', Accept: 'application/json' });
async function findymailCredits() {
    if (!process.env.FINDYMAIL_KEY) throw Error('Findymail connection missing');
    const r = await fetch('https://app.findymail.com/api/credits', { headers: fmHeaders(), signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (!r.ok) throw Error('Findymail credits unavailable (' + r.status + ')');
    return { credits: Number(j.credits), verifierCredits: Number(j.verifier_credits ?? j.verifierCredits ?? NaN) };
}
// One Findymail domain search per company domain, remembered 30 days (a miss too), so a company is
// never paid for twice. At most three roles: the API answers 422 to more (memory: Findymail 3-role cap).
async function findContact(domain) {
    const key = HK.contact(domain);
    const saved = parseValue(await redis.get(key));
    if (saved && Date.parse(saved.expiresAt) > Date.now()) return saved.contact || {};
    if (!await redis.set(key + ':attempt', '1', { nx: true, ex: 900 })) return { error: 'A lookup for this domain is already running or cooling down' };
    const r = await fetch('https://app.findymail.com/api/search/domain', { method: 'POST', headers: fmHeaders(), body: JSON.stringify({ domain, roles: ['owner', 'operations', 'hr'] }), signal: AbortSignal.timeout(30000) });
    let j = null; try { j = await r.json(); } catch { j = null; }
    if (!r.ok) return { error: 'Findymail domain search answered ' + r.status + (j && j.message ? ': ' + String(j.message).slice(0, 80) : '') };
    const c = ((j && (j.contacts || j.emails)) || []).find(x => x && x.email && String(x.email).toLowerCase().endsWith('@' + domain)) || null;
    const contact = c ? { name: c.name || c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || null, role: c.job_title || c.title || c.position || null, email: String(c.email).toLowerCase() } : {};
    await redis.set(key, { contact, expiresAt: new Date(Date.now() + 30 * 864e5).toISOString() });
    return contact;
}
/** Every company domain already in an outreach thread, so a hiring card is never a second touch. */
async function outreachDomains() {
    const state = await redis.get(KEY);
    const out = new Set();
    for (const r of (state && state.records) || []) {
        const d = String(r.recipient || '').toLowerCase().split('@')[1];
        if (d && !FREE.test(d)) out.add(d.replace(/^www\./, ''));
        try { if (r.website) out.add(new URL(/^https?:/.test(r.website) ? r.website : 'https://' + r.website).hostname.replace(/^www\./, '').toLowerCase()); } catch { /* not a URL */ }
    }
    return out;
}

export function deps() {
    return { kv: redis, getJson, getPage, serpAccount, serpSearch, findymailCredits, findContact, findSitePhone, verifyEmail: email => verifyEmail(email, { redis }), isOptedOut, clientCheck: q => clientCheck(q), crmContact, crmStop, loadBad, isBad };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
        const machine = adminAuthorized(req);
        const view = String(req.query?.view || '');
        if (req.method === 'GET' && !view) {
            if (!machine) return res.status(401).json({ error: 'Unauthorized' });
            const nonce = randomUUID();
            if (!await redis.set(HK.lock, nonce, { nx: true, ex: 290 })) return res.status(200).json({ status: 'already_running' });
            try {
                const d = { ...deps(), outreachDomains: await outreachDomains() };
                const cap = (v, max, dflt) => Math.max(0, Math.min(max, Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : dflt));
                const report = await runHiring(d, { maxSearches: cap(req.query?.searches, 6, 4), maxCandidates: cap(req.query?.candidates, 20, 14), discover: req.query?.discover !== '0' });
                return res.status(200).json({ status: 'complete', report });
            } finally { if (await redis.get(HK.lock) === nonce) await redis.del(HK.lock); }
        }
        let rep = null;
        if (!machine) { rep = await requireAccess(req); if (!ownerFor(rep)) return res.status(403).json({ error: 'Owners only' }); }
        if (req.method === 'GET' && (view === 'status' || view === 'records')) {
            const [records, backlog, runs, seenAll, pendingAll] = await Promise.all([allRecords(redis), allBacklog(redis), redis.lrange(HK.runs, 0, view === 'status' ? 4 : 0), redis.hgetall(HK.seen), redis.hgetall(HK.pending)]);
            const count = (rows, k) => rows.reduce((m, r) => { const v = k(r); m[v] = (m[v] || 0) + 1; return m; }, {});
            const seen = Object.values(seenAll || {}).map(parseValue).filter(Boolean);
            const out = {
                campaignId: HIRING_ID, asOf: new Date().toISOString(),
                cards: { total: records.length, byStatus: count(records, r => r.status), byJobState: count(records, r => (r.job && r.job.state) || 'open'), offeredNow: records.filter(r => hiringCallReady(r)).length, ready: records.filter(r => r.status === 'ready' && !r.callOutcome).length, called: records.filter(r => (r.callHistory || []).length).length, withVerifiedContact: records.filter(r => r.contact && r.contact.status === 'verified').length },
                research: { total: backlog.length, open: backlog.filter(b => b.state === 'open').length, byReason: count(backlog, b => b.reason), entries: backlog.map(b => ({ id: b.id, company: b.company && b.company.name, job: b.job && b.job.title, jobUrl: b.job && b.job.url, reason: b.reason, detail: b.detail, missing: b.missing, attempts: b.attempts, state: b.state, nextTryAt: b.nextTryAt })) },
                pending: Object.values(pendingAll || {}).map(parseValue).filter(Boolean).map(e => ({ key: e.key, url: e.url, attempts: e.attempts, lastError: e.lastError || null, seed: !!(e.provenance && e.provenance.seed), nextTryAt: e.nextTryAt })),
                screened: { postings: seen.length, byVerdict: count(seen, s => s.verdict), excludedBy: count(seen.filter(s => s.verdict === 'excluded'), s => s.reason) },
                runs: (runs || []).map(parseValue).filter(Boolean),
            };
            if (view === 'records') out.records = records;
            return res.status(200).json(out);
        }
        if (req.method === 'POST') {
            if (!machine && req.headers.origin !== SITE) return res.status(403).json({ error: 'Invalid origin' });
            const body = readBody(req);
            if (body.action !== 'seed') return res.status(400).json({ error: 'Unknown action' });
            const urls = (Array.isArray(body.urls) ? body.urls : []).slice(0, 20);
            const accepted = [], refused = [];
            // Into the pending queue, so a seed is never lost to a failed run (api/_hiring-run.js addPending).
            for (const url of urls) { const p = parseAts(url); if (p) { await addPending(redis, { ...p, url }, { seed: true, discoveredBy: 'seed', note: String(body.note || '').slice(0, 200), addedBy: rep ? rep.email : 'machine', discoveredAt: new Date().toISOString() }); accepted.push(url); } else refused.push(url); }
            return res.status(200).json({ ok: true, accepted, refused, note: refused.length ? 'Only official Lever, Greenhouse or Ashby posting URLs are accepted.' : undefined });
        }
        return res.status(405).json({ error: 'Method not allowed' });
    } catch (e) {
        return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
    }
}
