// One run of the Hiring now campaign: find current posts, read each back from the company's own
// hiring system, admit the company only on proof, find its listed number and a contact, apply every
// exclusion, and file the result as ready, research backlog or excluded. Nothing here dials or sends.
// ------------------------------------------------------------------
// Every outside call comes in through `deps`, so the tests run the whole path on fakes. The real
// ones live in api/hiring-intent.js. Paid calls (SerpApi, Findymail) are counted, capped and
// guarded; a vendor error is recorded as an error and the row stays retryable, never as "none
// found" (memory: an API error is not absence).
import { contactLinks, phonesOnPage, visibleText, PATTERN as PHONE_RUN } from './_site-phone.js';
import { syncQuoContacts } from './_quo-contacts.js';
import { KEY as QUEUE_KEY } from './_outreach-queue.js';
import {
    HIRING_ID, HK, QUERIES, JOB_QUERIES, MAX_AGE_DAYS, parseAts, postingKey, boardKey, idFor, qualifyPosting, qualifyJob, jobKey, companyKey, phoneKey, cityOf, stateOf, jobAgeDays, listingAge, profileMatches, priorityOf, ageDays, jobCurrent,
    boardHomepage, linksToBoard, websiteCandidates, outboundLinks, careersLinks, hostOf, briefFor, firstNameOf, companyExcluded, LARGE_EMPLOYEES, roleFamily,
    parseValue, putRecord, putBacklog, allBacklog, allRecords, getRecord, nextTry, companyThread, domainKey, listingEvidence, remotePost, MAIN_LINE, mainLabel, mainNumbers,
    ageBased, leadKey, leadDomain, qualifyLead, leadStatedDate, leadDateLabel, hiringCallReady, tollFree, laneFor, FEED_TERMS, ownSite, competitorReason,
} from './_hiring-intent.js';

