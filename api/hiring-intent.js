// Hiring now: the cloud run, the seed list and the owner's status view.
// ------------------------------------------------------------------
//   GET  (cron, Bearer CRON_SECRET)          one run: re-check ready cards, work the pending queue and
//                                            due research, then discovery. ?discover=0
//                                            skips the paid search; ?searches= and ?candidates= cap it.
//   GET  ?view=status (owner)                counts, the research backlog, the last runs, credits
//   GET  ?view=records (owner)               every card with its evidence, for read-back
//   POST {action:'seed', urls:[...]}         owner or machine: official job URLs to qualify next run
//   POST {action:'hold-cards', holds:[...]}  machine only: named cards off the worklist, with the reason
//   POST {action:'fill-research', source, fills:[...]}  machine only: looked-up numbers for research leads
//   POST {action:'owner-lines', source, lines:[...]}   machine only: an owner's own line first on live cards
//   POST {action:'cells-tried', tried:[...]}           machine only: cards already looked up by hand
//   POST {action:'import-leads', source, leads:[...]}  owner or machine: researched leads into the pending
//                                            queue; worked by the next run (?leads=only works them alone)
// Logic lives in api/_hiring-intent.js and api/_hiring-run.js; this file only wires the real
// services in. Nothing here dials, texts or emails anyone.
import { randomUUID } from 'node:crypto';
import { redis, requireAccess, adminAuthorized, readBody, SITE } from './_auth.js';
import { ownerFor, KEY } from './_outreach-queue.js';
import { bookedIdentity } from './_booked-leads.js';
import { site } from './_outreach-supply.js';
import { findSitePhone } from './_site-phone.js';
import { verifyEmail } from './_outreach-verification.js';
import { isOptedOut } from './_optout.js';
import { clientCheck } from './_client-guard.js';
import { contact as crmContact } from './_outreach-crm.js';
import { crmStop } from './_rep-email-gates.js';
import { loadBad, isBad } from './_bad-numbers.js';
import { rrConfigured, account as rrAccount, lookupPerson, checkStatus as rrCheckStatus, searchPeople } from './_rocketreach.js';
import { HK, HIRING_ID, parseAts, allRecords, allBacklog, parseValue, hiringCallReady, companyKey, cityOf, stateOf, leadKey } from './_hiring-intent.js';
import { runHiring, addPending, holdCards, fillResearch, FILL_FIELDS, ownerLines, RR_TRIED } from './_hiring-run.js';

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
// Google Jobs: one role in one city, the listings Google shows for it.
async function serpJobs(q, location) {
    const u = 'https://serpapi.com/search.json?engine=google_jobs&hl=en&gl=us&q=' + encodeURIComponent(q) + '&location=' + encodeURIComponent(location) + '&api_key=' + encodeURIComponent(process.env.SERPAPI_KEY || '');
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    if (!r.ok || (j.error && !/hasn't returned any results/i.test(j.error))) throw Error('SerpApi Google Jobs failed (' + r.status + ')');
    return { jobs: j.jobs_results || [] };
}
// The employer's Google business listing (name, website, phone, address), one search per employer and
// state, remembered 30 days including a miss, so an employer is never paid for twice.
async function businessProfile(company, location, budget) {
    const key = companyKey(company, location);
    const saved = parseValue(await redis.get(HK.profile(key)));
    if (saved && Date.parse(saved.expiresAt) > Date.now()) return saved.profile || {};
    if (!budget || !await budget.take()) return { error: 'No SerpApi searches left for today; the lookup waits for the next run.', noBudget: true };
    const q = [company, cityOf(location), stateOf(location)].filter(Boolean).join(' ');
    const r = await fetch('https://serpapi.com/search.json?engine=google&hl=en&gl=us&q=' + encodeURIComponent(q) + '&api_key=' + encodeURIComponent(process.env.SERPAPI_KEY || ''), { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    if (!r.ok || (j.error && !/hasn't returned any results/i.test(j.error))) throw Error('SerpApi lookup failed (' + r.status + ')');
    const k = j.knowledge_graph || null;
    const places = Array.isArray(j.local_results) ? j.local_results : (j.local_results && j.local_results.places) || [];
    const p0 = places[0] || null;
    // Google's company panel carries size signals for big employers: a head count, a stock quote, a parent.
    const employees = k && (k.number_of_employees || k.employees) ? Number(String(k.number_of_employees || k.employees).replace(/[^0-9]/g, '')) || null : null;
    const size = k ? { employees, listed: !!(k.stock_price || k.ticker || k.stock), parent: k.parent_organization || k.parent || null } : null;
    const profile = k && k.title && (k.phone || k.website || k.address)
        ? { title: k.title, type: k.type || null, website: k.website || null, phone: k.phone || null, address: k.address || null, size, link: 'https://www.google.com/search?q=' + encodeURIComponent(q), source: 'knowledge panel' }
        : p0 && p0.title ? { title: p0.title, type: p0.type || null, website: (p0.links && p0.links.website) || null, phone: p0.phone || null, address: p0.address || null, link: 'https://www.google.com/search?q=' + encodeURIComponent(q), source: 'local results' } : {};
    await redis.set(HK.profile(key), { profile, query: q, expiresAt: new Date(Date.now() + 30 * 864e5).toISOString() });
    return profile;
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
    return { kv: redis, getJson, getPage, serpAccount, serpSearch, serpJobs, businessProfile, findymailCredits, findContact, findSitePhone, bookedIdentity: q => bookedIdentity(redis, q), verifyEmail: email => verifyEmail(email, { redis }), isOptedOut, clientCheck: q => clientCheck(q), crmContact, crmStop, loadBad, isBad, rr: rrConfigured() ? { account: rrAccount, lookupPerson, checkStatus: rrCheckStatus, searchPeople } : null };
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
                const leadsOnly = req.query?.leads === 'only';
                const report = await runHiring(d, { maxSearches: leadsOnly ? 0 : cap(req.query?.searches, 8, 5), maxCandidates: cap(req.query?.candidates, 40, 25), discover: !leadsOnly && req.query?.discover !== '0', leadsOnly, cells: leadsOnly && req.query?.cells == null ? 0 : cap(req.query?.cells, 20, 6) });
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
                cards: { total: records.length, byStatus: count(records, r => r.status), byJobState: count(records, r => (r.job && /^(open|closed|stale)$/.test(r.job.state || '') ? r.job.state : 'open')), offeredNow: records.filter(r => hiringCallReady(r)).length, ready: records.filter(r => r.status === 'ready' && !r.callOutcome).length, called: records.filter(r => (r.callHistory || []).length).length, withVerifiedContact: records.filter(r => r.contact && r.contact.status === 'verified').length },
                research: { total: backlog.length, open: backlog.filter(b => b.state === 'open').length, byReason: count(backlog, b => b.reason),
                    // Cards taken off the list for uncertain proof: kept whole, with the reason (status research).
                    heldCards: records.filter(r => r.status === 'research').map(r => ({ id: r.id, company: r.company && r.company.name, job: r.job && r.job.title, reason: r.hold && r.hold.reason, detail: r.hold && r.hold.detail, at: r.hold && r.hold.at, by: r.hold && r.hold.by })), entries: backlog.map(b => ({ id: b.id, company: b.company && b.company.name, job: b.job && b.job.title, jobUrl: b.job && b.job.url, reason: b.reason, detail: b.detail, missing: b.missing, attempts: b.attempts, state: b.state, nextTryAt: b.nextTryAt })) },
                pending: Object.values(pendingAll || {}).map(parseValue).filter(Boolean).map(e => ({ key: e.key, url: e.url, attempts: e.attempts, lastError: e.lastError || null, seed: !!(e.provenance && e.provenance.seed), nextTryAt: e.nextTryAt })),
                screened: { postings: seen.length, byVerdict: count(seen, s => s.verdict), excludedBy: count(seen.filter(s => s.verdict === 'excluded'), s => s.reason) },
                runs: (runs || []).map(parseValue).filter(Boolean),
                // Is the loop running? The cron fires weekdays at :15 past every hour 13-23 UTC (9:15 AM to 7:15 PM ET).
                loop: (() => { const rs = (runs || []).map(parseValue).filter(Boolean); const last = rs[0] || null; const today = new Date().toISOString().slice(0, 10);
                    return { lastRunAt: last && last.startedAt || null, lastRunReady: last ? (last.ready || []).length : null, cardsAddedToday: records.filter(r => String(r.createdAt || '').slice(0, 10) === today).length, schedule: 'weekdays every hour, 9:15 AM to 7:15 PM ET' }; })(),
            };
            if (view === 'records') out.records = records;
            return res.status(200).json(out);
        }
        if (req.method === 'POST') {
            if (!machine && req.headers.origin !== SITE) return res.status(403).json({ error: 'Invalid origin' });
            const body = readBody(req);
            // Machine only: named cards off the worklist with an audit note (api/_hiring-run.js holdCards).
            // Dry unless write is true, and a write must name how many cards it expects to change.
            if (body.action === 'hold-cards') {
                if (!machine) return res.status(403).json({ error: 'Machine only' });
                const holds = (Array.isArray(body.holds) ? body.holds : []).slice(0, 20)
                    .filter(h => h && /^hire:[0-9a-f]{16}$/.test(String(h.id)) && ['hold', 'exclude'].includes(h.action) && h.reason && h.detail)
                    .map(h => ({ id: String(h.id), action: h.action, reason: String(h.reason).slice(0, 40), detail: String(h.detail).slice(0, 500), company: h.company === 'large' ? 'large' : null }));
                if (!holds.length) return res.status(400).json({ error: 'No valid holds' });
                const write = body.write === true;
                if (write && Number(body.expected) !== holds.length) return res.status(400).json({ error: 'expected must equal the number of holds' });
                const results = await holdCards(redis, { holds, write, by: String(body.by || 'machine').slice(0, 120) });
                return res.status(200).json({ ok: true, write, results });
            }
            // Machine only: numbers looked up for research leads (api/_hiring-run.js fillResearch). Same guard as above.
            if (body.action === 'fill-research') {
                if (!machine) return res.status(403).json({ error: 'Machine only' });
                const source = String(body.source || '').trim().slice(0, 40);
                if (!source) return res.status(400).json({ error: 'Name where the numbers came from' });
                const fills = (Array.isArray(body.fills) ? body.fills : []).slice(0, 100).filter(f => f && /^hire:[0-9a-f]{16}$/.test(String(f.id)))
                    .map(f => ({ id: String(f.id), phone: String(f.phone || ''), phone_type: String(f.phone_type || '').slice(0, 30) || null, phone_person: String(f.phone_person || '').slice(0, 80) || null, phone_grade: String(f.phone_grade || '').slice(0, 4) || null, phone_alternates: (Array.isArray(f.phone_alternates) ? f.phone_alternates : []).map(String).slice(0, 3), checked_at: String(f.checked_at || '').slice(0, 30) || null, source_url: String(f.source_url || '').slice(0, 300) || null, public_phone: String(f.public_phone || '').slice(0, 20) || null, public_phone_url: String(f.public_phone_url || '').slice(0, 300) || null, ...Object.fromEntries(FILL_FIELDS.map(k => [k, String(f[k] || '').slice(0, 300)])) }));
                if (!fills.length) return res.status(400).json({ error: 'No valid fills' });
                const write = body.write === true;
                if (write && Number(body.expected) !== fills.length) return res.status(400).json({ error: 'expected must equal the number of fills' });
                const results = await fillResearch(redis, { source, fills, write, by: String(body.by || 'machine').slice(0, 120) });
                return res.status(200).json({ ok: true, write, source, results });
            }
            // Machine only: an owner's own line put first on live cards (api/_hiring-run.js ownerLines). Same guard as above.
            if (body.action === 'owner-lines') {
                if (!machine) return res.status(403).json({ error: 'Machine only' });
                const source = String(body.source || '').trim().slice(0, 40);
                if (!source) return res.status(400).json({ error: 'Name where the numbers came from' });
                const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 150).filter(f => f && /^hire:[0-9a-f]{16}$/.test(String(f.id)))
                    .map(f => ({ id: String(f.id), phone: String(f.phone || ''), phone_type: String(f.phone_type || '').slice(0, 30) || null, phone_person: String(f.phone_person || '').slice(0, 80) || null, phone_grade: String(f.phone_grade || '').slice(0, 4) || null, phone_alternates: (Array.isArray(f.phone_alternates) ? f.phone_alternates : []).map(String).slice(0, 3), checked_at: String(f.checked_at || '').slice(0, 30) || null, owner_title: String(f.owner_title || '').slice(0, 120) || null }));
                if (!lines.length) return res.status(400).json({ error: 'No valid lines' });
                const write = body.write === true;
                if (write && Number(body.expected) !== lines.length) return res.status(400).json({ error: 'expected must equal the number of lines' });
                const results = await ownerLines(redis, { source, lines, write, by: String(body.by || 'machine').slice(0, 120), isOptedOut, loadBad, isBad });
                return res.status(200).json({ ok: true, write, source, results });
            }
            // Machine only: cards already looked up by hand, so the hourly owner-cell step does not pay for them again.
            if (body.action === 'cells-tried') {
                if (!machine) return res.status(403).json({ error: 'Machine only' });
                const rows = (Array.isArray(body.tried) ? body.tried : []).slice(0, 300).filter(t => t && /^hire:[0-9a-f]{16}$/.test(String(t.id)) && ['added', 'no_mobile', 'not_found', 'mismatch'].includes(t.result));
                if (!rows.length) return res.status(400).json({ error: 'No valid rows' });
                const at = new Date().toISOString();
                if (body.write === true) {
                    if (Number(body.expected) !== rows.length) return res.status(400).json({ error: 'expected must equal the number of rows' });
                    await redis.hset(RR_TRIED, Object.fromEntries(rows.map(t => [String(t.id), JSON.stringify({ at, result: t.result, how: 'by hand', profileId: t.profileId || null, why: String(t.why || '').slice(0, 200) || null })])));
                }
                return res.status(200).json({ ok: true, write: body.write === true, rows: rows.length });
            }
            // Leads a person researched (Madison's list, 2026-10-28). Into the pending queue first, so none is lost;
            // each one meets every check a found posting meets when a run works it (api/_hiring-run.js processLead).
            if (body.action === 'import-leads') {
                const FIELDS = ['owner_first', 'owner_last', 'owner_title', 'business', 'industry', 'city', 'state', 'website', 'owner_email', 'phone', 'role_posted', 'posting_url', 'posting_date', 'email_source_url', 'notes', 'vertical'];
                const source = String(body.source || (rep && rep.name) || 'our team').trim().slice(0, 40);
                const leads = (Array.isArray(body.leads) ? body.leads : []).slice(0, 500).map(x => Object.fromEntries(FIELDS.map(f => [f, x && x[f] != null ? String(x[f]).trim().slice(0, f === 'notes' ? 600 : 300) : null])));
                const at = new Date().toISOString();
                let added = 0, waiting = 0, refused = 0;
                for (const l of leads) {
                    if (!l.business || !l.role_posted) { refused++; continue; }
                    const key = leadKey(l);
                    if (await redis.hget(HK.pending, key)) { waiting++; continue; }
                    await addPending(redis, { kind: 'lead', key, lead: l }, { seed: true, discoveredBy: 'provided', source, addedBy: rep ? rep.email : 'machine', discoveredAt: at, file: String(body.file || '').slice(0, 120) || null });
                    added++;
                }
                return res.status(200).json({ ok: true, source, received: leads.length, added, alreadyWaiting: waiting, refused });
            }
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