export const SERP_RESERVE = 300;      // searches left in the month that this campaign never touches
// Job searches and business-listing lookups together, per day. Sized 2026-10-28 for two full-time callers:
// about 60 to 100 new cards a day at roughly 1.5 to 2 searches a card.
export const SERP_DAILY_CAP = 180;
export const FINDYMAIL_FLOOR = 200;   // finder credits left that this campaign never touches
const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|me|live|msn|proton(mail)?)\./i;
const strip = h => String(h || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ---- the hiring systems' public posting APIs ---------------------------------------------------
/** One posting, normalized. `getJson(url)` returns { status, body }. `getPage(url)` is the SSRF-safe site fetch. */
export async function fetchPosting(p, { getJson, getPage }) {
    const enc = encodeURIComponent;
    if (p.ats === 'lever') {
        const r = await getJson(`https://api.lever.co/v0/postings/${enc(p.board)}/${enc(p.id)}`);
        if (r.status === 404) return { live: false };
        if (r.status !== 200 || !r.body || !r.body.text) throw Error('Lever answered ' + r.status);
        const j = r.body;
        const list = await getJson(`https://api.lever.co/v0/postings/${enc(p.board)}?mode=json&limit=200`).catch(() => null);
        const page = await getPage(j.hostedUrl).catch(() => null);
        const title = page && (String(page.html || '').match(/<title>([^<]*)<\/title>/i) || [])[1];
        const wt = String(j.workplaceType || '').toLowerCase().replace('on-site', 'onsite');
        return {
            live: true, ats: 'lever', board: p.board, id: p.id, url: j.hostedUrl, title: j.text,
            company: title && title.includes(' - ') ? strip(title.split(' - ')[0]) : p.board,
            postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
            workplace: ['remote', 'hybrid', 'onsite'].includes(wt) ? wt : null,
            location: j.categories && j.categories.location || null, locations: (j.categories && j.categories.allLocations) || [], country: j.country || null,
            team: j.categories && j.categories.team || null, commitment: j.categories && j.categories.commitment || null,
            text: [j.descriptionPlain, ...(j.lists || []).map(l => l.text + ' ' + strip(l.content)), j.additionalPlain].filter(Boolean).join(' '),
            openRoles: Array.isArray(list && list.body) ? list.body.length : null,
            homepage: page ? boardHomepage('lever', page.html) : null,
            links: page ? outboundLinks(page.html) : [],
        };
    }
    if (p.ats === 'greenhouse') {
        const r = await getJson(`https://boards-api.greenhouse.io/v1/boards/${enc(p.board)}/jobs/${enc(p.id)}`);
        if (r.status === 404) return { live: false };
        if (r.status !== 200 || !r.body || !r.body.title) throw Error('Greenhouse answered ' + r.status);
        const j = r.body;
        const [list, board] = await Promise.all([getJson(`https://boards-api.greenhouse.io/v1/boards/${enc(p.board)}/jobs`).catch(() => null), getJson(`https://boards-api.greenhouse.io/v1/boards/${enc(p.board)}`).catch(() => null)]);
        const loc = j.location && j.location.name || '';
        const content = strip(j.content);
        return {
            live: true, ats: 'greenhouse', board: p.board, id: p.id, url: j.absolute_url, title: j.title,
            company: j.company_name || (board && board.body && board.body.name) || p.board,
            postedAt: j.first_published || j.updated_at || null,
            workplace: /\bremote\b/i.test(loc + ' ' + j.title) ? 'remote' : /\bhybrid\b/i.test(loc) ? 'hybrid' : null,
            location: loc || null, locations: (j.offices || []).map(o => o.name).filter(Boolean), country: null,
            team: (j.departments || []).map(d => d.name)[0] || null, commitment: null,
            text: content,
            openRoles: list && list.body && list.body.meta ? Number(list.body.meta.total) : null,
            homepage: null,
            links: [...outboundLinks(String(j.content || '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')), ...outboundLinks(board && board.body && String(board.body.content || '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))],
        };
    }
    if (p.ats === 'ashby') {
        const r = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${enc(p.board)}?includeCompensation=false`);
        if (r.status === 404) return { live: false };
        if (r.status !== 200 || !r.body || !Array.isArray(r.body.jobs)) throw Error('Ashby answered ' + r.status);
        const j = r.body.jobs.find(x => String(x.id).toLowerCase() === p.id);
        if (!j || j.isListed === false) return { live: false };
        const page = await getPage(j.jobUrl).catch(() => null);
        const title = page && (String(page.html || '').match(/<title>([^<]*)<\/title>/i) || [])[1];
        const wt = String(j.workplaceType || '').toLowerCase();
        return {
            live: true, ats: 'ashby', board: p.board, id: p.id, url: j.jobUrl, title: String(j.title || '').trim(),
            company: title && title.includes(' @ ') ? strip(title.split(' @ ').pop()) : p.board,
            postedAt: j.publishedAt || null,
            workplace: wt === 'remote' || (j.isRemote && !wt) ? 'remote' : wt === 'hybrid' ? 'hybrid' : wt === 'onsite' ? 'onsite' : j.isRemote ? 'remote' : null,
            location: j.location || null, locations: (j.secondaryLocations || []).map(x => x.location).filter(Boolean), country: null,
            team: j.department || null, commitment: j.employmentType || null,
            text: String(j.descriptionPlain || strip(j.descriptionHtml) || ''),
            openRoles: r.body.jobs.filter(x => x.isListed !== false).length,
            homepage: page ? boardHomepage('ashby', page.html) : null,
            links: page ? outboundLinks(page.html) : [],
        };
    }
    throw Error('Unsupported hiring system');
}

/**
 * The company's website, only on proof. Returns { website, domain, how, evidenceUrl, page } or
 * { unresolved: reason, tried }. `getPage` is the SSRF-safe fetch.
 */
export async function resolveIdentity(posting, { getPage }) {
    const p = { ats: posting.ats, board: posting.board };
    if (posting.homepage) {
        const page = await getPage(posting.homepage).catch(() => null);
        if (page) return { ok: true, website: page.url, domain: hostOf(page.url), how: 'board_link', evidenceUrl: posting.url, page };
    }
    const tried = [];
    for (const host of websiteCandidates({ company: posting.company, board: posting.board, links: [posting.homepage, ...(posting.links || [])].filter(Boolean) })) {
        const home = await getPage('https://' + host).catch(() => null);
        tried.push(host);
        if (!home) continue;
        if (linksToBoard(home.html, p)) return { ok: true, website: home.url, domain: hostOf(home.url), how: 'backlink', evidenceUrl: home.url, page: home };
        for (const c of careersLinks(home)) {
            const cp = await getPage(c).catch(() => null);
            if (cp && linksToBoard(cp.html, p)) return { ok: true, website: home.url, domain: hostOf(home.url), how: 'backlink', evidenceUrl: cp.url, page: home };
        }
    }
    return { unresolved: 'No website could be tied to this job board: the board names no homepage and no candidate site links back to it.', tried };
}

// ---- the local number -----------------------------------------------------------------------
// PM, 2026-10-28, on Damotech: their contact page lists "Lockport, IL, Sales: 815-723-7400" next to a
// toll-free line, while Google's listing gave an 855 number. A number the employer publishes next to
// the job's own city is the one to ring first; the listing's number stays as an alternate. Free: the
// homepage and up to three contact or location pages. Null when no number sits next to the city.
const TOLL_FREE = /^(800|833|844|855|866|877|888)/;
// The same number pattern and the same visible text as api/_site-phone.js: never a CSS decimal or a script's digits.
export async function localNumber({ website, city, getPage }) {
    if (!website || !city) return null;
    let home;
    try { home = await getPage(website); } catch { return null; }
    if (!home) return null;
    const pages = [home];
    for (const u of contactLinks(home, 3)) { try { const p = await getPage(u); if (p) pages.push(p); } catch { /* skip */ } }
    const cityRe = new RegExp('\\b' + String(city).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    for (const p of pages) {
        const text = visibleText(p);
        for (const m of text.matchAll(PHONE_RUN)) {
            const d = m[1] + m[2] + m[3];
            if (TOLL_FREE.test(d)) continue;
            const before = text.slice(Math.max(0, m.index - 80), m.index);
            if (cityRe.test(before)) return { phone: '+1' + d, sourceUrl: p.url, context: before.replace(/\s+/g, ' ').trim().split(' ').slice(-8).join(' ') + ' ' + m[0].trim(), checkedAt: new Date().toISOString() };
        }
    }
    return null;
}
/** The card's numbers with a city-tied site number first; the old first number kept as an alternate. */
export function preferLocal(phone, local) {
    if (!local || !phone || local.phone === phone.number) return null;
    const alternates = [phone.number, ...(phone.alternates || [])].filter((n, i, a) => n && n !== local.phone && a.indexOf(n) === i);
    return { ...phone, number: local.phone, alternates, source: 'business website', sourceUrl: local.sourceUrl, context: local.context, checkedAt: local.checkedAt, type: 'company line for this location, from their own website', previous: { number: phone.number, source: phone.source }, localCheckedAt: local.checkedAt };
}

// ---- is the number one the employer publishes? ------------------------------------------------
// PM, 2026-10-28: a Google listing's number was on no public page for four cards in one morning (a
// law firm whose site gives another line, a clinic whose site gives only a toll-free number, a home
// health agency whose domain had expired). The employer's own website decides: a number it
// publishes goes first and the listing's stays as an alternate. A site that now lives on another
// domain is held for research. A site that cannot be read changes nothing: that is not evidence.
export async function siteCheck({ website, domain, getPage, findSitePhone }) {
    if (!website || !findSitePhone) return { unreadable: true };
    const memo = new Map();
    const fetchOnce = u => { if (!memo.has(u)) memo.set(u, Promise.resolve().then(() => getPage(u))); return memo.get(u); };
    let home;
    try { home = await fetchOnce(website); } catch { return { unreadable: true }; }
    if (!home) return { unreadable: true };
    const h = hostOf(home.url || website), d = String(domain || hostOf(website) || '').toLowerCase();
    if (h && d && !(h === d || h.endsWith('.' + d) || d.endsWith('.' + h))) return { moved: h };
    // Every page a person would look at (the homepage and up to three contact or location pages), not
    // just the first one with a number: a city line on the contact page is as published as the homepage's.
    const pages = [home];
    for (const u of contactLinks(home, 3)) { try { const pg = await fetchOnce(u); if (pg) pages.push(pg); } catch { /* skip */ } }
    const numbers = [...new Set(pages.flatMap(pg => phonesOnPage(pg).map(h => '+1' + h.digits)))].filter(n => !tollFree(n));
    const found = await findSitePhone({ website, fetchSite: fetchOnce, maxPages: 4 }).catch(() => null);
    const site = found && found.phone && tollFree(found.phone) ? null : found;
    const first = site && site.phone ? site : numbers.length ? { phone: numbers[0], sourceUrl: home.url || website } : null;
    return { numbers: first && !numbers.includes(first.phone) ? [first.phone, ...numbers] : numbers, site: first };
}
/** The numbers in the order to ring them, given what the site publishes. */
export function alignNumbers(primary, alternates, chk) {
    const all = [primary, ...(alternates || [])].filter((n, i, a) => n && a.indexOf(n) === i);
    if (!chk || chk.unreadable) return { primary, alternates: alternates || [], result: 'unreadable' };
    if (!chk.numbers || !chk.numbers.length) return { primary, alternates: alternates || [], result: 'none_published' };
    if (chk.numbers.includes(primary)) return { primary, alternates: alternates || [], result: 'confirmed' };
    const onSite = all.find(n => chk.numbers.includes(n));
    const first = onSite || chk.numbers[0];
    return { primary: first, alternates: all.filter(n => n !== first), result: onSite ? 'alternate_on_site' : 'replaced', site: chk.site };
}

// ---- Google Jobs listings ---------------------------------------------------------------------
const digits10 = v => String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
/** A Google Jobs result as a posting: no API to re-read it, so its age comes from Google's label. */
export function listingPosting(l, now = Date.now()) {
    const age = listingAge(l, now);
    const links = (l.apply_options || []).map(a => a && a.link).filter(Boolean);
    return {
        live: true, source: 'google_jobs', title: l.title, company: l.company_name, location: l.location, via: String(l.via || '').replace(/^via\s+/i, '') || null,
        feed: l.feed || null, companyWebsite: l.company_website || null,
        postedAt: l.posted_at || (age == null ? null : new Date(now - age * 864e5).toISOString()),
        url: l.share_link || links[0] || null, applyUrl: links[0] || null,
        workplace: /\b(remote|work from home|anywhere)\b/i.test([l.title, l.location, ...(l.extensions || [])].join(' ')) ? 'remote' : 'onsite',
        text: l.description || '', openRoles: l.open_roles != null && Number.isFinite(Number(l.open_roles)) ? Number(l.open_roles) : null,
    };
}
/** The compact listing kept in the pending queue: what processPosting needs, nothing more. */
export function compactListing(l, now = Date.now()) {
    // Google's "3 days ago" is true only today: keep the date it implies, so a later pass counts real days. A feed that
    // gives the date itself (Workable's created) keeps that date: dropping it made a fresh listing 'undated_post' later.
    const age = jobAgeDays(l.extensions);
    const given = Date.parse(l.posted_at || '');
    const posted = Number.isFinite(given) ? new Date(given).toISOString() : age == null ? null : new Date(now - age * 864e5).toISOString();
    return { posted_at: posted, found_at: new Date(now).toISOString(), job_id: l.job_id || null, title: l.title, company_name: l.company_name, ...(l.company_website ? { company_website: String(l.company_website).slice(0, 300) } : {}), location: l.location, via: l.via || null, ...(l.feed ? { feed: l.feed } : {}), ...(l.open_roles != null ? { open_roles: l.open_roles, open_states: l.open_states } : {}), extensions: (l.extensions || []).slice(0, 6), description: String(l.description || '').slice(0, 3000), apply_options: (l.apply_options || []).slice(0, 5).map(a => ({ title: a.title, link: a.link })), share_link: l.share_link || null };
}

// ---- free job boards (Workable) -----------------------------------------------------------------
// Paul, 2026-10-30: SerpApi is out of credits, so the Hub's only automatic refill had stopped. Workable's public job
// search costs nothing and names the employer's own website on every job, so its listings need no paid lookup: the
// website is the proof of who hires (profileIdentity) and the number comes free from that site. A Workable link is never
// an apply option here: BRAND_CAREERS reads jobs.workable.com as the employer's own careers site, a large employer's habit.
export const FEED_REQUESTS = 8;   // Workable searches a run, its own cap: no SerpApi budget is touched
export const FEED_PAGES = 2;      // pages a title: past those, a broad search drifts into jobs that only mention the words
export const FEED_MULTI_CITY = 3; // the same title from one company in this many cities is a large employer's posting
export const FEED_COMPANY_READS = 20; // company pages a run (Workable's free count of a company's open jobs), one a company
const textOf = h => strip(String(h || '').replace(/&nbsp;/gi, ' '));
const US = /^(united\s+states(\s+of\s+america)?|usa?)$/i;
/** One Workable job as a listing in compactListing's shape, or null when it is not a US job. */
export function workableListing(j, now = Date.now()) {
    const loc = (j && j.location) || {};
    if (!j || !j.title || !US.test(String(loc.countryName || '').trim())) return null;
    const city = String(loc.city || '').trim(), sub = String(loc.subregion || '').trim();
    const st = sub ? stateOf(', ' + sub) : null;
    // "Dublin, OH" the way Google writes it. A remote job with only a state keeps the state's name, so no city is made up.
    const location = city ? city + ', ' + (st || 'United States') : st && stateOf(sub) === st ? sub : 'United States';
    const web = String((j.company && j.company.website) || '').trim();
    const created = Date.parse(j.created || '');
    return {
        posted_at: Number.isFinite(created) ? new Date(created).toISOString() : null, found_at: new Date(now).toISOString(),
        job_id: 'workable:' + (j.id || j.url), title: String(j.title).trim(), company_name: String((j.company && j.company.title) || '').trim(),
        company_website: web ? (/^https?:\/\//i.test(web) ? web : 'https://' + web) : null, location, via: 'Workable', feed: 'Workable',
        extensions: String(j.workplace || '').toLowerCase() === 'remote' ? ['Work from home'] : [],
        description: [j.description, j.requirementsSection, j.benefitsSection].map(textOf).filter(Boolean).join(' ').slice(0, 3000),
        apply_options: [], share_link: j.url || null,
    };
}
// "Front Office Receptionist - Scottsdale AZ", "Account Associate (New York, NY)": the place a title names is not the seat,
// so Qualderm's one receptionist job in three cities is one title, three times (Workable, 2026-10-30).
const TITLE_TAIL = /\s*(?:\s[-–—|]\s*|\(|,)\s*([^-–—|()]+?)\)?\s*$/;
/** The seat a title names, without a trailing place: a state code, the job's own city or a state's name. */
export function seatTitle(title, location) {
    const t = String(title || '').trim(), m = t.match(TITLE_TAIL);
    if (!m) return t.toLowerCase();
    const tail = m[1].trim(), city = cityOf(location);
    const place = (/(^|[\s,])[A-Z]{2}$/.test(tail) && stateOf(', ' + tail.slice(-2))) || (city && tail.toLowerCase().startsWith(city.toLowerCase())) || (stateOf(tail) && tail.split(/\s+/).length <= 4);
    return (place ? t.slice(0, m.index) : t).trim().toLowerCase();
}
const sameJob = l => companyKey(l.company_name, '') + '|' + seatTitle(l.title, l.location);
/** Workable lists one job per city: the company-and-title pairs posted in FEED_MULTI_CITY or more cities in one search. */
export function multiCity(listings) {
    const where = new Map();
    // Each listing counts under its title as written and under its title with a trailing place removed, so "Rep (San
    // Diego)" in three cities is one seat whichever city the title happens to name.
    const keys = l => [...new Set([sameJob(l), companyKey(l.company_name, '') + '|' + String(l.title || '').trim().toLowerCase()])];
    for (const l of listings) for (const k of keys(l)) { if (!where.has(k)) where.set(k, new Set()); where.get(k).add(String(l.location || '').toLowerCase()); }
    const many = new Set([...where].filter(([, s]) => s.size >= FEED_MULTI_CITY).map(([k]) => k));
    for (const l of listings) if (keys(l).some(k => many.has(k))) many.add(sameJob(l));
    return many;
}
/** How many US states a company's open Workable jobs sit in (the page its company endpoint returns). */
export function boardStates(jobs) {
    const st = new Set();
    for (const j of jobs || []) { const loc = (j && j.location) || {}; const s = US.test(String(loc.countryName || '').trim()) && stateOf(', ' + String(loc.subregion || '').trim()); if (s) st.add(s); }
    return st.size;
}
/** The company's Workable id, from its company page link (or a job link that carries one). */
const boardSlug = j => (String((j && j.company && j.company.url) || '').match(/\/company\/([A-Za-z0-9]+)/) || String((j && j.url) || '').match(/\/company\/([A-Za-z0-9]+)/) || [])[1] || null;
/**
 * One run's free search: up to FEED_REQUESTS Workable requests, rotating FEED_TERMS on its own cursor, the last day's US
 * postings only (three days on a Monday). Each job is screened like a Google listing (qualifyJob) and queued as a 'gjob'
 * unless it was seen in the last MAX_AGE_DAYS or already waits, and only once the employer's size is known.
 * deps.workableJobs({ query, dayRange, pageToken }) -> { jobs, nextPageToken }; deps.workableCompany(id) -> { openRoles, jobs }.
 */
export async function workableDiscovery(deps, { now = Date.now(), maxRequests = FEED_REQUESTS, timeLeft = () => true, startedAt = null, companyReads = FEED_COMPANY_READS } = {}) {
    const { kv } = deps;
    const out = { requests: 0, fetched: 0, us: 0, passed: 0, queued: 0, alreadySeen: 0, alreadyWaiting: 0, companyReads: 0, dropped: {}, searches: [] };
    const drop = r => { out.dropped[r] = (out.dropped[r] || 0) + 1; };
    let cur;
    try { cur = parseValue(await kv.get(HK.feedCursor)) || {}; } catch { out.cursorError = 'The Workable search position could not be read; no Workable searches this run.'; return out; }
    let term = Number.isInteger(cur.term) && cur.term >= 0 ? cur.term % FEED_TERMS.length : 0;
    let token = typeof cur.token === 'string' && cur.token ? cur.token : null, page = token ? Number(cur.page) || 0 : 0;
    // The cron runs on weekdays only, so Monday's one-day window missed Friday evening to Sunday (2026-10-30): on a
    // Monday (UTC) every search looks back three days.
    const dayRange = new Date(now).getUTCDay() === 1 ? 3 : 1;
    const batches = [];
    for (let i = 0; i < maxRequests && timeLeft(); i++) {
        const [family, query] = FEED_TERMS[term];
        const s = { family, term: query, page };
        let r = null;
        out.requests++;
        try { r = await deps.workableJobs({ query, dayRange, pageToken: token || undefined }); } catch (e) { s.error = String((e && e.message) || e).slice(0, 80); }
        // The next page of this title, or the next title. A failed page moves on too, so a stale token never pins the loop.
        // A title cut off by the run's cap starts again next run, so all its pages are read together (the multi-city rule).
        const next = r && r.nextPageToken && page + 1 < FEED_PAGES ? String(r.nextPageToken) : null;
        if (next && i + 1 < maxRequests) { page++; token = next; } else if (next) { page = 0; token = null; } else { term = (term + 1) % FEED_TERMS.length; page = 0; token = null; }
        await kv.set(HK.feedCursor, JSON.stringify({ term, page, token })).catch(() => { out.cursorError = 'The Workable search position could not be saved.'; });
        const jobs = r && Array.isArray(r.jobs) ? r.jobs : [];
        s.results = jobs.length; s.queued = 0;
        out.fetched += jobs.length;
        out.searches.push(s);
        if (!s.error) batches.push({ s, jobs });
    }
    // How big the employer is (2026-10-30: BKF, Serenity Mental Health Centers and LaBella became cards with 333, 364
    // and 331 open jobs). Workable's free company page counts a company's open jobs: one read a company a run, after
    // every other check. A count that cannot be read admits nobody: the job is skipped and met again on a later search.
    const sizes = new Map();
    const sizeOf = j => {
        const id = boardSlug(j);
        if (!id || !deps.workableCompany) return null;
        if (!sizes.has(id)) {
            if (out.companyReads >= companyReads || !timeLeft()) return null;
            out.companyReads++;
            sizes.set(id, Promise.resolve().then(() => deps.workableCompany(id)).then(c => (c && c.openRoles != null && Number.isFinite(Number(c.openRoles)) ? { openRoles: Number(c.openRoles), states: boardStates(c.jobs) } : null), () => null));
        }
        return sizes.get(id);
    };
    // One search is one title, however many pages it took this run.
    const byTitle = new Map();
    for (const b of batches) byTitle.set(b.s.term, [...(byTitle.get(b.s.term) || []), b]);
    const keys = new Set();
    for (const [query, bs] of byTitle) {
        const found = [];
        for (const b of bs) for (const j of b.jobs) { const l = workableListing(j, now); if (l) { out.us++; found.push({ l, s: b.s, j }); } else drop('outside_us'); }
        const many = multiCity(found.map(x => x.l));
        for (const { l, s, j } of found) {
            if (many.has(sameJob(l))) { drop('multi_city'); continue; }
            const v = qualifyJob(l, now);
            if (!v.ok) { drop(v.reason); continue; }
            out.passed++;
            const key = jobKey(l);
            if (keys.has(key)) continue;
            keys.add(key);
            const was = parseValue(await kv.hget(HK.seen, key));
            if (was && Date.parse(was.at) >= now - MAX_AGE_DAYS * 864e5) { out.alreadySeen++; continue; }
            if (await kv.hget(HK.pending, key)) { out.alreadyWaiting++; continue; }
            const size = await sizeOf(j);
            if (!size) { drop('size_unknown'); continue; }
            // The count rides on the listing, so qualifyJob holds the card to it now and on every re-check.
            const sized = { ...l, open_roles: size.openRoles, open_states: size.states };
            const big = qualifyJob(sized, now);
            if (!big.ok) {
                drop(big.reason);
                // Seen, so the next run's searches do not read the same company again for this job.
                await kv.hset(HK.seen, { [key]: JSON.stringify({ at: new Date(now).toISOString(), verdict: 'excluded', reason: big.reason, detail: big.detail, company: l.company_name, title: l.title, url: l.share_link || null }) });
                continue;
            }
            await addPending(kv, { kind: 'gjob', key, listing: compactListing(sized, now) }, { discoveredBy: 'Workable', searchQuery: query, searchLocation: 'United States', discoveredAt: startedAt || new Date(now).toISOString() }, now);
            out.queued++; s.queued++;
        }
    }
    return out;
}

/**
 * The employer behind a Google Jobs listing, from Google's business listing for that name and city.
 * Spends one search through deps.searchBudget unless the answer (or a miss) is cached.
 */
export async function profileIdentity(posting, deps) {
    // A listing that names the employer's own website (Workable does, on every job) is proof the way a job board's
    // homepage link is (resolveIdentity's board_link): free, no Google lookup. A shared host (a State Farm agent page, a
    // franchise, a social page) names nobody, so that listing still goes to Google's business listing.
    // Only once the site is read (2026-10-30): the host it lands on is the domain (engagetech.co.uk is engagetech.io), it
    // has to be theirs (ownSite: PIMCO's "website" was a job board's page), and a site that sells staffing or outsourcing
    // is a competitor (EngageTech, "Outsourced and Managed SDR Services"). Anything less goes to Google's listing.
    const site = posting.companyWebsite ? (/^https?:\/\//i.test(posting.companyWebsite) ? posting.companyWebsite : 'https://' + posting.companyWebsite) : null;
    let refused = null;
    if (site && leadDomain(site)) {
        let home = null;
        try { home = deps.getPage ? await deps.getPage(site) : null; } catch { home = null; }
        const host = home ? hostOf(home.url || site) : null;
        refused = home ? ownSite(host, posting.company) : `${hostOf(site)} could not be read`;
        if (!refused) {
            const comp = competitorReason({ company: '', text: [home.title, visibleText(home)].join(' ') });
            if (comp) return { ok: false, competitor: true, unresolved: `Their website, ${host}, ${comp.replace(/^the post /, '')}.` };
            return { ok: true, how: 'listing_website', website: home.url || site, domain: host, evidenceUrl: posting.url || null, page: home };
        }
    }
    let profile;
    try { profile = await deps.businessProfile(posting.company, posting.location, deps.searchBudget); }
    catch (e) { return { error: String((e && e.message) || e).slice(0, 120) }; }
    if (profile && profile.error) return { error: (refused ? `Their listed website was not used: ${refused}. ` : '') + profile.error, noBudget: !!profile.noBudget };
    const m = profileMatches(posting.company, profile, posting.location);
    if (!m.ok) return { ok: false, unresolved: m.why, tried: profile && profile.title ? [profile.title] : [] };
    // A hospital or health system has its own recruiting team: Google types the listing itself as one.
    if (/\b(hospital|medical\s+center|health\s+system|university|school\s+district|government\s+office)\b/i.test(String(profile.type || ''))) return { ok: false, large: true, unresolved: `Google lists them as a ${profile.type}, a large employer.` };
    const sz = profile.size || {};
    if ((sz.employees && sz.employees > LARGE_EMPLOYEES) || sz.listed || sz.parent) return { ok: false, large: true, unresolved: `Google's panel shows a large employer (${sz.employees ? sz.employees + ' employees' : sz.listed ? 'publicly traded' : 'part of ' + sz.parent}).` };
    const host = profile.website ? hostOf(profile.website) : null;
    const d = digits10(profile.phone);
    return { ok: true, how: 'google_business_profile', website: profile.website || null, domain: host, phone: d.length === 10 ? '+1' + d : null, address: profile.address || null, listingName: profile.title, listingType: profile.type || null, evidenceUrl: profile.link || null };
}

// ---- one posting, start to finish ---------------------------------------------------------------
/**
 * deps: kv, getJson, getPage, findSitePhone, findContact, verifyEmail, isOptedOut, clientCheck,
 *       crmContact, crmStop, loadBad, isBad, outreachDomains (Set), now
 * Returns { verdict: 'ready'|'backlog'|'excluded'|'merged'|'seen'|'error', reason?, id?, record? }
 */
export async function processPosting(p, provenance, deps, report) {
    if (p.kind === 'lead') return processLead(p, provenance, deps, report);
    const { kv } = deps;
    const now = deps.now || Date.now();
    // Two sources. An ATS posting is read back from the hiring system's API; a Google Jobs listing
    // (kind 'gjob') arrives whole from the search and its employer is matched to a Google business listing.
    const gj = p.kind === 'gjob';
    const key = gj ? p.key : postingKey(p);
    const seen = parseValue(await kv.hget(HK.seen, key));
    // A seed or a research retry is worked again; anything else seen before is not. A Google Jobs listing
    // seen more than MAX_AGE_DAYS ago is a re-list, worth a fresh look.
    if (seen && !provenance.seed && !provenance.retry && !(gj && Date.parse(seen.at) < now - MAX_AGE_DAYS * 864e5)) return { verdict: 'seen', reason: seen.verdict };
    let posting;
    if (gj) posting = listingPosting(p.listing, now);
    else {
        try { posting = await fetchPosting(p, deps); }
        catch (e) { return { verdict: 'error', reason: 'posting_unreadable', detail: String(e.message || e).slice(0, 120) }; }
    }
    const checkedAt = new Date(now).toISOString();
    const q = gj ? qualifyJob(p.listing, now) : qualifyPosting(posting, now);
    const mark = async (verdict, reason, extra = {}) => { await kv.hset(HK.seen, { [key]: JSON.stringify({ at: checkedAt, verdict, reason, company: posting.company || p.board, title: posting.title || null, url: posting.url || null, ...extra }) }); };
    if (!q.ok) { await mark('excluded', q.reason, { detail: q.detail }); return { verdict: 'excluded', reason: q.reason, detail: q.detail }; }

    // One card per company. A second matching role joins the first card.
    const bk = gj ? companyKey(posting.company, posting.location) : boardKey(p);
    const job = gj
        ? { source: 'google_jobs', ...(posting.feed ? { feed: posting.feed, feedJobId: p.listing.job_id || null } : {}), title: posting.title, url: posting.url, applyUrl: posting.applyUrl, via: posting.via, googleJobId: posting.feed ? null : p.listing.job_id || null, postedAt: posting.postedAt, ageDays: q.age, checkedAt, location: posting.location, city: cityOf(posting.location), usState: stateOf(posting.location), workplace: posting.workplace, restrictions: q.restrictions }
        : { source: 'ats', title: posting.title, url: posting.url, ats: posting.ats, board: posting.board, postingId: posting.id, postedAt: posting.postedAt, ageDays: q.age, checkedAt, location: posting.location, locations: posting.locations, workplace: posting.workplace || 'remote', team: posting.team, commitment: posting.commitment, restrictions: q.restrictions };
    const id = idFor(bk);
    const known = parseValue(await kv.hget(HK.companies, bk));
    if (known && ['client', 'in_outreach', 'suppressed', 'large'].includes(known.verdict)) { await mark('excluded', 'company_' + known.verdict); return { verdict: 'excluded', reason: 'company_' + known.verdict }; }
    const existing = await getRecord(kv, id);
    // A card that exists keeps its history. Only a retry of a wrong number re-researches it.
    if (existing && !(existing.status === 'number_research' && provenance.retry)) {
        if (!(existing.jobs || []).some(x => x.url === job.url)) existing.jobs = [...(existing.jobs || []), job];
        // The card had aged out and this job is current: the new job becomes the reason for the call.
        // A worked card (a conversation, a stop, an exclusion) is never reopened this way.
        const reopen = existing.status === 'ready' && !jobCurrent(existing, now) && !['connected', 'suppress'].includes(existing.callOutcome);
        if (reopen) { existing.job = job; existing.updatedAt = checkedAt; existing.reopenedAt = checkedAt; }
        existing.brief = briefFor(existing);
        await putRecord(kv, existing);
        await mark('merged', reopen ? 'reopened' : 'same_company', { id });
        return reopen ? { verdict: 'ready', reason: 'reopened', id } : { verdict: 'merged', id };
    }
    if (!existing && known && known.verdict === 'backlog' && !provenance.retry && !provenance.seed) { await mark('merged', 'company_in_research', { id }); return { verdict: 'merged', reason: 'company_in_research', id }; }
    const base = {
        id, campaignId: HIRING_ID, family: q.family, ...(gj ? { listing: p.listing } : {}),
        company: { name: posting.company, board: bk, openRoles: posting.openRoles, website: null, domain: null, identity: null },
        job, jobs: [job],
        provenance: { ...provenance, postingKey: key, verifiedVia: gj ? `${posting.feed ? posting.feed + ' listing' : 'Google Jobs listing' + (posting.via ? ' (' + posting.via + ')' : '')}, ${q.age} day(s) old when found` : posting.ats + ' public postings API', firstCheckedAt: checkedAt },
        createdAt: checkedAt, updatedAt: checkedAt,
    };
    const toBacklog = async (reason, detail, extra = {}) => {
        const prev = parseValue(await kv.hget(HK.backlog, id));
        const attempts = (prev && prev.attempts || 0) + 1;
        const entry = { ...(prev || {}), ...base, ...extra, reason, detail, missing: extra.missing || ['phone'], attempts, state: nextTry(attempts, now) ? 'open' : 'exhausted', firstSeenAt: prev && prev.firstSeenAt || checkedAt, lastTriedAt: checkedAt, nextTryAt: nextTry(attempts, now) };
        await putBacklog(kv, entry);
        await kv.hset(HK.companies, { [bk]: JSON.stringify({ id, verdict: 'backlog', at: checkedAt }), ...(base.company.domain ? { [domainKey(base.company.domain)]: JSON.stringify({ id, verdict: 'backlog', at: checkedAt }) } : {}) });
        await mark('backlog', reason, { id });
        return { verdict: 'backlog', reason, id, detail };
    };

    // Who the company is, on proof only (PM, 2026-10-27). For a Google Jobs listing the proof is Google's
    // own business listing under the same name in the same state; a search that could not run is retried.
    // A listing that names the employer's own website (Workable) is proven by that website, with no search at all.
    const ident = gj ? await profileIdentity(posting, deps) : await resolveIdentity(posting, deps);
    if (ident.error) return { verdict: 'error', reason: ident.noBudget ? 'no_budget' : 'lookup_unavailable', detail: ident.error };
    if (ident.competitor) { await kv.hset(HK.companies, { [bk]: JSON.stringify({ verdict: 'excluded', at: checkedAt }) }); await mark('excluded', 'competitor', { detail: ident.unresolved }); return { verdict: 'excluded', reason: 'competitor', detail: ident.unresolved }; }
    if (ident.large) { await kv.hset(HK.companies, { [bk]: JSON.stringify({ verdict: 'large', at: checkedAt }) }); await mark('excluded', 'large_employer', { detail: ident.unresolved }); return { verdict: 'excluded', reason: 'large_employer', detail: ident.unresolved }; }
    if (!ident.ok) return toBacklog('identity_unresolved', ident.unresolved, { missing: gj ? ['business listing', 'phone'] : ['website', 'phone'], identityTried: ident.tried });
    const company = { ...base.company, website: ident.website || null, domain: ident.domain || null, address: ident.address || null, identity: { how: ident.how, evidenceUrl: ident.evidenceUrl, listingName: ident.listingName || null, listingType: ident.listingType || null, checkedAt } };
    base.company = company;
    // A Google listing is proof of the employer only when it is the employer: not a chain's store page,
    // not a branch, not a listing with no website, not an office in another city for a remote post.
    if (gj) {
        const le = listingEvidence({ company: posting.company, website: ident.website, domain: ident.domain, listingName: ident.listingName, listingType: ident.listingType, address: ident.address, jobLocation: posting.location, remote: remotePost({ title: posting.title, location: posting.location, extensions: p.listing.extensions }) });
        if (le && le.action === 'exclude') { await kv.hset(HK.companies, { [bk]: JSON.stringify({ verdict: le.reason === 'competitor' ? 'excluded' : 'large', at: checkedAt }) }); await mark('excluded', le.reason, { detail: le.detail }); return { verdict: 'excluded', reason: le.reason, detail: le.detail }; }
        if (le) return toBacklog(le.reason, le.detail, { company, missing: ['employer proof'] });
    }
    // One card per employer, not per board: a second board or a new ATS at a confirmed domain joins the card
    // already there, and a domain that was stopped, a client or in research stays that way.
    const byDomain = ident.domain ? parseValue(await kv.hget(HK.companies, domainKey(ident.domain))) : null;
    if (byDomain && byDomain.id && byDomain.id !== id) {
        if (['client', 'in_outreach', 'suppressed'].includes(byDomain.verdict)) { await kv.hset(HK.companies, { [bk]: JSON.stringify({ ...byDomain, via: 'domain', at: checkedAt }) }); await mark('excluded', 'company_' + byDomain.verdict); return { verdict: 'excluded', reason: 'company_' + byDomain.verdict }; }
        const other = await getRecord(kv, byDomain.id);
        if (other) {
            if (!(other.jobs || []).some(x => x.url === job.url)) { other.jobs = [...(other.jobs || []), job]; other.brief = briefFor(other); await putRecord(kv, other); }
            await kv.hset(HK.companies, { [bk]: JSON.stringify({ id: other.id, verdict: 'ready', via: 'domain', at: checkedAt }) });
            await mark('merged', 'same_domain', { id: other.id });
            return { verdict: 'merged', reason: 'same_domain', id: other.id };
        }
        if (byDomain.verdict === 'backlog' && !provenance.retry) { await mark('merged', 'company_in_research', { id: byDomain.id }); return { verdict: 'merged', reason: 'company_in_research', id: byDomain.id }; }
    }
    if (byDomain && !byDomain.id && ['client', 'in_outreach', 'suppressed'].includes(byDomain.verdict)) { await mark('excluded', 'company_' + byDomain.verdict); return { verdict: 'excluded', reason: 'company_' + byDomain.verdict }; }

    // Booked a Discovery call (api/_booked-leads.js): the employer is a conversation now, never a cold card.
    if (deps.bookedIdentity && ident.domain) {
        let hit; try { hit = await deps.bookedIdentity({ domain: ident.domain }); } catch { return { verdict: 'error', reason: 'lookup_unavailable', detail: 'The booked-call list could not be read.' }; }
        if (hit) { await kv.hset(HK.companies, { [bk]: JSON.stringify({ verdict: 'in_outreach', via: 'booked', at: checkedAt }) }); await mark('excluded', 'booked_call'); return { verdict: 'excluded', reason: 'booked_call' }; }
    }
    // Already being worked anywhere in Staffify outreach: never a second, colder touch.
    if (ident.domain && deps.outreachDomains && deps.outreachDomains.has(ident.domain)) { await kv.hset(HK.companies, { [bk]: JSON.stringify({ verdict: 'in_outreach', at: checkedAt }), [domainKey(ident.domain)]: JSON.stringify({ verdict: 'in_outreach', at: checkedAt }) }); await mark('excluded', 'already_in_outreach'); return { verdict: 'excluded', reason: 'already_in_outreach' }; }
    // A client, by company name, before any credit is spent.
    const byCompany = await deps.clientCheck({ email: null, company: posting.company }).catch(() => ({ status: 'unknown' }));
    if (byCompany.status === 'client') { await kv.hset(HK.companies, { [bk]: JSON.stringify({ verdict: 'client', at: checkedAt }), ...(ident.domain ? { [domainKey(ident.domain)]: JSON.stringify({ verdict: 'client', at: checkedAt }) } : {}) }); await mark('excluded', 'client'); return { verdict: 'excluded', reason: 'client' }; }
    if (byCompany.status === 'possible') return toBacklog('possible_client', byCompany.reason || 'The company name matches an existing client. A person checks before it is called.', { missing: ['client check'] });
    if (byCompany.status !== 'clear') return toBacklog('client_check_unavailable', byCompany.why || 'The client list could not be read, so this is not called yet.', { missing: ['client check'] });

    // The number: from their Google business listing, else published on their own site. A site already read to prove the
    // employer (listing_website) is read once: the number search reuses its homepage and every page it opens.
    const memo = new Map(ident.page ? [[ident.website, Promise.resolve(ident.page)]] : []);
    const fetchSite = ident.page ? u => { if (!memo.has(u)) memo.set(u, Promise.resolve().then(() => deps.getPage(u))); return memo.get(u); } : deps.getPage;
    let listed = gj && ident.phone ? { phone: ident.phone, alternates: [], sourceUrl: ident.evidenceUrl, context: 'Google business listing for ' + (ident.listingName || posting.company), checkedAt, source: 'Google business listing' } : null;
    if (listed && ident.website && job.city) {
        const loc = await localNumber({ website: ident.website, city: job.city, getPage: deps.getPage }).catch(() => null);
        if (loc && loc.phone !== listed.phone) listed = { phone: loc.phone, alternates: [listed.phone], sourceUrl: loc.sourceUrl, context: loc.context, checkedAt: loc.checkedAt, source: 'business website', local: true };
    }
    let phone = listed || (ident.website ? await deps.findSitePhone({ website: ident.website, fetchSite, maxPages: 4 }).catch(() => null) : null);
    // A listing proven by its own website (Workable): the number is that site's, free. The line it publishes next to the
    // job's city goes first (PM, 2026-10-28, Damotech), the site's others behind it, and it is marked as read from the site.
    if (gj && ident.how === 'listing_website') {
        const loc = job.city ? await localNumber({ website: ident.website, city: job.city, getPage: fetchSite }).catch(() => null) : null;
        if (loc) phone = { phone: loc.phone, alternates: [phone && phone.phone, ...((phone && phone.alternates) || [])].filter((n, i, a) => n && n !== loc.phone && a.indexOf(n) === i), sourceUrl: loc.sourceUrl, context: loc.context, checkedAt: loc.checkedAt, source: 'business website', local: true };
        if (phone && phone.phone) phone = { ...phone, siteCheck: { at: checkedAt, result: loc ? 'local_number' : 'site_only' } };
        // No usable number on their site: research now, before the paid contact search (a Findymail credit for a domain
        // that never became a card, nine times in the 2026-10-30 dry run). A toll-free line still goes on to a held card.
        const bad0 = await deps.loadBad(kv, id).catch(() => new Set());
        if (!(phone && phone.phone && [phone.phone, ...(phone.alternates || [])].some(n => !deps.isBad(bad0, n))))
            return toBacklog('no_listed_phone', phone && phone.phone ? 'Every listed number was logged as wrong.' : 'No phone number is published on ' + ident.domain + '.', { company, contact: { status: 'not_searched', reason: 'No usable number on their website, so no contact search was paid for.', checkedAt } });
    }
    if (gj && listed && listed.local) phone = { ...listed, siteCheck: { at: checkedAt, result: 'local_number' } };
    else if (gj && listed && ident.website) {
        const chk = await siteCheck({ website: ident.website, domain: ident.domain, getPage: deps.getPage, findSitePhone: deps.findSitePhone });
        if (chk.moved) return toBacklog('website_unconfirmed', `Their website now goes to ${chk.moved}, not ${ident.domain}, so the employer cannot be confirmed.`, { company, missing: ['website'] });
        const a = alignNumbers(listed.phone, listed.alternates, chk);
        // An unreadable site is not a verdict: no note, so the hourly re-check tries again.
        const siteCheckNote = a.result === 'unreadable' ? null : { at: checkedAt, result: a.result };
        phone = a.result === 'replaced' || a.result === 'alternate_on_site'
            ? { phone: a.primary, alternates: a.alternates, sourceUrl: a.site && a.site.sourceUrl || ident.website, context: a.site && a.site.context || null, checkedAt, source: 'business website', siteCheck: siteCheckNote, previous: { number: listed.phone, source: listed.source } }
            : { ...listed, ...(siteCheckNote ? { siteCheck: siteCheckNote } : {}) };
    }
    // The contact: Findymail's domain search, then its verifier. Optional; recorded either way.
    let contact = null;
    try {
        const c = ident.domain ? await deps.findContact(ident.domain) : { notSearched: true };
        if (c && c.notSearched) contact = { status: 'not_searched', reason: 'Their Google listing names no website to search.', checkedAt };
        else if (c && c.error) contact = { status: 'lookup_failed', reason: c.error, checkedAt };
        else if (c && c.email && !FREE_MAIL.test(c.email) && c.email.split('@')[1] === ident.domain) {
            const v = await deps.verifyEmail(c.email).catch(() => ({ status: 'unavailable' }));
            contact = { name: c.name || null, firstName: firstNameOf(c.name), role: c.role || null, email: v.status === 'verified' ? c.email : null, candidateEmail: c.email, status: v.status, provider: v.provider || null, source: 'Findymail domain search', verifiedBy: 'Findymail verifier', checkedAt: v.checkedAt || checkedAt };
        } else contact = { status: 'not_found', reason: 'Findymail returned no contact on ' + ident.domain, checkedAt };
    } catch (e) { contact = { status: 'lookup_failed', reason: String(e.message || e).slice(0, 120), checkedAt }; }

    // Exclusions on the person and the number.
    const email = contact && contact.email;
    if (email && deps.bookedIdentity) {
        let hit; try { hit = await deps.bookedIdentity({ email }); } catch { return toBacklog('crm_unavailable', 'The booked-call list could not be read.', { missing: ['booking check'], company, contact }); }
        if (hit) { await mark('excluded', 'booked_call'); return { verdict: 'excluded', reason: 'booked_call' }; }
    }
    if (email) {
        if (await deps.isOptedOut({ email })) { await mark('excluded', 'opted_out'); return { verdict: 'excluded', reason: 'opted_out' }; }
        const byEmail = await deps.clientCheck({ email, company: posting.company }).catch(() => ({ status: 'unknown' }));
        if (byEmail.status === 'client') { await kv.hset(HK.companies, { [bk]: JSON.stringify({ verdict: 'client', at: checkedAt }), ...(ident.domain ? { [domainKey(ident.domain)]: JSON.stringify({ verdict: 'client', at: checkedAt }) } : {}) }); await mark('excluded', 'client'); return { verdict: 'excluded', reason: 'client' }; }
        let props = null, crmError = null;
        try { const c = await deps.crmContact(email); props = c && c.properties || null; } catch (e) { if (!/CRM contact missing/.test(String(e && e.message))) crmError = String(e.message || e).slice(0, 80); }
        if (crmError) return toBacklog('crm_unavailable', 'HubSpot could not be checked: ' + crmError, { missing: ['CRM check'], company, contact });
        const stop = deps.crmStop(props);
        if (stop) { await mark('excluded', 'crm_stop', { detail: stop }); return { verdict: 'excluded', reason: 'crm_stop', detail: stop }; }
    }
    const bad = await deps.loadBad(kv, id).catch(() => new Set());
    let usable = phone && phone.phone ? [phone.phone, ...(phone.alternates || [])].filter(n => !deps.isBad(bad, n)) : [];
    const tollOnly = usable.length > 0 && usable.every(tollFree);
    if (!tollOnly) usable = usable.filter(n => !tollFree(n));
    // The listing's number was logged as wrong: their own website may publish another.
    if (!usable.length && listed && ident.website) {
        const site = await deps.findSitePhone({ website: ident.website, fetchSite: deps.getPage, maxPages: 4 }).catch(() => null);
        if (site && site.phone && !tollFree(site.phone)) { phone = { ...site, source: 'business website' }; usable = [site.phone, ...(site.alternates || [])].filter(n => !deps.isBad(bad, n) && !tollFree(n)); }
    }
    if (!phone || !phone.phone) return toBacklog('no_listed_phone', 'No phone number is published ' + (ident.domain ? 'on ' + ident.domain : 'on their Google listing') + '.', { company, contact });
    if (!usable.length) return toBacklog('no_listed_phone', 'Every listed number was logged as wrong.', { company, contact });
    for (const n of usable) if (await deps.isOptedOut({ phone: n })) { await mark('excluded', 'opted_out'); return { verdict: 'excluded', reason: 'opted_out' }; }
    // One card per business: a number already on another card (a name variant, a second board) is that card.
    const byPhone = usable.length ? parseValue(await kv.hget(HK.companies, phoneKey(usable[0]))) : null;
    if (byPhone && byPhone.id && byPhone.id !== id) {
        if (['client', 'in_outreach', 'suppressed'].includes(byPhone.verdict)) { await mark('excluded', 'company_' + byPhone.verdict); return { verdict: 'excluded', reason: 'company_' + byPhone.verdict }; }
        const other = await getRecord(kv, byPhone.id);
        if (other) {
            if (!(other.jobs || []).some(x => x.url === job.url)) { other.jobs = [...(other.jobs || []), job]; other.brief = briefFor(other); await putRecord(kv, other); }
            await kv.hset(HK.companies, { [bk]: JSON.stringify({ id: other.id, verdict: 'ready', via: 'phone', at: checkedAt }) });
            await mark('merged', 'same_number', { id: other.id });
            return { verdict: 'merged', reason: 'same_number', id: other.id };
        }
    }

    const rec = {
        ...base, company, contact,
        phone: { number: usable[0], alternates: usable.slice(1), source: phone.source || 'business website', sourceUrl: phone.sourceUrl, context: phone.context || null, checkedAt: phone.checkedAt || checkedAt, type: phone.source === 'Google business listing' ? 'main line on their Google business listing' : phone.local ? 'company line for this location, from their own website' : 'company line listed on their website', owner: 'the company, not a named person', ...(gj ? { localCheckedAt: checkedAt } : {}), ...(phone.siteCheck ? { siteCheck: phone.siteCheck } : {}), ...(phone.previous ? { previous: phone.previous } : {}) },
        status: 'ready', callOutcome: null, nextCallAt: null, callOwner: null, callHistory: [],
    };
    // A wrong number re-researched: same card, same history and owner; the new number is a new lead to ring.
    if (existing) Object.assign(rec, { createdAt: existing.createdAt, callHistory: existing.callHistory || [], callOwner: existing.callOwner || null, callOwnerAt: existing.callOwnerAt || null, jobs: existing.jobs && existing.jobs.length ? existing.jobs : rec.jobs, provenance: existing.provenance || rec.provenance });
    rec.priority = priorityOf({ age: q.age, restrictions: q.restrictions, openRoles: posting.openRoles, contact });
    if (tollOnly) Object.assign(rec, { status: 'research', hold: { reason: 'toll_free_only', detail: 'The only number they publish is toll-free, a switchboard we do not call. The owner\'s cell is looked up next.', at: checkedAt, by: 'admission' } });
    rec.brief = briefFor(rec);
    // A wrong-number retry rebuilds the card: if it was booked or closed meanwhile, that stands.
    if (existing) { const now2 = await getRecord(kv, id); if (now2 && (now2.booking || now2.status !== existing.status)) { await mark('merged', 'changed_meanwhile', { id }); return { verdict: 'merged', reason: 'changed_meanwhile', id }; } }
    await putRecord(kv, rec);
    await kv.hdel(HK.backlog, id).catch(() => {});
    await kv.hset(HK.companies, { [bk]: JSON.stringify({ id, verdict: 'ready', at: checkedAt }), [phoneKey(rec.phone.number)]: JSON.stringify({ id, verdict: 'ready', at: checkedAt }), ...(company.domain ? { [domainKey(company.domain)]: JSON.stringify({ id, verdict: 'ready', at: checkedAt }) } : {}) });
    await mark('ready', 'ready', { id });
    if (report && report.samples.length < 3) report.samples.push({ id, company: company.name, job: job.title, jobUrl: job.url, postedAt: job.postedAt, website: company.website, identity: company.identity.how, phoneSource: rec.phone.sourceUrl, contact: contact && contact.name ? contact.name + (contact.role ? ', ' + contact.role : '') + ' (' + contact.status + ')' : (contact && contact.status) });
    return { verdict: 'ready', id, record: rec };
}

// ---- a lead a person researched ------------------------------------------------------------------
/**
 * Madison's list and anything like it (api/_hiring-intent.js qualifyLead). No search credit: the lead
 * names the business, its website and a number. Every stop a found posting meets still applies: a known
 * company verdict, the domain and the number already on a card, Staffify outreach, a booked call, a
 * client, the opt-out list, the CRM, bad numbers. The owner's name and email go on the card as the contact.
 */
// Cards that wait for the owner's cell: a toll-free line (no number to call). A main line is called since 2026-10-30
// (see MAIN_LINE in _hiring-intent.js); a card still held on one is released by refreshReady.
export { MAIN_LINE };
const HELD_FOR_CELL = new Set(['toll_free_only']);
/**
 * The business's line has failed, so the owner's cell is worth a RocketReach lookup (Paul, 2026-10-30: lookups only
 * "when that line fails"): a gatekeeper or phone menu twice, or the number logged as wrong.
 */
export const lineFailed = r => { const h = (r && r.callHistory) || []; return h.filter(x => x && x.outcome === 'gatekeeper').length >= 2 || (h.length > 0 && h[h.length - 1].outcome === 'wrong_number'); };
export const heldForCell = r => !!(r && r.status === 'research' && r.hold && HELD_FOR_CELL.has(r.hold.reason));

export async function processLead(p, provenance, deps, report) {
    const { kv } = deps;
    const now = deps.now || Date.now();
    const l = p.lead || {};
    const key = p.key || leadKey(l);
    const checkedAt = new Date(now).toISOString();
    const source = String(provenance.source || 'our team');
    const seen = parseValue(await kv.hget(HK.seen, key));
    if (seen && !provenance.retry) return { verdict: 'seen', reason: seen.verdict };
    const mark = async (verdict, reason, extra = {}) => { await kv.hset(HK.seen, { [key]: JSON.stringify({ at: checkedAt, verdict, reason, company: l.business || null, title: l.role_posted || null, url: l.posting_url || null, source, ...extra }) }); };
    const q = qualifyLead(l, now);
    if (!q.ok) { await mark('excluded', q.reason, { detail: q.detail }); return { verdict: 'excluded', reason: q.reason, detail: q.detail }; }
    // A lead whose number is labelled the company's main line. A card it merges into learns that line is a main line;
    // refreshReady then takes it off that card (or holds the card for the owner's cell), under the card's lock.
    const [leadMain] = mainNumbers({ lead: l });
    const noteMain = card => { if (!leadMain || (card.mainLines || []).includes(leadMain)) return false; card.mainLines = [...(card.mainLines || []), leadMain]; return true; };
    const bk = companyKey(l.business, q.usState ? ', ' + q.usState : '');
    const id = idFor(bk);
    const via = (() => { try { return new URL(l.posting_url).hostname.replace(/^(www|app|jobs)\./, ''); } catch { return null; } })();
    const job = { source: 'provided', title: String(l.role_posted).trim(), url: l.posting_url || null, applyUrl: l.posting_url || null, via, postedAt: q.postedAt, postedLabel: leadDateLabel(l), ageDays: q.age, checkedAt, location: q.location, city: q.city, usState: q.usState, workplace: q.workplace, restrictions: q.restrictions, foundBy: source };
    const known = parseValue(await kv.hget(HK.companies, bk));
    if (known && ['client', 'in_outreach', 'suppressed', 'large'].includes(known.verdict)) { await mark('excluded', 'company_' + known.verdict); return { verdict: 'excluded', reason: 'company_' + known.verdict }; }
    const existing = await getRecord(kv, id);
    if (existing && !(existing.status === 'number_research' && provenance.retry)) {
        const newJob = !(existing.jobs || []).some(x => x.url === job.url && x.title === job.title);
        if (newJob) existing.jobs = [...(existing.jobs || []), job];
        if (noteMain(existing) || newJob) { existing.brief = briefFor(existing); await putRecord(kv, existing); }
        await mark('merged', 'same_company', { id });
        return { verdict: 'merged', id };
    }
    const domain = l.website ? leadDomain(l.website) : null;
    const website = l.website ? String(l.website).trim() : null;
    const company = { name: String(l.business).trim(), board: bk, openRoles: null, website, domain, address: null, identity: { how: 'provided', source, evidenceUrl: l.email_source_url || website || l.posting_url || null, checkedAt } };
    const base = { id, campaignId: HIRING_ID, family: q.family, lead: l, company, job, jobs: [job], provenance: { ...provenance, postingKey: key, verifiedVia: `${source}'s research${via ? ', post on ' + via : ''}`, firstCheckedAt: checkedAt }, createdAt: checkedAt, updatedAt: checkedAt };
    const toBacklog = async (reason, detail, extra = {}) => {
        const prev = parseValue(await kv.hget(HK.backlog, id));
        const attempts = (prev && prev.attempts || 0) + 1;
        await putBacklog(kv, { ...(prev || {}), ...base, ...extra, reason, detail, missing: extra.missing || ['phone'], attempts, state: nextTry(attempts, now) ? 'open' : 'exhausted', firstSeenAt: prev && prev.firstSeenAt || checkedAt, lastTriedAt: checkedAt, nextTryAt: nextTry(attempts, now) });
        await kv.hset(HK.companies, { [bk]: JSON.stringify({ id, verdict: 'backlog', at: checkedAt }) });
        await mark('backlog', reason, { id });
        return { verdict: 'backlog', reason, id, detail };
    };
    if (domain) {
        const byDomain = parseValue(await kv.hget(HK.companies, domainKey(domain)));
        if (byDomain && ['client', 'in_outreach', 'suppressed', 'large'].includes(byDomain.verdict)) { await mark('excluded', 'company_' + byDomain.verdict); return { verdict: 'excluded', reason: 'company_' + byDomain.verdict }; }
        if (byDomain && byDomain.id && byDomain.id !== id) { const other = await getRecord(kv, byDomain.id); if (other) { const newJob = !(other.jobs || []).some(x => x.url === job.url); if (newJob) other.jobs = [...(other.jobs || []), job]; if (noteMain(other) || newJob) { other.brief = briefFor(other); await putRecord(kv, other); } await mark('merged', 'same_domain', { id: other.id }); return { verdict: 'merged', reason: 'same_domain', id: other.id }; } }
        if (deps.outreachDomains && deps.outreachDomains.has(domain)) { await mark('excluded', 'already_in_outreach'); return { verdict: 'excluded', reason: 'already_in_outreach' }; }
    }
    const email = String(l.owner_email || '').trim().toLowerCase() || null;
    if (deps.bookedIdentity) {
        let hit; try { hit = await deps.bookedIdentity({ email, domain }); } catch { return { verdict: 'error', reason: 'lookup_unavailable', detail: 'The booked-call list could not be read.' }; }
        if (hit) { await mark('excluded', 'booked_call'); return { verdict: 'excluded', reason: 'booked_call' }; }
    }
    const byCompany = await deps.clientCheck({ email, company: company.name }).catch(() => ({ status: 'unknown' }));
    if (byCompany.status === 'client') { await kv.hset(HK.companies, { [bk]: JSON.stringify({ verdict: 'client', at: checkedAt }) }); await mark('excluded', 'client'); return { verdict: 'excluded', reason: 'client' }; }
    if (byCompany.status === 'possible') return toBacklog('possible_client', byCompany.reason || 'The company matches an existing client. A person checks before it is called.', { missing: ['client check'] });
    if (byCompany.status !== 'clear') return toBacklog('client_check_unavailable', byCompany.why || 'The client list could not be read, so this is not called yet.', { missing: ['client check'] });
    if (email) {
        if (await deps.isOptedOut({ email })) { await mark('excluded', 'opted_out'); return { verdict: 'excluded', reason: 'opted_out' }; }
        let props = null, crmError = null;
        try { const c = await deps.crmContact(email); props = c && c.properties || null; } catch (e) { if (!/CRM contact missing/.test(String(e && e.message))) crmError = String(e.message || e).slice(0, 80); }
        if (crmError) return toBacklog('crm_unavailable', 'HubSpot could not be checked: ' + crmError, { missing: ['CRM check'] });
        const stop = deps.crmStop(props);
        if (stop) { await mark('excluded', 'crm_stop', { detail: stop }); return { verdict: 'excluded', reason: 'crm_stop', detail: stop }; }
    }
    // The number: the one in the lead, checked against their own website when they have one (free).
    // A number looked up for a named person (fillResearch below) stays first, because it reaches the owner
    // where a website's number reaches the front desk; the website's numbers ride along as alternates.
    const d = digits10(l.phone);
    const vendor = String(l.phone_source || '').trim() || null;
    const personNums = vendor ? [d, ...String(l.phone_alternates || '').split(/[,;\s]+/).map(digits10)].filter((x, i, a) => x.length === 10 && a.indexOf(x) === i && !tollFree(x)).map(x => '+1' + x) : [];
    // The business's own published line, seen by whoever checked the lookup, rides last as the company's.
    const publicNum = vendor && digits10(l.public_phone).length === 10 ? '+1' + digits10(l.public_phone) : null;
    let phone = d.length !== 10 ? null
        : vendor ? { phone: '+1' + d, alternates: [...personNums.slice(1), ...(publicNum && !personNums.includes(publicNum) ? [publicNum] : [])], source: 'vendor', vendor, person: String(l.phone_person || '').trim() || null, lineType: String(l.phone_type || '').trim() || null, grade: String(l.phone_grade || '').trim() || null, sourceUrl: l.phone_source_url || null, context: `Looked up on ${vendor}`, checkedAt: l.phone_checked_at || checkedAt }
        : { phone: '+1' + d, alternates: [], source: 'provided', sourceUrl: l.email_source_url || website || null, context: `From ${source}'s research`, checkedAt };
    if (domain && website) {
        const chk = await siteCheck({ website, domain, getPage: deps.getPage, findSitePhone: deps.findSitePhone });
        if (chk.moved) return toBacklog('website_unconfirmed', `Their website now goes to ${chk.moved}, not ${domain}, so the business cannot be confirmed.`, { missing: ['website'] });
        // A line we were told is the person's own (looked up, or labelled mobile, cell or direct) stays first. Behind a
        // looked-up number the website's lines ride along; behind a labelled one they do not (Paul: no main lines).
        const personal = !vendor && !leadMain && /\b(mobile|cell|direct)\b/i.test(String(l.phone_type || ''));
        if (phone && (vendor || personal)) {
            const onSite = chk.unreadable ? [] : chk.numbers || [];
            phone = { ...phone, alternates: [...phone.alternates, ...(vendor ? onSite : [])].filter((n, i, a) => n !== phone.phone && a.indexOf(n) === i).slice(0, 4), ...(chk.unreadable ? {} : { siteCheck: { at: checkedAt, result: onSite.includes(phone.phone) ? 'confirmed' : onSite.length ? 'person_line' : 'none_published' } }) };
        } else if (phone) {
            const a = alignNumbers(phone.phone, [], chk);
            phone = a.result === 'replaced' || a.result === 'alternate_on_site'
                ? { phone: a.primary, alternates: a.alternates, source: 'business website', sourceUrl: a.site && a.site.sourceUrl || website, context: a.site && a.site.context || null, checkedAt, previous: { number: '+1' + d, source: 'provided' }, siteCheck: { at: checkedAt, result: a.result } }
                : { ...phone, ...(a.result === 'unreadable' ? {} : { siteCheck: { at: checkedAt, result: a.result } }) };
        } else if (chk.site && chk.site.phone) phone = { phone: chk.site.phone, alternates: (chk.numbers || []).filter(n => n !== chk.site.phone).slice(0, 3), source: 'business website', sourceUrl: chk.site.sourceUrl || website, context: chk.site.context || null, checkedAt, siteCheck: { at: checkedAt, result: 'site_only' } };
    }
    if (!phone) return toBacklog('no_listed_phone', `No number in the lead${domain ? ' and none published on ' + domain : ''}.`);
    const bad = await deps.loadBad(kv, id).catch(() => new Set());
    let usable = [phone.phone, ...(phone.alternates || [])].filter(n => !deps.isBad(bad, n));
    if (!usable.length) return toBacklog('no_listed_phone', 'Every number on file was logged as wrong.');
    const tollOnly = usable.every(tollFree);
    if (!tollOnly) usable = usable.filter(n => !tollFree(n));
    const mainOnly = !vendor && !!leadMain;
    for (const n of usable) if (await deps.isOptedOut({ phone: n })) { await mark('excluded', 'opted_out'); return { verdict: 'excluded', reason: 'opted_out' }; }
    const byPhone = parseValue(await kv.hget(HK.companies, phoneKey(usable[0])));
    if (byPhone && byPhone.id && byPhone.id !== id) {
        if (['client', 'in_outreach', 'suppressed'].includes(byPhone.verdict)) { await mark('excluded', 'company_' + byPhone.verdict); return { verdict: 'excluded', reason: 'company_' + byPhone.verdict }; }
        const other = await getRecord(kv, byPhone.id);
        if (other) { const newJob = !(other.jobs || []).some(x => x.url === job.url); if (newJob) other.jobs = [...(other.jobs || []), job]; if (noteMain(other) || newJob) { other.brief = briefFor(other); await putRecord(kv, other); } await mark('merged', 'same_number', { id: other.id }); return { verdict: 'merged', reason: 'same_number', id: other.id }; }
    }
    // The owner as the contact. A provided email is verified before it is shown as one to write to.
    const first = String(l.owner_first || '').trim(), last = String(l.owner_last || '').trim();
    let contact = { status: 'not_found', reason: 'The lead names no owner.', checkedAt };
    if (first || email) {
        let v = { status: 'unverified' };
        if (email && !FREE_MAIL.test(email) && deps.verifyEmail) v = await deps.verifyEmail(email).catch(() => ({ status: 'unavailable' }));
        contact = { name: [first, last].filter(Boolean).join(' ') || null, firstName: firstNameOf(first), role: String(l.owner_title || '').trim() || null, email: v.status === 'verified' ? email : null, candidateEmail: email, status: email ? v.status : 'named', provider: v.provider || null, source: l.contact_source ? `${l.contact_source} lookup` : `${source}'s research`, sourceUrl: l.email_source_url || null, verifiedBy: email ? 'Findymail verifier' : null, checkedAt: v.checkedAt || checkedAt };
    }
    // A looked-up person's number logged as wrong leaves the next one up: another of theirs says so, and a line
    // the business publishes (its website, or the page the checker saw) is labelled as the company's, from there.
    const isPerson = phone.source === 'vendor' && personNums.includes(usable[0]);
    const published = phone.source === 'vendor' && !isPerson;
    const lineType = isPerson ? (usable[0] === phone.phone ? phone.lineType : 'other number') : null;
    const rec = {
        ...base, contact,
        phone: { number: usable[0], alternates: usable.slice(1), source: published ? 'business website' : phone.source, foundBy: source, ...(isPerson ? { vendor: phone.vendor, person: phone.person, lineType, grade: usable[0] === phone.phone ? phone.grade : null } : {}), sourceUrl: published ? (usable[0] === publicNum ? l.public_phone_url || website || null : website) : phone.sourceUrl, context: published ? 'A line the business publishes' : phone.context || null, checkedAt: phone.checkedAt || checkedAt, type: isPerson ? `${phone.person ? phone.person + '\'s ' : ''}${lineType || 'number'} from ${phone.vendor}` : published ? 'company line the business publishes' : phone.source === 'provided' ? `number from ${source}'s research` : 'company line listed on their website', owner: isPerson && phone.person ? phone.person : 'the company, not a named person', localCheckedAt: checkedAt, ...(phone.siteCheck ? { siteCheck: phone.siteCheck } : {}), ...(phone.previous ? { previous: phone.previous } : {}) },
        status: 'ready', callOutcome: null, nextCallAt: null, callOwner: null, callHistory: [],
    };
    if (existing) Object.assign(rec, { createdAt: existing.createdAt, callHistory: existing.callHistory || [], callOwner: existing.callOwner || null, callOwnerAt: existing.callOwnerAt || null, jobs: existing.jobs && existing.jobs.length ? existing.jobs : rec.jobs, provenance: existing.provenance || rec.provenance });
    rec.priority = priorityOf({ age: q.age, restrictions: q.restrictions, openRoles: null, contact });
    if (tollOnly) Object.assign(rec, { status: 'research', hold: { reason: 'toll_free_only', detail: 'The only number they publish is toll-free, a switchboard we do not call. The owner\'s cell is looked up next.', at: checkedAt, by: 'admission' } });
    else if (mainOnly) rec.phone = { ...rec.phone, type: 'the company\'s main line: ask for the owner' };
    rec.brief = briefFor(rec);
    if (existing) { const now2 = await getRecord(kv, id); if (now2 && (now2.booking || now2.status !== existing.status)) { await mark('merged', 'changed_meanwhile', { id }); return { verdict: 'merged', reason: 'changed_meanwhile', id }; } }
    await putRecord(kv, rec);
    await kv.hdel(HK.backlog, id).catch(() => {});
    await kv.hset(HK.companies, { [bk]: JSON.stringify({ id, verdict: 'ready', at: checkedAt }), [phoneKey(rec.phone.number)]: JSON.stringify({ id, verdict: 'ready', at: checkedAt }), ...(domain ? { [domainKey(domain)]: JSON.stringify({ id, verdict: 'ready', at: checkedAt }) } : {}) });
    await mark('ready', 'ready', { id });
    if (report && report.samples.length < 3) report.samples.push({ id, company: company.name, job: job.title, jobUrl: job.url, source, phoneSource: rec.phone.source, contact: contact.name ? contact.name + (contact.role ? ', ' + contact.role : '') + ' (' + contact.status + ')' : contact.status });
    return { verdict: 'ready', id, record: rec };
}

// ---- the pending queue ------------------------------------------------------------------------
// PM, 2026-10-27: paid search results beyond the run's cap "are counted deferred then discarded,
// and seeds are LREM'd before processing, so a fetch error/crash can lose work." Every posting a
// search or a person hands in is written here FIRST, and leaves only once its verdict (ready,
// research, excluded, merged, already seen) is saved. A crash mid-posting leaves it here for the
// next run; a transient error keeps it here with a count; repeated errors become a research entry.
export const PENDING_MAX_ATTEMPTS = 4;
export async function addPending(kv, p, provenance, now = Date.now()) {
    const key = p.kind === 'gjob' || p.kind === 'lead' ? p.key : postingKey(p);
    const entry = p.kind === 'lead'
        ? { key, kind: 'lead', lead: p.lead, url: p.lead.posting_url || null, provenance, attempts: 0, addedAt: new Date(now).toISOString(), nextTryAt: new Date(now).toISOString() }
        : p.kind === 'gjob'
        ? { key, kind: 'gjob', listing: p.listing, url: p.listing.share_link || null, provenance, attempts: 0, addedAt: new Date(now).toISOString(), nextTryAt: new Date(now).toISOString() }
        : { key, url: p.url || null, ats: p.ats, board: p.board, id: p.id, provenance, attempts: 0, addedAt: new Date(now).toISOString(), nextTryAt: new Date(now).toISOString() };
    // HSETNX: a posting already waiting keeps its own history and provenance.
    await kv.hsetnx(HK.pending, key, JSON.stringify(entry));
    return key;
}
export async function pendingDue(kv, now = Date.now()) {
    const all = (await kv.hgetall(HK.pending)) || {};
    return Object.values(all).map(parseValue).filter(e => e && Date.parse(e.nextTryAt || 0) <= now)
        // A person's seed first, then the oldest.
        .sort((a, b) => Number(!!(b.provenance && b.provenance.seed)) - Number(!!(a.provenance && a.provenance.seed)) || Date.parse(a.addedAt) - Date.parse(b.addedAt));
}
const DURABLE = new Set(['ready', 'backlog', 'excluded', 'merged', 'seen']);

/** One pending posting through processPosting; removed from pending only on a saved verdict. */
async function settle(entry, deps, report) {
    const { kv } = deps;
    const now = deps.now || Date.now();
    let r;
    const ref = entry.kind === 'lead' ? { kind: 'lead', key: entry.key, lead: entry.lead } : entry.kind === 'gjob' ? { kind: 'gjob', key: entry.key, listing: entry.listing } : { ats: entry.ats, board: entry.board, id: entry.id };
    try { r = await processPosting(ref, entry.provenance || {}, deps, report); }
    catch (e) { r = { verdict: 'error', reason: 'run_error', detail: String((e && e.message) || e).slice(0, 120) }; }
    if (DURABLE.has(r.verdict)) { await kv.hdel(HK.pending, entry.key); return r; }
    // Out of searches for today is not a failed attempt: the listing waits, unchanged, for the next run.
    if (r.reason === 'no_budget') return r;
    const attempts = (entry.attempts || 0) + 1;
    if (attempts >= PENDING_MAX_ATTEMPTS) {
        // Not lost and not retried forever: a visible research entry a person can look at.
        const bk = entry.kind === 'lead' ? companyKey(entry.lead.business, entry.lead.state || entry.lead.city) : entry.kind === 'gjob' ? companyKey(entry.listing.company_name, entry.listing.location) : boardKey(entry);
        const id = idFor(bk);
        await putBacklog(kv, { id, campaignId: HIRING_ID, company: { name: entry.kind === 'gjob' ? entry.listing.company_name : entry.board, board: bk }, job: entry.kind === 'gjob' ? { source: 'google_jobs', title: entry.listing.title, url: entry.url || null } : { url: entry.url || null, ats: entry.ats, board: entry.board, postingId: entry.id }, ...(entry.kind === 'gjob' ? { listing: entry.listing } : {}), provenance: { ...(entry.provenance || {}), postingKey: entry.key }, reason: entry.kind === 'gjob' ? 'lookup_unavailable' : 'posting_unreadable', detail: entry.kind === 'gjob' ? (entry.listing.feed ? `The ${entry.listing.feed} listing could not be worked after ${attempts} tries: ${r.detail || r.reason}.` : `The Google business listing lookup failed after ${attempts} tries: ${r.detail || r.reason}.`) : `The posting could not be read after ${attempts} tries: ${r.detail || r.reason}.`, missing: ['posting'], attempts, state: 'exhausted', firstSeenAt: entry.addedAt, lastTriedAt: new Date(now).toISOString(), nextTryAt: null });
        await kv.hdel(HK.pending, entry.key);
        return { ...r, verdict: 'error', parked: true };
    }
    await kv.hset(HK.pending, { [entry.key]: JSON.stringify({ ...entry, attempts, lastError: r.detail || r.reason, lastTriedAt: new Date(now).toISOString(), nextTryAt: new Date(now + attempts * 3600e3).toISOString() }) });
    return r;
}

/** The first current rule an existing card fails, or null. Reads only what is stored. */
export async function recheck(rec, kv, now = Date.now()) {
    const name = rec.company && rec.company.name;
    const byName = companyExcluded(name, [rec.lead && rec.lead.industry, rec.lead && rec.lead.vertical, rec.company && rec.company.identity && rec.company.identity.listingType].filter(Boolean).join(' '));
    if (byName) return byName;
    if (rec.lead) {
        const q = qualifyLead(rec.lead, Date.parse(rec.job && rec.job.postedAt) || now);
        if (!q.ok && q.reason !== 'stale_post') return { reason: q.reason, detail: q.detail, from: 'post' };
        return null;
    }
    if (rec.job && rec.job.title && !roleFamily(rec.job.title)) return { reason: 'role_not_fillable', detail: `"${rec.job.title}" is not a seat a remote person fills under the current rules.` };
    if (rec.listing) {
        // Age is handled by expiry; every other listing rule is applied as if the listing were new.
        const q = qualifyJob({ ...rec.listing, posted_at: rec.job && rec.job.postedAt || rec.listing.posted_at }, now);
        if (!q.ok && !['stale_post', 'undated_post'].includes(q.reason)) return { reason: q.reason, detail: q.detail, from: 'post' };
    }
    if (rec.job && rec.job.source === 'google_jobs') {
        const cached = parseValue(await kv.get(HK.profile(companyKey(name, rec.job.location))).catch(() => null));
        const p = cached && cached.profile || {};
        if (/\b(hospital|medical\s+center|health\s+system|university|school\s+district|government\s+office)\b/i.test(String(p.type || (rec.company.identity && rec.company.identity.listingType) || ''))) return { reason: 'large_employer', detail: `Google lists them as a ${p.type || rec.company.identity.listingType}, a large employer.` };
        const sz = p.size || {};
        if ((sz.employees && sz.employees > LARGE_EMPLOYEES) || sz.listed || sz.parent) return { reason: 'large_employer', detail: "Google's company panel shows a large employer." };
        const c = rec.company || {}, id = c.identity || {}, l = rec.listing || {};
        const le = listingEvidence({ company: name, website: c.website, domain: c.domain, listingName: id.listingName, listingType: id.listingType || p.type, address: c.address, jobLocation: l.location || rec.job.location, remote: remotePost({ title: rec.job.title, location: l.location || rec.job.location, extensions: l.extensions }) });
        if (le) return le;
    }
    return null;
}

// ---- keeping ready cards honest ---------------------------------------------------------------
// PM, 2026-10-27: "A job that closes tomorrow can therefore remain callable forever." Each run
// re-reads the ready cards whose post was checked longest ago. Closed or past MAX_AGE_DAYS: the
// card stops being offered (api/_hiring-intent.js hiringCallReady) and keeps its owner, history
// and any promised time. A read that fails changes nothing and is tried again next run; the
// freshness gate keeps an unconfirmed card off the list meanwhile.
export async function refreshReady(deps, { limit = 12, report = null, siteChecks = 6 } = {}) {
    const { kv } = deps;
    const now = deps.now || Date.now();
    // First, so a card released here meets every pass below in this same run (the current rules, dates, lanes).
    let released = 0;
    // Paul, 2026-10-30: business lines are called at these small companies. A card still held on a main line from before
    // goes back on the list with that line, unless it has a callback or a caller already; nothing is looked up for it
    // until the line fails.
    for (const rec of (await allRecords(kv)).filter(r => r.status === 'research' && r.hold && r.hold.reason === 'main_line_only' && r.phone && r.phone.number && !tollFree(r.phone.number))) {
        const lock = HK.recLock(rec.id);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) continue;
        try {
            const fresh = await getRecord(kv, rec.id);
            if (!fresh || fresh.status !== 'research' || !fresh.hold || fresh.hold.reason !== 'main_line_only' || !fresh.phone || tollFree(fresh.phone.number)) continue;
            const at = new Date(now).toISOString();
            const next = { ...fresh, status: 'ready', hold: null, released: { from: 'main_line_only', at, why: 'Business lines are called at small companies (Paul, 2026-10-30)' }, phone: { ...fresh.phone, type: 'the company\'s main line: ask for the owner' } };
            next.brief = briefFor(next);
            await putRecord(kv, next);
            released++;
        } finally { await kv.del(lock).catch(() => {}); }
    }
    const live = (await allRecords(kv)).filter(r => r.status === 'ready' && r.job && r.job.state !== 'closed' && r.job.state !== 'stale');
    // Every Google Jobs card (a date check, free) and the ATS cards checked longest ago (a fetch each).
    const recs = [...live.filter(r => ageBased(r.job.source)), ...live.filter(r => !ageBased(r.job.source)).sort((a, b) => Date.parse(a.job.checkedAt || 0) - Date.parse(b.job.checkedAt || 0)).slice(0, limit)];
    const out = { checked: 0, open: 0, closed: 0, stale: 0, errors: 0, excluded: 0, ...(released ? { mainLine: released } : {}) };
    // Paul, 2026-10-28: "we do want the insurance and law firms, but those should specifically go to Milton not madison and
    // I". Cards taken off the list as law or insurance come back; a law or insurance card someone else booked a callback
    // or retry on goes to Milton at the same time, its history kept. A card in conversation stays with whoever is in it.
    for (const rec of (await allRecords(kv)).filter(r => (r.status === 'excluded' && r.exclusion && r.exclusion.reason === 'law_or_insurance') || (r.status === 'ready' && r.callOwner && laneFor(r) && String(r.callOwner).toLowerCase() !== laneFor(r)))) {
        const lock = HK.recLock(rec.id);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) continue;
        try {
            const fresh = await getRecord(kv, rec.id);
            if (!fresh) continue;
            const at = new Date(now).toISOString(), lane = laneFor(fresh);
            let next = null;
            if (fresh.status === 'excluded' && fresh.exclusion && fresh.exclusion.reason === 'law_or_insurance') { next = { ...fresh, status: 'ready', exclusion: null, restored: { from: 'law_or_insurance', at, by: 'rules re-check' } }; out.restored = (out.restored || 0) + 1; }
            else if (fresh.status === 'ready' && fresh.callOwner && lane && String(fresh.callOwner).toLowerCase() !== lane) { next = { ...fresh, callOwner: lane, callOwnerAt: at, reassigned: { from: fresh.callOwner, to: lane, at, why: 'law or insurance: Milton\'s' } }; out.reassigned = (out.reassigned || 0) + 1; }
            if (!next) continue;
            next.brief = briefFor(next);
            await putRecord(kv, next);
        } finally { await kv.del(lock).catch(() => {}); }
    }
    // Paul, 2026-10-30: "not only being removed from our view, but removed from any automated contact as well". Someone
    // on the global stop list (a STOP text, an unsubscribe, a "remove me" to a rep, a no on another card) leaves the call
    // list on this run, not when somebody next opens their card. Owner and history are kept; the reason is on the card.
    // An unreadable stop list changes nothing here (and blocks no card): each card is still checked when it opens.
    let stops = null;
    if (deps.optedOutSet) { try { stops = await deps.optedOutSet(); } catch { stops = null; } }
    const tenOf = n => String(n || '').replace(/\D/g, '').slice(-10);
    // The person's address, or the number the card rings. Not its backups: an old listing line there may be shared.
    const onStopList = r => !!stops && (!!(r.contact && [r.contact.email, r.contact.candidateEmail].some(e => e && stops.emails.has(String(e).toLowerCase())))
        || !!(r.phone && r.phone.number && stops.numbers.has(tenOf(r.phone.number))));
    const OPEN = ['ready', 'research', 'number_research', 'conversation'];
    if (stops) for (const rec of (await allRecords(kv)).filter(r => OPEN.includes(r.status) && onStopList(r))) {
        const lock = HK.recLock(rec.id);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) continue;
        try {
            const fresh = await getRecord(kv, rec.id);
            if (!fresh || !OPEN.includes(fresh.status) || !onStopList(fresh)) continue;
            const at = new Date(now).toISOString();
            await putRecord(kv, { ...fresh, status: 'suppressed', exclusion: { reason: 'On the do-not-contact list: they asked us to stop', at, by: 'rules re-check' }, updatedAt: at });
            out.optedOut = (out.optedOut || 0) + 1;
        } finally { await kv.del(lock).catch(() => {}); }
    }
    // 2026-10-30: in the first hour of the Hiring now emails, opening a card closed it when its only "email thread" was its
    // own drip (companyThread now leaves drip rows out). A card closed for a thread comes back when no thread but a drip
    // remains at the company and nobody asked to stop; its owner and history are kept.
    const threadClosed = (await allRecords(kv)).filter(r => r.status === 'excluded' && r.exclusion && /already in a Staffify email thread/.test(r.exclusion.reason || ''));
    if (threadClosed.length) {
        const queue = await kv.get(QUEUE_KEY).catch(() => null);
        for (const rec of queue && Array.isArray(queue.records) ? threadClosed : []) {
            if (companyThread(rec, queue.records) || onStopList(rec) || queue.records.some(r => r.hiringId === rec.id && r.status === 'suppressed')) continue;
            const lock = HK.recLock(rec.id);
            if (!await kv.set(lock, '1', { nx: true, ex: 10 })) continue;
            try {
                const fresh = await getRecord(kv, rec.id);
                if (!fresh || fresh.status !== 'excluded' || !/already in a Staffify email thread/.test((fresh.exclusion && fresh.exclusion.reason) || '')) continue;
                const next = { ...fresh, status: 'ready', exclusion: null, restored: { from: 'email_thread', reason: fresh.exclusion.reason, at: new Date(now).toISOString(), by: 'rules re-check' } };
                next.brief = briefFor(next);
                await putRecord(kv, next);
                out.restored = (out.restored || 0) + 1;
            } finally { await kv.del(lock).catch(() => {}); }
        }
    }
    // Paul, 2026-10-28: "dont ever publish a 1800 number because we wont call it, go find the cell phone". Cards made
    // before that: a toll-free line leaves the card; the next number up rings instead, or, with nothing else, the card
    // waits in research for the owner's cell (ownerCells looks those up first). Owner and history stay.
    for (const rec of live.filter(r => r.phone && [r.phone.number, ...(r.phone.alternates || [])].some(tollFree))) {
        const lock = HK.recLock(rec.id);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) continue;
        try {
            const fresh = await getRecord(kv, rec.id);
            if (!fresh || fresh.status !== 'ready' || !fresh.phone) continue;
            const at = new Date(now).toISOString();
            const keep = [fresh.phone.number, ...(fresh.phone.alternates || [])].filter(n => n && !tollFree(n));
            const dropped = [fresh.phone.number, ...(fresh.phone.alternates || [])].filter(tollFree);
            const next = keep.length
                ? { ...fresh, phone: { ...fresh.phone, number: keep[0], alternates: keep.slice(1), ...(tollFree(fresh.phone.number) ? { previous: { number: fresh.phone.number, source: fresh.phone.source || null, why: 'toll-free' } } : {}) }, tollFreeDropped: dropped, updatedAt: at }
                : { ...fresh, status: 'research', hold: { reason: 'toll_free_only', detail: 'The only number on the card is toll-free, a switchboard we do not call. The owner\'s cell is looked up next.', at, by: 'rules re-check' }, tollFreeDropped: dropped, updatedAt: at };
            next.brief = briefFor(next);
            await putRecord(kv, next);
            Object.assign(rec, { phone: next.phone, status: next.status });
            out.tollFree = (out.tollFree || 0) + 1;
        } finally { await kv.del(lock).catch(() => {}); }
    }
    // Provided cards made before the lead's stated date was read (Excel serials, 2026-10-28) take that date, so
    // they expire on the real post's age like any other card. Owner and history stay; only the dates change.
    for (const rec of live.filter(r => r.lead && r.job.source === 'provided')) {
        const stated = leadStatedDate(rec.lead);
        if (!stated || !(Date.parse(stated) < Date.parse(rec.job.postedAt))) continue;
        const lock = HK.recLock(rec.id);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) continue;
        try {
            const fresh = await getRecord(kv, rec.id);
            if (!fresh || fresh.status !== 'ready') continue;
            const job = { ...fresh.job, postedAt: stated, ageDays: ageDays(stated, now), postedLabel: leadDateLabel(fresh.lead), redatedAt: new Date(now).toISOString() };
            const next = { ...fresh, job, jobs: (fresh.jobs || []).map(j => (j.url === fresh.job.url && j.title === fresh.job.title ? { ...j, postedAt: stated, postedLabel: job.postedLabel } : j)) };
            next.brief = briefFor(next);
            await putRecord(kv, next);
            rec.job = job;   // the expiry pass below reads the corrected date in this same run
            out.redated = (out.redated || 0) + 1;
        } finally { await kv.del(lock).catch(() => {}); }
    }
    // The rules improve; cards made under older rules are held to the current ones, for free: the name,
    // the role, the stored listing and the cached Google listing are all re-read, nothing is fetched.
    // A card leaves the worklist with the reason on it and everything else kept; one a caller owns is
    // left for a person. The brief is rebuilt so its wording matches the current rules too.
    for (const rec of live) {
        const x = await recheck(rec, kv, now);
        const brief = briefFor(rec);
        if (!x && JSON.stringify(brief) === JSON.stringify(rec.brief)) continue;
        const lock = HK.recLock(rec.id);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) continue;
        try {
            const fresh = await getRecord(kv, rec.id);
            if (!fresh || fresh.status !== 'ready') continue;
            if (x && x.action === 'hold' && !fresh.callOwner) {
                // Uncertain proof is research: kept whole, never offered (PM, 2026-10-28).
                await putRecord(kv, { ...fresh, brief, status: 'research', hold: { reason: x.reason, detail: x.detail, at: new Date(now).toISOString(), by: 'rules re-check' } });
                out.held = (out.held || 0) + 1;
            } else if (x && !fresh.callOwner) {
                await putRecord(kv, { ...fresh, brief, status: 'excluded', exclusion: { reason: x.reason, detail: x.detail, at: new Date(now).toISOString(), by: 'rules re-check' } });
                const keys = { [fresh.company && fresh.company.board || companyKey(fresh.company && fresh.company.name, fresh.job && fresh.job.location)]: JSON.stringify({ id: fresh.id, verdict: x.from !== 'post' && ['large_employer', 'chain_location', 'institutional_clinical', 'institution'].includes(x.reason) ? 'large' : 'excluded', at: new Date(now).toISOString() }) };
                await kv.hset(HK.companies, keys);
                out.excluded++;
            } else if (JSON.stringify(brief) !== JSON.stringify(fresh.brief)) await putRecord(kv, { ...fresh, brief: briefFor(fresh) });
        } finally { await kv.del(lock).catch(() => {}); }
    }
    // Google Jobs cards made before the local-number rule: look once for a number next to the job's city.
    for (const rec of live.filter(r => r.job.source === 'google_jobs' && r.phone && !r.phone.localCheckedAt && r.company && r.company.website && r.job.city)) {
        const loc = await localNumber({ website: rec.company.website, city: rec.job.city, getPage: deps.getPage }).catch(() => null);
        const lock = HK.recLock(rec.id);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) continue;
        try {
            const fresh = await getRecord(kv, rec.id);
            if (!fresh || fresh.status !== 'ready') continue;
            const better = preferLocal(fresh.phone, loc);
            await putRecord(kv, { ...fresh, phone: better || { ...fresh.phone, localCheckedAt: new Date(now).toISOString() } });
            if (better) { out.localNumbers = (out.localNumbers || 0) + 1; await kv.hset(HK.companies, { [phoneKey(better.number)]: JSON.stringify({ id: fresh.id, verdict: 'ready', at: new Date(now).toISOString() }) }); }
        } finally { await kv.del(lock).catch(() => {}); }
    }
    // Google Jobs cards made before the website check: is the number one the employer publishes? A few a run.
    // A card a caller owns keeps its number (a callback was promised on it); an unreadable site is tried up to three times.
    for (const rec of live.filter(r => r.job.source === 'google_jobs' && r.phone && r.phone.number && r.phone.source !== 'vendor' && !r.phone.siteCheck && !r.callOwner && (r.phone.siteTries || 0) < 3 && r.company && r.company.website).slice(0, siteChecks)) {
        const chk = await siteCheck({ website: rec.company.website, domain: rec.company.domain, getPage: deps.getPage, findSitePhone: deps.findSitePhone });
        const lock = HK.recLock(rec.id);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) continue;
        try {
            const fresh = await getRecord(kv, rec.id);
            if (!fresh || fresh.status !== 'ready' || fresh.callOwner) continue;
            const at = new Date(now).toISOString();
            if (chk.unreadable) { await putRecord(kv, { ...fresh, phone: { ...fresh.phone, siteTries: (fresh.phone.siteTries || 0) + 1 } }); continue; }
            if (chk.moved) {
                await putRecord(kv, { ...fresh, status: 'research', hold: { reason: 'website_unconfirmed', detail: `Their website now goes to ${chk.moved}, not ${fresh.company.domain}, so the employer cannot be confirmed.`, at, by: 'rules re-check' } });
                out.held = (out.held || 0) + 1;
                continue;
            }
            const a = alignNumbers(fresh.phone.number, fresh.phone.alternates, chk);
            const moved = a.primary !== fresh.phone.number;
            let okNew = false, readFailed = false;
            if (moved) {
                try { const bad = await deps.loadBad(kv, fresh.id); okNew = !deps.isBad(bad, a.primary) && !await deps.isOptedOut({ phone: a.primary }); }
                catch { readFailed = true; }
            }
            if (readFailed) continue;   // the stop lists could not be read: nothing changes, tried again next run
            await putRecord(kv, { ...fresh, phone: okNew
                ? { ...fresh.phone, number: a.primary, alternates: a.alternates, source: 'business website', sourceUrl: a.site && a.site.sourceUrl || fresh.company.website, context: a.site && a.site.context || null, checkedAt: at, type: 'company line listed on their website', previous: { number: fresh.phone.number, source: fresh.phone.source }, siteCheck: { at, result: a.result } }
                : { ...fresh.phone, siteCheck: { at, result: moved ? 'site_number_blocked' : a.result } } });
            if (okNew) { out.siteNumbers = (out.siteNumbers || 0) + 1; await kv.hset(HK.companies, { [phoneKey(a.primary)]: JSON.stringify({ id: fresh.id, verdict: 'ready', at }) }); }
        } finally { await kv.del(lock).catch(() => {}); }
    }
    for (const rec of recs) {
        // A Google Jobs or provided card has no posting API: it goes stale MAX_AGE_DAYS after it was posted.
        if (ageBased(rec.job.source)) {
            const age = ageDays(rec.job.postedAt, now);
            if (age != null && age > MAX_AGE_DAYS) {
                const lock = HK.recLock(rec.id);
                if (!await kv.set(lock, '1', { nx: true, ex: 10 })) continue;   // a caller is saving it; next run
                try {
                    const fresh = await getRecord(kv, rec.id);
                    if (fresh && fresh.job && fresh.job.state !== 'stale') { fresh.job = { ...fresh.job, state: 'stale', ageDays: age, closedAt: new Date(now).toISOString(), closedWhy: `Posted ${age} days ago; older than ${MAX_AGE_DAYS} days.` }; await putRecord(kv, fresh); out.stale++; }
                } finally { await kv.del(lock).catch(() => {}); }
            }
            continue;
        }
        const p = parseAts(rec.job.url);
        if (!p) continue;
        let posting;
        try { posting = await fetchPosting(p, deps); } catch { out.errors++; continue; }
        out.checked++;
        const at = new Date(now).toISOString();
        const age = posting.live ? ageDays(posting.postedAt || rec.job.postedAt, now) : rec.job.ageDays;
        const state = !posting.live ? 'closed' : age != null && age > MAX_AGE_DAYS ? 'stale' : 'open';
        out[state]++;
        const lock = HK.recLock(rec.id);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) continue;   // a caller is saving it; next run
        try {
            const fresh = await getRecord(kv, rec.id);
            if (!fresh) continue;
            fresh.job = { ...fresh.job, state, ageDays: age, checkedAt: at, ...(state !== 'open' ? { closedAt: fresh.job.closedAt || at, closedWhy: state === 'closed' ? 'The posting is no longer live on their careers page.' : `Posted ${age} days ago; older than ${MAX_AGE_DAYS} days.` } : {}) };
            fresh.updatedAt = at;
            await putRecord(kv, fresh);
        } finally { await kv.del(lock).catch(() => {}); }
    }
    if (report) report.refresh = out;
    return out;
}

// ---- a person's hold ----------------------------------------------------------------------------
// PM, 2026-10-28, while Milton was calling: take named cards off the worklist now, each with its reason,
// before the rule change that makes it durable ships. Only the named cards, only while still ready (a
// card someone is in a conversation with is left for a person), dry unless `write`. Owner, history, job
// and evidence stay exactly as they are; status, the note and updatedAt are all that change.
export async function holdCards(kv, { holds, write = false, by, now = Date.now() }) {
    const at = new Date(now).toISOString(), out = [];
    for (const h of holds) {
        const lock = HK.recLock(h.id);
        if (write && !await kv.set(lock, '1', { nx: true, ex: 10 })) { out.push({ id: h.id, done: false, why: 'a caller is saving it; try again' }); continue; }
        try {
            const rec = await getRecord(kv, h.id);
            if (!rec) { out.push({ id: h.id, done: false, why: 'not found' }); continue; }
            const base = { id: h.id, company: rec.company && rec.company.name || null, owner: rec.callOwner || null, calls: (rec.callHistory || []).length };
            if (rec.status !== 'ready') { out.push({ ...base, done: false, why: 'already ' + rec.status }); continue; }
            const status = h.action === 'hold' ? 'research' : 'excluded';
            const note = { reason: h.reason, detail: h.detail, at, by };
            if (write) {
                await putRecord(kv, { ...rec, status, ...(status === 'excluded' ? { exclusion: note } : { hold: note }), updatedAt: at });
                // A chain, a health plan or a hospital: a later post from the same employer is not a new card.
                if (h.company === 'large') await kv.hset(HK.companies, { [rec.company && rec.company.board || companyKey(rec.company && rec.company.name, rec.job && rec.job.location)]: JSON.stringify({ id: rec.id, verdict: 'large', at }) });
            }
            out.push({ ...base, from: rec.status, to: status, reason: h.reason, done: write });
        } finally { if (write) await kv.del(lock).catch(() => {}); }
    }
    return out;
}

// ---- an owner's own line on a card --------------------------------------------------------------
// Paul, 2026-10-28: "I need cell phone numbers here from rocket reach, the folks I am hitting a gatekeeper each and
// every single time". The owner's mobile goes first on a card that is being offered or worked, owned or not; the
// number it had stays as an alternate, so nothing a caller relied on is lost. Logged wrong numbers and opt-outs
// still win, and a stop list that cannot be read changes nothing. Dry unless `write`.
export async function ownerLines(kv, { source, lines, write = false, by, now = Date.now(), isOptedOut, loadBad, isBad }) {
    const at = new Date(now).toISOString(), out = [];
    for (const f of lines) {
        const id = String(f && f.id || '');
        const lock = HK.recLock(id);
        if (write && !await kv.set(lock, '1', { nx: true, ex: 10 })) { out.push({ id, done: false, why: 'a caller is saving it; try again' }); continue; }
        try {
            const rec = await getRecord(kv, id);
            if (!rec) { out.push({ id, done: false, why: 'not found' }); continue; }
            const base = { id, company: rec.company && rec.company.name || null, owner: rec.callOwner || null };
            const held = heldForCell(rec), mainHeld = held && rec.hold.reason === 'main_line_only';
            if (rec.booking || !(['ready', 'conversation'].includes(rec.status) || held)) { out.push({ ...base, done: false, why: rec.booking ? 'booked' : 'status ' + rec.status }); continue; }
            const person = String(f.phone_person || '').trim();
            const nums = [f.phone, ...(f.phone_alternates || [])].map(digits10).filter((x, i, a) => x.length === 10 && a.indexOf(x) === i && !tollFree(x)).map(x => '+1' + x);
            if (!nums.length || !person) { out.push({ ...base, done: false, why: !person ? 'no person named' : 'no usable number' }); continue; }
            let usable = [], why = null;
            try {
                const bad = await loadBad(kv, id);
                for (const n of nums) { if (isBad(bad, n)) continue; if (await isOptedOut({ phone: n })) { why = 'opted out'; break; } usable.push(n); }
            } catch { why = 'the stop lists could not be read'; }
            if (why || !usable.length) { out.push({ ...base, done: false, why: why || 'every looked-up number was logged wrong' }); continue; }
            const old = rec.phone || {};
            const primary = usable[0];
            const lineType = primary === nums[0] ? String(f.phone_type || '').trim() || 'number' : 'other number';
            if (mainHeld && !/\b(mobile|cell)/i.test(lineType)) { out.push({ ...base, done: false, why: 'a card held on a main line waits for the owner\'s mobile' }); continue; }
            // Since 2026-10-30 a business's main line is called, so it stays behind the owner's cell as a backup.
            const mains = new Set(mainHeld ? [old.number, ...(old.alternates || [])] : []);
            const phone = {
                number: primary, alternates: [...usable.slice(1, 3), ...(mainHeld ? [] : [old.number, ...(old.alternates || [])])].filter((n, i, a) => n && n !== primary && !tollFree(n) && !mains.has(n) && a.indexOf(n) === i).slice(0, 8),
                source: 'vendor', vendor: source, foundBy: old.foundBy || (rec.job && rec.job.foundBy) || null, person, lineType, grade: primary === nums[0] ? f.phone_grade || null : null,
                sourceUrl: null, context: `Looked up on ${source}`, checkedAt: f.checked_at || at, type: `${person}'s ${lineType} from ${source}`, owner: person,
                localCheckedAt: old.localCheckedAt || at, previous: { number: old.number || null, source: old.source || null, type: old.type || null },
            };
            // A card with no named contact takes the person whose line this is.
            const named = rec.contact && rec.contact.name ? rec.contact : { ...(rec.contact || {}), name: person, firstName: firstNameOf(person.split(/\s+/)[0]), role: String(f.owner_title || '').trim() || null, status: 'named', source: `${source} lookup`, checkedAt: at };
            const contact = contactWithEmail({ contact: named }, f.owner_email ? { email: String(f.owner_email).trim().toLowerCase(), type: f.owner_email_type || null, grade: f.owner_email_grade || null } : null, person, at) || named;
            const next = { ...rec, phone, contact, updatedAt: at, ownerLine: { by: source, at, addedBy: by }, ...(f.ownerCell ? { ownerCell: f.ownerCell } : {}), ...(held ? { status: 'ready', hold: null, released: { from: rec.hold.reason, at, by } } : {}) };
            next.brief = briefFor(next);
            if (write) {
                await putRecord(kv, next);
                await kv.hset(HK.companies, { [phoneKey(primary)]: JSON.stringify({ id, verdict: 'ready', at }) });
            }
            out.push({ ...base, from: old.number || null, to: primary, lineType, email: contact.email && contact.email !== (rec.contact && rec.contact.email) ? contact.email : null, done: write });
        } finally { if (write) await kv.del(lock).catch(() => {}); }
    }
    return out;
}

// ---- the owner's cell, found every run ----------------------------------------------------------
// Paul, 2026-10-28: "I need cell phone numbers here from rocket reach, the folks I am hitting a gatekeeper each and
// every single time", then "I just upgraded our rocketreach account to 1000 + a month". Each run looks up the owner of
// a few ready cards that still ring a main line, newest first, inside a daily cap and above a monthly reserve. A
// profile must be this business (its name words or its domain) in its state, and the card's named owner when it has
// one; only a mobile is put first (ownerLines keeps the old number behind it). Every attempt is noted on the card, so
// each card is tried once, and a "still searching" answer, already paid for, is collected free on a later run.
export const RR_DAILY_CAP = 40, RR_RESERVE = 100, RR_PER_RUN = 6;
// A catch-up night (a big researched list waiting on cells) may raise the day's cap from a machine-only run, never past this.
export const RR_DAILY_MAX = 150;
const CARRIER = /\b(state\s+farm|allstate|farmers|nationwide|american\s+family|amfam|liberty\s+mutual|country\s+financial)\b/i;
const RR_STOP = new Set(['inc', 'llc', 'pllc', 'pc', 'pa', 'llp', 'ltd', 'co', 'corp', 'the', 'and', 'of', 'group', 'law', 'firm', 'office', 'offices', 'agency', 'insurance', 'services', 'agent', 'associates', 'company', 'state', 'farm', 'farmers', 'allstate']);
const rrWords = v => String(v || '').toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !RR_STOP.has(w));
const ownsCell = r => r.phone && r.phone.source === 'vendor' && r.phone.person && /mobile/i.test(r.phone.lineType || '');
// Words that name a trade, not a business: "Lee Dental Care" and "Pacific Dental Services" share "dental" and nothing else.
const RR_GENERIC = new Set(['dental', 'dentistry', 'plumbing', 'roofing', 'technology', 'technologies', 'tech', 'cpa', 'cpas', 'accounting', 'consulting', 'consultants', 'care', 'health', 'healthcare', 'medical', 'home', 'homes', 'construction', 'solutions', 'systems', 'supply', 'realty', 'legal', 'financial', 'finance', 'wealth', 'tax', 'management', 'marketing', 'media', 'therapy', 'psychotherapy', 'clinic', 'family', 'industrial', 'repair', 'partners', 'international', 'global', 'national', 'american', 'usa', 'enterprises', 'holdings', 'capital', 'properties', 'electric', 'electrical', 'hvac', 'mechanical', 'exteriors', 'cleaning', 'pest', 'environmental', 'logistics', 'trucking', 'transport', 'freight', 'staffing', 'wellness', 'spa', 'studio', 'design', 'digital', 'software', 'labs', 'institute', 'center', 'centre', 'network', 'professional', 'premier', 'elite', 'first', 'best', 'quality', 'united', 'north', 'south', 'east', 'west', 'central', 'coastal', 'pacific', 'atlantic', 'texas', 'florida', 'california']);
const HONORIFIC = /^(dr|mr|mrs|ms|miss|jr|sr|ii|iii|iv|cpa|esq|md|dds|dmd|chfc|clu|cfp|phd|jd|mba|rn|np|lmhc|lcsw)$/;
/** A person's name as two comparable tokens: honorifics, suffixes, credentials and initials dropped. */
export function nameKey(n) {
    // "García" is "Garcia" and "O’Brien" is "O'Brien" on either side.
    const t = String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[‘’]/g, "'").toLowerCase().replace(/[.,()]/g, ' ').split(/\s+/).filter(w => w && w.length > 1 && !HONORIFIC.test(w.replace(/[^a-z]/g, '')));
    return t.length ? { first: t[0], last: t[t.length - 1], clean: t.join(' ') } : null;
}
const AGENT_TITLE = /\b(agent|agency|owner|principal|president|founder|ceo|producer|proprietor)\b/i;
/**
 * Is this RocketReach profile the card's business, in its state, and its named owner when there is one?
 * With a named owner: the same person, and a business tie that is more than a trade word (or the same domain, or,
 * for a carrier agency card, the same carrier with an agent or owner title). With no named owner (a company
 * search): the same domain, or the same business name, and a state that agrees; nothing weaker.
 */
export function cellMatch(rec, p, { strictState = false, ignoreState = false } = {}) {
    if (!p || !p.name) return { ok: false, why: 'no profile' };
    const co = (rec.company && rec.company.name) || '', domain = rec.company && rec.company.domain;
    const owner = rec.contact && rec.contact.name;
    const want = owner ? nameKey(owner) : null, have = nameKey(p.name);
    if (owner && !(want && have && want.first === have.first && want.last === have.last)) return { ok: false, why: `RocketReach found ${p.name}, not ${owner}` };
    // The owner's own name is not the business: "Farmers Insurance - Zachary Rogers" must not match "Rogers Plumbing".
    const mine = new Set(owner ? String(owner).toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/).filter(Boolean) : []);
    const distinct = v => rrWords(v).filter(w => !mine.has(w) && !RR_GENERIC.has(w) && !CARRIER.test(w));
    const cw = new Set([...distinct(co), ...distinct(domain && domain.split('.')[0])]);
    const ew = distinct(p.employer);
    const flat = v => ' ' + String(v || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(inc|llc|pllc|pc|pa|llp|ltd|co|corp|the)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    const fc = flat(co), fe = flat(p.employer);
    const carrierOf = v => { const m = String(v || '').match(CARRIER); return m ? m[0].toLowerCase().split(/\s+/)[0] : null; };
    // One name inside the other ("Abrolat Law" / "Abrolat Law PC"), unless the employer is only a carrier ("Farmers
    // Insurance" sits inside every Farmers agency's name) or the shorter name is nothing but trade words ("Dental Care").
    const bareCarrier = !!carrierOf(p.employer) && fe.replace(new RegExp(CARRIER.source, 'gi'), ' ').replace(/\b(insurance|agent|agents|agency|agencies|companies|company|group|exchange|mutual)\b/g, ' ').trim() === '';
    const shorter = fc.length <= fe.length ? fc : fe;
    const sameName = !bareCarrier && fc.trim().length > 3 && fe.trim().length > 3 && (fe.includes(fc) || fc.includes(fe)) && rrWords(shorter).some(w => !RR_GENERIC.has(w) && !CARRIER.test(w));
    const byDomain = !!(domain && p.employerDomain && String(p.employerDomain).toLowerCase().replace(/^www\./, '') === domain);
    const agencyCard = !!carrierOf(co) && /\b(insurance|agent|agency)\b/i.test(co);
    const byCarrier = !!owner && agencyCard && carrierOf(co) === carrierOf([p.employer, p.title].join(' ')) && AGENT_TITLE.test(String(p.title || '')) && !/\b(adjuster|claims|underwriter|corporate|analyst|engineer|specialist)\b/i.test(String(p.title || ''));
    const byWords = owner ? ew.some(w => cw.has(w)) : (cw.size > 0 && ew.length > 0 && ew.every(w => cw.has(w)) && [...cw].every(w => ew.includes(w)));
    if (!(byDomain || sameName || byWords || byCarrier)) return { ok: false, why: `${p.name} works at ${p.employer || 'an unknown employer'}, not ${co}` };
    // RocketReach writes the state as "TX", "Texas" or only inside "Cerritos, CA, US".
    const st = rec.job && rec.job.usState, raw = String(p.region || '').trim();
    const region = /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : stateOf(raw) || stateOf(String(p.location || '').replace(/,\s*(US|USA|United States)\s*$/i, ''));
    if (ignoreState) return { ok: true };   // a search result, before its paid lookup: the state is checked on the profile
    if (st && region && region !== st) return { ok: false, why: `${p.name} is in ${region}, the job is in ${st}` };
    if (st && !region && (strictState || !owner)) return { ok: false, why: `RocketReach gives no state for ${p.name}, and nothing else ties them to this business` };
    return { ok: true };
}
const GRADE = { A: 0, 'A-': 1, B: 2 };
const TOLL = /^\+?1?(800|888|877|866|855|844|833)/;
// Paul, 2026-10-28: "making sure we're also getting their email addresses to follow up via email". The owner's address
// from the same lookup that found their line: one RocketReach's own mail check accepted and graded A or A-, at the
// business's domain first, then another work address, then a personal one. Nothing RocketReach could not confirm.
export function ownerEmail(profile, domain) {
    const ok = ((profile && profile.emails) || []).filter(e => e && e.smtp === 'valid' && /^A-?$/.test(String(e.grade || '')));
    const host = e => e.email.split('@')[1] || '';
    const dom = String(domain || '').toLowerCase().replace(/^www\./, '');
    const now = String(profile && profile.employerDomain || '').toLowerCase().replace(/^www\./, '');
    const at = (e, d) => !!d && (host(e) === d || host(e).endsWith('.' + d));
    // A work address off the card's domain only at their current employer: an old job's mailbox may be someone else's now.
    // A personal mailbox only when it carries the person's own name: RocketReach also files a spouse's or an assistant's
    // Gmail under the owner (2026-10-28: majarvis@live.com on Christopher McNeely's profile).
    const pick = (dom && ok.find(e => at(e, dom))) || (now && ok.find(e => at(e, now) && !FREE_MAIL.test(e.email))) || ok.find(e => (e.type === 'personal' || FREE_MAIL.test(e.email)) && mailNamed(e.email, profile && profile.name));
    return pick ? { email: pick.email, type: at(pick, dom) ? 'work' : FREE_MAIL.test(pick.email) || pick.type === 'personal' ? 'personal' : 'work (their current employer)', grade: pick.grade } : null;
}
/** Does the address's name part carry this person's surname or first name, or the first four letters of either? */
export function mailNamed(email, name) {
    const local = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
    const k = nameKey(name);
    if (!local || !k) return false;
    const last = k.last.replace(/[^a-z]/g, ''), first = k.first.replace(/[^a-z]/g, '');
    return (last.length >= 3 && local.includes(last)) || (first.length >= 3 && local.includes(first)) || [first, last].some(n => n.length >= 4 && local.includes(n.slice(0, 4)));
}
// The same person: same surname and the same first name, a common nickname, or a first name that shares its first four
// letters (Mario, Marius). Never just an initial: Michael and Mary Smith are two people.
const NICK = [['michael', 'mike', 'mick'], ['robert', 'rob', 'bob', 'bobby'], ['william', 'will', 'bill', 'billy'], ['james', 'jim', 'jimmy'], ['thomas', 'tom', 'tommy'], ['daniel', 'dan', 'danny'], ['joseph', 'joe', 'joey'], ['anthony', 'tony'], ['richard', 'rick', 'rich', 'dick'], ['charles', 'chuck', 'charlie'], ['edward', 'ed', 'eddie', 'ted'], ['elizabeth', 'liz', 'beth', 'betsy'], ['katherine', 'kathy', 'kate', 'katie'], ['jennifer', 'jen', 'jenny'], ['margaret', 'maggie', 'peggy'], ['jonathan', 'jonathon', 'jon'], ['stephen', 'steven', 'steve'], ['nicholas', 'nick'], ['matthew', 'matt'], ['christopher', 'chris'], ['alexander', 'alex'], ['benjamin', 'ben'], ['samuel', 'sam'], ['patricia', 'pat', 'patty'], ['rebecca', 'becky'], ['gregory', 'greg'], ['jeffrey', 'jeff'], ['timothy', 'tim'], ['kenneth', 'ken'], ['ronald', 'ron'], ['donald', 'don'], ['lawrence', 'larry'], ['frederick', 'fred'], ['douglas', 'doug']];
const nickOf = n => { const g = NICK.find(x => x.includes(n)); return g ? g[0] : n; };
export const samePerson = (a, b) => {
    const x = nameKey(a), y = nameKey(b);
    if (!(x && y && x.last === y.last)) return false;
    const f = x.first, g = y.first;
    return f === g || nickOf(f) === nickOf(g) || (f.length >= 4 && g.length >= 4 && f.slice(0, 4) === g.slice(0, 4));
};
/** The card's contact with the looked-up owner's address, when the card has none and it is that contact's own; else null. */
export function contactWithEmail(rec, mail, person, at, title = null) {
    const c = rec && rec.contact || {};
    if (!mail || !mail.email || c.email) return null;   // an address given on the call, or verified, is never replaced
    // A closed or booked card takes no new address; one with an unconfirmed address of its own keeps it, so the stop
    // lists that were checked against that address are not quietly swapped for another.
    if (rec.booking || ['excluded', 'suppressed'].includes(rec.status)) return null;
    if (c.candidateEmail && c.candidateEmail !== mail.email) return null;
    if (c.name && person && !samePerson(c.name, person)) return null;   // another person's address would greet them by the wrong name
    if (!c.name && !person) return null;                                 // an address has to say whose it is
    const named = c.name ? {} : { name: person, firstName: firstNameOf(String(person).split(/\s+/)[0]), role: title || c.role || null, status: 'named', source: 'RocketReach lookup', checkedAt: at };
    return { ...c, ...named, email: mail.email, candidateEmail: mail.email, emailSource: 'RocketReach', emailPerson: person || c.name, emailType: mail.type, emailGrade: mail.grade, emailCheckedAt: at };
}

/** The numbers to try, a mobile first: valid ones, best grade first, toll-free dropped. */
export function cellsOf(profile, current) {
    const ok = (profile.phones || []).filter(x => x.valid !== false && !TOLL.test(x.number.replace(/\D/g, '').slice(-10)));
    const rank = x => (GRADE[x.grade] ?? 3) * 2 + (x.recommended ? 0 : 1);
    const mobiles = ok.filter(x => /mobile/i.test(x.type || '')).sort((a, b) => rank(a) - rank(b));
    const direct = ok.filter(x => /direct/i.test(x.type || '')).sort((a, b) => rank(a) - rank(b));
    return { mobile: mobiles[0] || null, others: [...mobiles.slice(1), ...direct].map(x => x.number).filter(n => n !== current).slice(0, 2) };
}
// The attempts live in their own hash, written BEFORE any credit is spent, so a card is looked up once whatever
// happens to the card's own lock; the card carries a copy (ownerCell) for people to read.
export const RR_TRIED = 'staffify:hiring:rr:tried';
export async function ownerCells(deps, { limit = RR_PER_RUN, deadline = Infinity, dailyCap = RR_DAILY_CAP } = {}) {
    const dayCap = Math.max(0, Math.min(RR_DAILY_MAX, Number(dailyCap) || RR_DAILY_CAP));
    const { kv, rr } = deps;
    const now = deps.now || Date.now();
    const out = { tried: 0, lookups: 0, added: 0, noMobile: 0, notFound: 0, mismatch: 0, pending: 0, collected: 0, reapplied: 0, errors: 0, emails: 0, skipped: null };
    if (!rr) { out.skipped = 'RocketReach is not configured'; return out; }
    const at = new Date(now).toISOString(), dayKey = HK.rrDay(at.slice(0, 10));
    const room = () => Date.now() < deadline - 20000;
    const mark = async (id, v) => { await kv.hset(RR_TRIED, { [id]: JSON.stringify(v) }); };
    const note = async (id, ownerCell) => {   // best effort: the hash above is what counts
        const lock = HK.recLock(id);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) return;
        try { const fresh = await getRecord(kv, id); if (fresh) await putRecord(kv, { ...fresh, ownerCell }); } finally { await kv.del(lock).catch(() => {}); }
    };
    const record = async (id, v) => { await mark(id, v); await note(id, v); };
    // No cell, but the owner's address: it goes on the card (best effort; the backfill action can add it later).
    const noteEmail = async (id, mail, person, title) => {
        const lock = HK.recLock(id);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) return false;
        try { const fresh = await getRecord(kv, id); const contact = fresh && contactWithEmail(fresh, mail, person, at, title); if (!contact) return false; await putRecord(kv, { ...fresh, contact, updatedAt: at }); return true; }
        finally { await kv.del(lock).catch(() => {}); }
    };
    const apply = async (id, line, base) => {
        const [r] = await ownerLines(kv, { source: 'RocketReach', lines: [{ ...line, ownerCell: { ...base, result: 'added', person: line.phone_person } }], write: true, by: 'hourly owner-cell lookup', now, isOptedOut: deps.isOptedOut, loadBad: deps.loadBad, isBad: deps.isBad });
        if (r && r.done) { out.added++; if (r.email) out.emails++; return mark(id, { ...base, result: 'added', person: line.phone_person }); }
        // A caller saving the card, or a stop list that could not be read: the paid answer is kept and applied next run.
        if (r && /saving it|could not be read/.test(r.why || '')) { out.errors++; return mark(id, { ...base, result: 'apply_later', line }); }
        out.errors++; return record(id, { ...base, result: 'not_applied', why: r && r.why || 'unknown' });
    };
    const settle = async (rec, profile, base, { strictState }) => {
        const m = cellMatch(rec, profile, { strictState });
        if (!m.ok) { out.mismatch++; return record(rec.id, { ...base, result: 'mismatch', why: m.why }); }
        const c = cellsOf(profile, rec.phone && rec.phone.number);
        const mail = ownerEmail(profile, rec.company && rec.company.domain);
        if (!c.mobile) { out.noMobile++; if (mail && await noteEmail(rec.id, mail, profile.name, profile.title)) out.emails++; return record(rec.id, { ...base, result: 'no_mobile', person: profile.name }); }
        return apply(rec.id, { id: rec.id, phone: c.mobile.number, phone_type: 'mobile', phone_grade: c.mobile.grade, phone_person: profile.name, phone_alternates: c.others, checked_at: at, owner_title: profile.title, ...(mail ? { owner_email: mail.email, owner_email_type: mail.type, owner_email_grade: mail.grade } : {}) }, base);
    };
    let tried;
    try { tried = Object.fromEntries(Object.entries((await kv.hgetall(RR_TRIED)) || {}).map(([k, v]) => [k, parseValue(v) || {}])); }
    catch { out.skipped = 'the attempts could not be read'; return out; }
    const all = await allRecords(kv);
    const byId = new Map(all.map(r => [r.id, r]));
    const held = r => heldForCell(r) && jobCurrent(r, now);
    // Answers already paid for are applied to any live card, due for a call or not.
    const open = r => r && !r.booking && ((r.status === 'ready' && (jobCurrent(r, now) || hiringCallReady(r, now))) || held(r));
    // Free work first: answers already paid for.
    for (const [id, t] of Object.entries(tried)) {
        if (!room()) break;
        const rec = byId.get(id);
        if (t.result === 'apply_later' && t.line && open(rec)) { out.reapplied++; await apply(id, t.line, { at: t.at, profileId: t.profileId }); }
    }
    const waiting = Object.entries(tried).filter(([id, t]) => t.result === 'pending' && t.profileId && open(byId.get(id)));
    if (waiting.length && room()) {
        let st = {}; try { st = await rr.checkStatus(waiting.map(([, t]) => t.profileId)); } catch { st = {}; }
        for (const [id, t] of waiting) { const s2 = st[String(t.profileId)]; if (s2 && s2.done) { out.collected++; await settle(byId.get(id), s2.profile || { name: s2.name, phones: s2.phones }, { at, profileId: t.profileId, how: t.how }, { strictState: t.how === 'search' }); } }
    }
    let acct = null; try { acct = await rr.account(); } catch { acct = null; }
    const usage = acct && Array.isArray(acct.creditUsage) ? acct.creditUsage.find(c => c && c.credit_type === 'premium_lookup') : null;
    const left = usage && Number.isFinite(Number(usage.remaining)) ? Number(usage.remaining) : null;
    out.creditsLeft = left;
    if (left == null) { out.skipped = 'the RocketReach balance could not be read'; return out; }
    if (left <= RR_RESERVE) { out.skipped = `${left} lookups left this month; ${RR_RESERVE} are kept in reserve`; return out; }
    const cap = Math.min(limit, left - RR_RESERVE);
    // The day counter is the authority: taken before each lookup, so two runs together never pass the cap.
    const take = async () => { const n = Number(await kv.incr(dayKey)); await kv.expire(dayKey, 3 * 86400).catch(() => {}); if (n > dayCap) { out.skipped = `daily cap of ${dayCap} reached`; return false; } out.lookups++; return true; };
    // A lookup is spent only on a card with no number to call (toll-free only) or whose business line has failed.
    // (A failed line is looked up before its next call is due, so the cell is on the card when it comes round.)
    const cand = all.filter(r => r && !r.booking && !tried[r.id] && !ownsCell(r) && (held(r) || (r.status === 'ready' && jobCurrent(r, now) && lineFailed(r))))
        .sort((a, b) => (held(b) - held(a)) || (Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)));
    for (const rec of cand) {
        if (out.lookups >= cap || out.skipped || !room()) break;
        out.tried++;
        const owner = rec.contact && rec.contact.name;
        const co = rec.company && rec.company.name;
        await mark(rec.id, { at, result: 'looking' });
        try {
            let res = null, how = null;
            if (owner && nameKey(owner)) { if (!await take()) { await kv.hdel(RR_TRIED, rec.id); break; } how = 'name'; res = await rr.lookupPerson({ name: nameKey(owner).clean.replace(/\b\w/g, c => c.toUpperCase()), employer: CARRIER.test(co) && /\b(insurance|agent|agency)\b/i.test(co) ? String(co.match(CARRIER)[0]) : co }); }
            if (res && res.fatal) { out.skipped = 'RocketReach rejected the key'; await kv.hdel(RR_TRIED, rec.id); break; }
            if (res && res.retryable) { out.errors++; await kv.hdel(RR_TRIED, rec.id); break; }   // an outage or a rate limit: stop for this run
            // Search only when the name found nobody at all (a profile with no phones is still that person).
            if (!res || (!res.found && !res.pending && !(res.profile && res.profile.name))) {
                const sr = await rr.searchPeople({ company: co });
                if (sr.fatal) { out.skipped = 'RocketReach rejected the key'; await kv.hdel(RR_TRIED, rec.id); break; }
                if (sr.retryable) { out.errors++; await kv.hdel(RR_TRIED, rec.id); break; }
                const p = (sr.profiles || []).find(x => x.id && cellMatch(rec, { ...x, employer: x.current_employer, region: null }, { ignoreState: true }).ok && (!x.location || cellMatch(rec, { ...x, employer: x.current_employer, region: null }).ok));
                if (p && out.lookups < cap) {
                    if (!await take()) { await kv.hdel(RR_TRIED, rec.id); break; }
                    how = 'search'; res = await rr.lookupPerson({ id: p.id });
                    if (res && (res.retryable || res.fatal)) { out.errors++; await kv.hdel(RR_TRIED, rec.id); break; }
                }
            }
            const base = { at, how, profileId: res && (res.id || (res.profile && res.profile.id)) || null };
            if (res && res.pending) { out.pending++; await record(rec.id, { ...base, result: 'pending' }); continue; }
            if (!res || !(res.profile && res.profile.name)) { out.notFound++; await record(rec.id, { ...base, result: 'not_found' }); continue; }
            // A person found from a company search, not by the card's own owner name, must also be shown to be in its state.
            await settle(rec, res.profile, base, { strictState: how === 'search' });
        } catch (e) { out.errors++; await kv.hdel(RR_TRIED, rec.id).catch(() => {}); break; }
    }
    return out;
}

// ---- owners' addresses for lookups already paid for ----------------------------------------------
// Every owner found before 2026-10-28 night was looked up with their address too, and it was not kept. checkStatus
// reads a looked-up profile back for free; the address goes on the card under the same rules as ownerCells. Dry
// unless `write`; a card someone is saving is left for the next run.
/** Personal addresses RocketReach put on cards that do not carry the person's name come off (dry unless `write`). */
export async function recheckOwnerEmails(kv, { write = false, now = Date.now() } = {}) {
    const at = new Date(now).toISOString(), out = { checked: 0, removed: 0, busy: 0, planned: [] };
    for (const rec of await allRecords(kv)) {
        const c = rec.contact || {};
        if (c.emailSource !== 'RocketReach' || !c.email || !FREE_MAIL.test(c.email)) continue;
        out.checked++;
        if (mailNamed(c.email, c.emailPerson || c.name)) continue;
        out.planned.push({ id: rec.id, company: rec.company && rec.company.name, person: c.emailPerson || c.name, email: c.email });
        if (!write) continue;
        const lock = HK.recLock(rec.id);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) { out.busy++; continue; }
        try {
            const fresh = await getRecord(kv, rec.id);
            const f = fresh && fresh.contact || {};
            if (!fresh || f.email !== c.email || f.emailSource !== 'RocketReach') continue;
            const { emailSource, emailPerson, emailType, emailGrade, emailCheckedAt, ...rest } = f;
            await putRecord(kv, { ...fresh, contact: { ...rest, email: null, candidateEmail: null, emailRemoved: { email: c.email, why: 'the address does not carry their name', at } }, updatedAt: at });
            out.removed++;
        } finally { await kv.del(lock).catch(() => {}); }
    }
    return out;
}

export async function ownerEmails(kv, { rr, write = false, now = Date.now(), limit = 300 }) {
    const at = new Date(now).toISOString(), out = { candidates: 0, read: 0, found: 0, saved: 0, noEmail: 0, otherPerson: 0, busy: 0, planned: [] };
    const tried = Object.entries((await kv.hgetall(RR_TRIED)) || {}).map(([id, v]) => [id, parseValue(v) || {}]).filter(([, t]) => t.profileId && ['added', 'no_mobile'].includes(t.result));
    const byId = new Map((await allRecords(kv)).map(r => [r.id, r]));
    const todo = tried.filter(([id]) => { const r = byId.get(id); return r && !r.booking && !(r.contact && r.contact.email) && !['excluded', 'suppressed'].includes(r.status); }).slice(0, limit);
    out.candidates = todo.length;
    for (let i = 0; i < todo.length; i += 100) {
        const chunk = todo.slice(i, i + 100);
        let st = {}; try { st = await rr.checkStatus(chunk.map(([, t]) => t.profileId)); } catch { st = {}; }
        for (const [id, t] of chunk) {
            const s2 = st[String(t.profileId)];
            if (!s2 || !s2.profile) continue;
            out.read++;
            const rec = byId.get(id), mail = ownerEmail(s2.profile, rec.company && rec.company.domain);
            if (!mail) { out.noEmail++; continue; }
            if (!contactWithEmail(rec, mail, s2.profile.name, at, s2.profile.title)) { out.otherPerson++; continue; }
            out.found++;
            out.planned.push({ id, company: rec.company && rec.company.name, person: s2.profile.name, email: mail.email, type: mail.type });
            if (!write) continue;
            const lock = HK.recLock(id);
            if (!await kv.set(lock, '1', { nx: true, ex: 10 })) { out.busy++; continue; }
            try { const fresh = await getRecord(kv, id); const contact = fresh && contactWithEmail(fresh, mail, s2.profile.name, at, s2.profile.title); if (contact) { await putRecord(kv, { ...fresh, contact, updatedAt: at }); out.saved++; } }
            finally { await kv.del(lock).catch(() => {}); }
        }
    }
    return out;
}

// ---- numbers looked up for research leads -------------------------------------------------------
// Paul, 2026-10-28: "use rocket reach to find the missing prospects here so the datasets full ... we can
// start with a call". A provided lead waiting in research for a number gets the one a lookup found, with
// whose it is, its line type and grade, and goes back into the pending queue: the next run (?leads=only)
// puts it through every admission check again. Only blank fields are filled (what the researcher wrote
// stays as written); the backlog entry keeps a note of what was added, by whom and when. Dry unless `write`.
export const FILL_FIELDS = ['owner_first', 'owner_last', 'owner_title', 'owner_email', 'website'];
export async function fillResearch(kv, { source, fills, write = false, by, now = Date.now() }) {
    const at = new Date(now).toISOString(), out = [];
    for (const f of fills) {
        const id = String(f && f.id || '');
        const b = parseValue(await kv.hget(HK.backlog, id));
        if (!b) { out.push({ id, done: false, why: 'not in research' }); continue; }
        if (!b.lead) { out.push({ id, done: false, why: 'not a researched lead' }); continue; }
        if (b.state === 'closed') { out.push({ id, done: false, why: 'closed: ' + (b.closedReason || 'no reason') }); continue; }
        const d = digits10(f.phone);
        if (d.length !== 10) { out.push({ id, company: b.company && b.company.name, done: false, why: 'no usable number' }); continue; }
        const lead = { ...b.lead, phone: d, phone_source: source, phone_type: f.phone_type || null, phone_person: f.phone_person || null, phone_grade: f.phone_grade || null, phone_alternates: (f.phone_alternates || []).map(digits10).filter(x => x.length === 10 && x !== d).slice(0, 3).join(','), phone_checked_at: f.checked_at || at, phone_source_url: f.source_url || null, public_phone: digits10(f.public_phone).length === 10 ? digits10(f.public_phone) : null, public_phone_url: f.public_phone_url || null };
        const added = ['phone'];
        for (const k of FILL_FIELDS) if (!String(b.lead[k] || '').trim() && String(f[k] || '').trim()) { lead[k] = String(f[k]).trim().slice(0, 300); added.push(k); }
        if (added.includes('owner_first') || added.includes('owner_email')) lead.contact_source = source;
        if (write) {
            await putBacklog(kv, { ...b, lead, enrichment: { by: source, fields: added, at, addedBy: by } });
            await addPending(kv, { kind: 'lead', key: (b.provenance && b.provenance.postingKey) || leadKey(b.lead), lead }, { ...(b.provenance || {}), retry: true, enrichedBy: source, enrichedAt: at }, now);
        }
        out.push({ id, company: b.company && b.company.name, phone: '+1' + d, added, done: write });
    }
    return out;
}

// ---- a whole run ------------------------------------------------------------------------------
/**
 * deps additionally: serpSearch(q) -> { links:[...] }, serpAccount() -> { left }, findymailCredits() -> { credits },
 *   workableJobs({ query, dayRange, pageToken }) -> { jobs, nextPageToken } (free; the step is skipped without it),
 *   workableCompany(id) -> { openRoles, jobs } (free; without it no Workable job is queued: its size is unknown)
 * opts: { maxSearches, maxCandidates, deadlineMs, discover, free, refresh }
 * Order: keep ready cards honest, then work what is already waiting (pending, then due research),
 * then the free Workable search every run, and only then pay for new searches, and only when the pending queue has room.
 */
export async function runHiring(deps, { maxSearches = 5, maxCandidates = 25, deadlineMs = 230000, discover = true, free = true, refresh = 12, leadsOnly = false, cells = RR_PER_RUN, rrDailyCap = RR_DAILY_CAP } = {}) {
    const { kv } = deps;
    const t0 = Date.now(), now = deps.now || Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const report = { campaignId: HIRING_ID, startedAt: new Date(now).toISOString(), searches: [], postings: 0, verdicts: {}, reasons: {}, ready: [], backlog: [], samples: [], errors: [], credits: {}, maxAgeDays: MAX_AGE_DAYS, listings: { found: 0, queued: 0, excluded: {} } };
    const tally = r => { report.verdicts[r.verdict] = (report.verdicts[r.verdict] || 0) + 1; if (r.reason) report.reasons[r.reason] = (report.reasons[r.reason] || 0) + 1; if (r.verdict === 'ready') report.ready.push(r.id); if (r.verdict === 'backlog') report.backlog.push(r.id); if (r.verdict === 'error') report.errors.push(r.detail || r.reason); };
    const timeLeft = () => Date.now() - t0 < deadlineMs;

    try { report.credits.findymail = await deps.findymailCredits(); } catch (e) { report.credits.findymail = { error: String(e.message || e).slice(0, 80) }; }
    const finderOk = Number(report.credits.findymail && report.credits.findymail.credits) >= FINDYMAIL_FLOOR;
    const findContact = finderOk ? deps.findContact : async () => ({ error: 'Findymail finder credits at or below the ' + FINDYMAIL_FLOOR + ' floor; contact lookups paused' });

    // One SerpApi budget for the run: job searches and business-listing lookups both draw on it, inside
    // the daily cap and above the monthly reserve. A lookup with no budget left waits in pending.
    let left = null;
    try { const a = await deps.serpAccount(); left = a.left; report.credits.serpapi = a; } catch (e) { report.credits.serpapi = { error: String(e.message || e).slice(0, 80) }; }
    // An unreadable day counter is not zero searches used: it is unknown, so nothing is spent this run.
    let usedToday = null;
    try { usedToday = Number(await kv.get(HK.serpDay(day)) || 0); } catch (e) { report.searchBudgetError = 'The daily search counter could not be read; no searches this run.'; }
    // leadsOnly: work provided leads only; a lead needs no search credit, so the run is allowed none.
    const allowed = leadsOnly || usedToday == null || left == null || !Number.isFinite(left) ? 0 : Math.max(0, Math.min(SERP_DAILY_CAP - usedToday, left - SERP_RESERVE, maxSearches + maxCandidates));
    const budget = { allowed, used: 0, remaining() { return this.allowed - this.used; },
        async take() { if (this.used >= this.allowed) return false; this.used++; await kv.incr(HK.serpDay(day)); await kv.expire(HK.serpDay(day), 3 * 86400).catch(() => {}); return true; } };
    report.searchBudget = { left, reserve: SERP_RESERVE, usedToday, dailyCap: SERP_DAILY_CAP, allowedThisRun: allowed };
    const d = { ...deps, findContact, now, searchBudget: budget };

    // 1. Ready cards: is the job still open, still recent?
    if (refresh) await refreshReady(d, { limit: refresh, report });

    // 2. What is already waiting: seeds and earlier search results.
    let worked = 0;
    // A listing that needs a search when none is left waits, unchanged, for a run with budget. It no longer stops the pass:
    // until 2026-10-30 one such listing held up every free entry queued behind it until it aged out a week later.
    const noBudget = new Set();
    const work = async () => {
        for (const e of (await pendingDue(kv, now)).filter(e => (!leadsOnly || e.kind === 'lead') && !noBudget.has(e.key))) {
            if (!timeLeft() || worked >= maxCandidates) break;
            const r = await settle(e, d, report);
            if (r.reason === 'no_budget') { noBudget.add(e.key); report.waitingForBudget = noBudget.size; continue; }
            if (r.verdict !== 'seen') { worked++; report.postings++; }
            tally(r);
        }
    };
    await work();

    // 3. The research backlog whose time has come. A retry that is now excluded (too old, a client) closes.
    const refOf = b => (b.lead ? { kind: 'lead', key: (b.provenance && b.provenance.postingKey) || leadKey(b.lead), lead: b.lead } : b.listing ? { kind: 'gjob', key: (b.provenance && b.provenance.postingKey) || jobKey(b.listing), listing: b.listing } : parseAts(b.job && b.job.url));
    const dueAll = (await allBacklog(kv).catch(() => [])).filter(b => b.state === 'open' && Date.parse(b.nextTryAt) <= now);
    // An entry the run has no way to retry is closed with the reason, never left to hold a slot for ever.
    for (const b of dueAll.filter(b => !refOf(b))) await putBacklog(kv, { ...b, state: 'closed', closedReason: 'cannot_retry', closedAt: new Date(now).toISOString() });
    const due = leadsOnly ? [] : dueAll.filter(refOf).sort((a, b) => Date.parse(a.nextTryAt) - Date.parse(b.nextTryAt)).slice(0, 4);
    for (const b of due) {
        if (!timeLeft()) break;
        const ref = refOf(b);
        report.postings++;
        let r;
        try { r = await processPosting(ref, { ...(b.provenance || {}), retry: true }, d, report); }
        catch (e) { r = { verdict: 'error', reason: 'run_error', detail: String((e && e.message) || e).slice(0, 120) }; }
        if (r.verdict === 'excluded') await putBacklog(kv, { ...b, state: 'closed', closedReason: r.reason, closedAt: new Date(now).toISOString() });
        tally(r);
    }

    // 3b. The owner's cell for ready cards that still ring a main line (RocketReach, capped per day and month).
    if (cells && timeLeft()) { try { report.ownerCells = await ownerCells(d, { limit: cells, deadline: t0 + deadlineMs, dailyCap: rrDailyCap }); } catch (e) { report.ownerCells = { error: String((e && e.message) || e).slice(0, 120) }; } }
    // 3c. A Quo contact for each card, so a callback shows who it is (api/_quo-contacts.js).
    if (deps.quoContacts && timeLeft()) { try { const q = await syncQuoContacts({ kv, api: deps.quoContacts, now }, { limit: 40, write: true }); delete q.planned; report.quoContacts = q; } catch (e) { report.quoContacts = { error: String((e && e.message) || e).slice(0, 120) }; } }

    // 4. New listings. Free ones every run (4a); Google Jobs, one role in one city per search, the last three days only,
    // only when nothing already paid for is still waiting, and leaving room in the budget for the lookups (4b).
    const waiting = Object.keys((await kv.hgetall(HK.pending)) || {}).length;
    report.pendingBeforeSearch = waiting;
    // 4a. Free listings: Workable, every run, whatever the search budget and however many wait, on its own cap and cursor
    // (Paul, 2026-10-30: SerpApi is out of credits and the Hub had stopped refilling). A failure here never stops the run.
    let freeQueued = 0;
    if (free && !leadsOnly && deps.workableJobs && timeLeft()) {
        try { report.workable = await workableDiscovery(d, { now, timeLeft, startedAt: report.startedAt }); } catch (e) { report.workable = { ...(report.workable || {}), error: String((e && e.message) || e).slice(0, 120) }; }
        freeQueued = report.workable.queued || 0;
    }
    // 4b. Paid listings: Google Jobs through SerpApi, gated on the queue as it stood before this run's free search.
    if (discover && waiting < maxCandidates && timeLeft()) {
        let cursor = null;
        try { cursor = Number(await kv.get(HK.jobsCursor) || 0); } catch { report.cursorError = 'The search position could not be read; no new searches this run.'; }
        // Leave room for the listing lookups those searches will need (up to four, or the run's cap).
        const searches = cursor == null ? 0 : Math.max(0, Math.min(maxSearches, budget.remaining() - Math.min(4, maxCandidates)));
        for (let i = 0; i < searches && timeLeft(); i++) {
            const { q, location, family, term } = JOB_QUERIES[cursor % JOB_QUERIES.length];
            cursor++;
            await kv.set(HK.jobsCursor, cursor % JOB_QUERIES.length);
            if (!await budget.take()) break;
            try {
                const r = await deps.serpJobs(q, location);
                const jobs = r.jobs || [];
                let queued = 0;
                for (const l of jobs) {
                    report.listings.found++;
                    const v = qualifyJob(l, now);
                    if (!v.ok) { report.listings.excluded[v.reason] = (report.listings.excluded[v.reason] || 0) + 1; continue; }
                    const key = jobKey(l);
                    const was = parseValue(await kv.hget(HK.seen, key));
                    if (was && Date.parse(was.at) >= now - MAX_AGE_DAYS * 864e5) continue;
                    await addPending(kv, { kind: 'gjob', key, listing: compactListing(l, now) }, { discoveredBy: 'SerpApi Google Jobs', searchQuery: q, searchLocation: location, discoveredAt: report.startedAt }, now);
                    queued++;
                }
                report.listings.queued += queued;
                report.searches.push({ family, term, location, results: jobs.length, queued });
            } catch (e) { report.searches.push({ family, term, location, error: String(e.message || e).slice(0, 80) }); }
        }
    }
    if (report.listings.queued || freeQueued) await work();
    report.searchBudget.used = budget.used;
    report.pendingAfter = Object.keys((await kv.hgetall(HK.pending)) || {}).length;
    report.finishedAt = new Date().toISOString();
    report.ms = Date.now() - t0;
    await kv.lpush(HK.runs, JSON.stringify(report)).catch(() => {});
    await kv.ltrim(HK.runs, 0, 49).catch(() => {});
    return report;
}
