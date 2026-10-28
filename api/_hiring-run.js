// One run of the Hiring now campaign: find current posts, read each back from the company's own
// hiring system, admit the company only on proof, find its listed number and a contact, apply every
// exclusion, and file the result as ready, research backlog or excluded. Nothing here dials or sends.
// ------------------------------------------------------------------
// Every outside call comes in through `deps`, so the tests run the whole path on fakes. The real
// ones live in api/hiring-intent.js. Paid calls (SerpApi, Findymail) are counted, capped and
// guarded; a vendor error is recorded as an error and the row stays retryable, never as "none
// found" (memory: an API error is not absence).
import { contactLinks, phonesOnPage } from './_site-phone.js';
import {
    HIRING_ID, HK, QUERIES, JOB_QUERIES, MAX_AGE_DAYS, parseAts, postingKey, boardKey, idFor, qualifyPosting, qualifyJob, jobKey, companyKey, phoneKey, cityOf, stateOf, jobAgeDays, listingAge, profileMatches, priorityOf, ageDays, jobCurrent,
    boardHomepage, linksToBoard, websiteCandidates, outboundLinks, careersLinks, hostOf, briefFor, firstNameOf, companyExcluded, LARGE_EMPLOYEES, roleFamily,
    parseValue, putRecord, putBacklog, allBacklog, allRecords, getRecord, nextTry, domainKey, listingEvidence, remotePost,
    ageBased, leadKey, leadDomain, qualifyLead, leadStatedDate, leadDateLabel,
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
const PHONE_RUN = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})(?!\d)/g;
export async function localNumber({ website, city, getPage }) {
    if (!website || !city) return null;
    let home;
    try { home = await getPage(website); } catch { return null; }
    if (!home) return null;
    const pages = [home];
    for (const u of contactLinks(home, 3)) { try { const p = await getPage(u); if (p) pages.push(p); } catch { /* skip */ } }
    const cityRe = new RegExp('\\b' + String(city).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    for (const p of pages) {
        const text = String(p.text || '') || String(p.html || '').replace(/<[^>]+>/g, ' ');
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
    const numbers = [...new Set(pages.flatMap(pg => phonesOnPage(pg).map(h => '+1' + h.digits)))];
    const site = await findSitePhone({ website, fetchSite: fetchOnce, maxPages: 4 }).catch(() => null);
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
        postedAt: l.posted_at || (age == null ? null : new Date(now - age * 864e5).toISOString()),
        url: l.share_link || links[0] || null, applyUrl: links[0] || null,
        workplace: /\b(remote|work from home|anywhere)\b/i.test([l.title, l.location, ...(l.extensions || [])].join(' ')) ? 'remote' : 'onsite',
        text: l.description || '', openRoles: null,
    };
}
/** The compact listing kept in the pending queue: what processPosting needs, nothing more. */
export function compactListing(l, now = Date.now()) {
    // Google's "3 days ago" is true only today: keep the date it implies, so a later pass counts real days.
    const age = jobAgeDays(l.extensions);
    return { posted_at: age == null ? null : new Date(now - age * 864e5).toISOString(), found_at: new Date(now).toISOString(), job_id: l.job_id || null, title: l.title, company_name: l.company_name, location: l.location, via: l.via || null, extensions: (l.extensions || []).slice(0, 6), description: String(l.description || '').slice(0, 3000), apply_options: (l.apply_options || []).slice(0, 5).map(a => ({ title: a.title, link: a.link })), share_link: l.share_link || null };
}
/**
 * The employer behind a Google Jobs listing, from Google's business listing for that name and city.
 * Spends one search through deps.searchBudget unless the answer (or a miss) is cached.
 */
export async function profileIdentity(posting, deps) {
    let profile;
    try { profile = await deps.businessProfile(posting.company, posting.location, deps.searchBudget); }
    catch (e) { return { error: String((e && e.message) || e).slice(0, 120) }; }
    if (profile && profile.error) return { error: profile.error, noBudget: !!profile.noBudget };
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
        ? { source: 'google_jobs', title: posting.title, url: posting.url, applyUrl: posting.applyUrl, via: posting.via, googleJobId: p.listing.job_id || null, postedAt: posting.postedAt, ageDays: q.age, checkedAt, location: posting.location, city: cityOf(posting.location), usState: stateOf(posting.location), workplace: posting.workplace, restrictions: q.restrictions }
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
        provenance: { ...provenance, postingKey: key, verifiedVia: gj ? `Google Jobs listing${posting.via ? ' (' + posting.via + ')' : ''}, ${q.age} day(s) old when found` : posting.ats + ' public postings API', firstCheckedAt: checkedAt },
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
    const ident = gj ? await profileIdentity(posting, deps) : await resolveIdentity(posting, deps);
    if (ident.error) return { verdict: 'error', reason: ident.noBudget ? 'no_budget' : 'lookup_unavailable', detail: ident.error };
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

    // The number: from their Google business listing, else published on their own site.
    let listed = gj && ident.phone ? { phone: ident.phone, alternates: [], sourceUrl: ident.evidenceUrl, context: 'Google business listing for ' + (ident.listingName || posting.company), checkedAt, source: 'Google business listing' } : null;
    if (listed && ident.website && job.city) {
        const loc = await localNumber({ website: ident.website, city: job.city, getPage: deps.getPage }).catch(() => null);
        if (loc && loc.phone !== listed.phone) listed = { phone: loc.phone, alternates: [listed.phone], sourceUrl: loc.sourceUrl, context: loc.context, checkedAt: loc.checkedAt, source: 'business website', local: true };
    }
    let phone = listed || (ident.website ? await deps.findSitePhone({ website: ident.website, fetchSite: deps.getPage, maxPages: 4 }).catch(() => null) : null);
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
    // The listing's number was logged as wrong: their own website may publish another.
    if (!usable.length && listed && ident.website) {
        const site = await deps.findSitePhone({ website: ident.website, fetchSite: deps.getPage, maxPages: 4 }).catch(() => null);
        if (site && site.phone) { phone = { ...site, source: 'business website' }; usable = [site.phone, ...(site.alternates || [])].filter(n => !deps.isBad(bad, n)); }
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
    const bk = companyKey(l.business, q.usState ? ', ' + q.usState : '');
    const id = idFor(bk);
    const via = (() => { try { return new URL(l.posting_url).hostname.replace(/^(www|app|jobs)\./, ''); } catch { return null; } })();
    const job = { source: 'provided', title: String(l.role_posted).trim(), url: l.posting_url || null, applyUrl: l.posting_url || null, via, postedAt: q.postedAt, postedLabel: leadDateLabel(l), ageDays: q.age, checkedAt, location: q.location, city: q.city, usState: q.usState, workplace: q.workplace, restrictions: q.restrictions, foundBy: source };
    const known = parseValue(await kv.hget(HK.companies, bk));
    if (known && ['client', 'in_outreach', 'suppressed', 'large'].includes(known.verdict)) { await mark('excluded', 'company_' + known.verdict); return { verdict: 'excluded', reason: 'company_' + known.verdict }; }
    const existing = await getRecord(kv, id);
    if (existing && !(existing.status === 'number_research' && provenance.retry)) {
        if (!(existing.jobs || []).some(x => x.url === job.url && x.title === job.title)) { existing.jobs = [...(existing.jobs || []), job]; existing.brief = briefFor(existing); await putRecord(kv, existing); }
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
        if (byDomain && byDomain.id && byDomain.id !== id) { const other = await getRecord(kv, byDomain.id); if (other) { if (!(other.jobs || []).some(x => x.url === job.url)) { other.jobs = [...(other.jobs || []), job]; other.brief = briefFor(other); await putRecord(kv, other); } await mark('merged', 'same_domain', { id: other.id }); return { verdict: 'merged', reason: 'same_domain', id: other.id }; } }
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
    const personNums = vendor ? [d, ...String(l.phone_alternates || '').split(/[,;\s]+/).map(digits10)].filter((x, i, a) => x.length === 10 && a.indexOf(x) === i).map(x => '+1' + x) : [];
    // The business's own published line, seen by whoever checked the lookup, rides last as the company's.
    const publicNum = vendor && digits10(l.public_phone).length === 10 ? '+1' + digits10(l.public_phone) : null;
    let phone = d.length !== 10 ? null
        : vendor ? { phone: '+1' + d, alternates: [...personNums.slice(1), ...(publicNum && !personNums.includes(publicNum) ? [publicNum] : [])], source: 'vendor', vendor, person: String(l.phone_person || '').trim() || null, lineType: String(l.phone_type || '').trim() || null, grade: String(l.phone_grade || '').trim() || null, sourceUrl: l.phone_source_url || null, context: `Looked up on ${vendor}`, checkedAt: l.phone_checked_at || checkedAt }
        : { phone: '+1' + d, alternates: [], source: 'provided', sourceUrl: l.email_source_url || website || null, context: `From ${source}'s research`, checkedAt };
    if (domain && website) {
        const chk = await siteCheck({ website, domain, getPage: deps.getPage, findSitePhone: deps.findSitePhone });
        if (chk.moved) return toBacklog('website_unconfirmed', `Their website now goes to ${chk.moved}, not ${domain}, so the business cannot be confirmed.`, { missing: ['website'] });
        if (phone && vendor) {
            const onSite = chk.unreadable ? [] : chk.numbers || [];
            phone = { ...phone, alternates: [...phone.alternates, ...onSite].filter((n, i, a) => n !== phone.phone && a.indexOf(n) === i).slice(0, 4), ...(chk.unreadable ? {} : { siteCheck: { at: checkedAt, result: onSite.includes(phone.phone) ? 'confirmed' : onSite.length ? 'person_line' : 'none_published' } }) };
        } else if (phone) {
            const a = alignNumbers(phone.phone, [], chk);
            phone = a.result === 'replaced' || a.result === 'alternate_on_site'
                ? { phone: a.primary, alternates: a.alternates, source: 'business website', sourceUrl: a.site && a.site.sourceUrl || website, context: a.site && a.site.context || null, checkedAt, previous: { number: '+1' + d, source: 'provided' }, siteCheck: { at: checkedAt, result: a.result } }
                : { ...phone, ...(a.result === 'unreadable' ? {} : { siteCheck: { at: checkedAt, result: a.result } }) };
        } else if (chk.site && chk.site.phone) phone = { phone: chk.site.phone, alternates: (chk.numbers || []).filter(n => n !== chk.site.phone).slice(0, 3), source: 'business website', sourceUrl: chk.site.sourceUrl || website, context: chk.site.context || null, checkedAt, siteCheck: { at: checkedAt, result: 'site_only' } };
    }
    if (!phone) return toBacklog('no_listed_phone', `No number in the lead${domain ? ' and none published on ' + domain : ''}.`);
    const bad = await deps.loadBad(kv, id).catch(() => new Set());
    const usable = [phone.phone, ...(phone.alternates || [])].filter(n => !deps.isBad(bad, n));
    if (!usable.length) return toBacklog('no_listed_phone', 'Every number on file was logged as wrong.');
    for (const n of usable) if (await deps.isOptedOut({ phone: n })) { await mark('excluded', 'opted_out'); return { verdict: 'excluded', reason: 'opted_out' }; }
    const byPhone = parseValue(await kv.hget(HK.companies, phoneKey(usable[0])));
    if (byPhone && byPhone.id && byPhone.id !== id) {
        if (['client', 'in_outreach', 'suppressed'].includes(byPhone.verdict)) { await mark('excluded', 'company_' + byPhone.verdict); return { verdict: 'excluded', reason: 'company_' + byPhone.verdict }; }
        const other = await getRecord(kv, byPhone.id);
        if (other) { if (!(other.jobs || []).some(x => x.url === job.url)) { other.jobs = [...(other.jobs || []), job]; other.brief = briefFor(other); await putRecord(kv, other); } await mark('merged', 'same_number', { id: other.id }); return { verdict: 'merged', reason: 'same_number', id: other.id }; }
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
        await putBacklog(kv, { id, campaignId: HIRING_ID, company: { name: entry.kind === 'gjob' ? entry.listing.company_name : entry.board, board: bk }, job: entry.kind === 'gjob' ? { source: 'google_jobs', title: entry.listing.title, url: entry.url || null } : { url: entry.url || null, ats: entry.ats, board: entry.board, postingId: entry.id }, ...(entry.kind === 'gjob' ? { listing: entry.listing } : {}), provenance: { ...(entry.provenance || {}), postingKey: entry.key }, reason: entry.kind === 'gjob' ? 'lookup_unavailable' : 'posting_unreadable', detail: entry.kind === 'gjob' ? `The Google business listing lookup failed after ${attempts} tries: ${r.detail || r.reason}.` : `The posting could not be read after ${attempts} tries: ${r.detail || r.reason}.`, missing: ['posting'], attempts, state: 'exhausted', firstSeenAt: entry.addedAt, lastTriedAt: new Date(now).toISOString(), nextTryAt: null });
        await kv.hdel(HK.pending, entry.key);
        return { ...r, verdict: 'error', parked: true };
    }
    await kv.hset(HK.pending, { [entry.key]: JSON.stringify({ ...entry, attempts, lastError: r.detail || r.reason, lastTriedAt: new Date(now).toISOString(), nextTryAt: new Date(now + attempts * 3600e3).toISOString() }) });
    return r;
}

/** The first current rule an existing card fails, or null. Reads only what is stored. */
export async function recheck(rec, kv, now = Date.now()) {
    const name = rec.company && rec.company.name;
    const byName = companyExcluded(name);
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
    const live = (await allRecords(kv)).filter(r => r.status === 'ready' && r.job && r.job.state !== 'closed' && r.job.state !== 'stale');
    // Every Google Jobs card (a date check, free) and the ATS cards checked longest ago (a fetch each).
    const recs = [...live.filter(r => ageBased(r.job.source)), ...live.filter(r => !ageBased(r.job.source)).sort((a, b) => Date.parse(a.job.checkedAt || 0) - Date.parse(b.job.checkedAt || 0)).slice(0, limit)];
    const out = { checked: 0, open: 0, closed: 0, stale: 0, errors: 0, excluded: 0 };
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
    for (const rec of live.filter(r => r.job.source === 'google_jobs' && r.phone && r.phone.number && !r.phone.siteCheck && !r.callOwner && (r.phone.siteTries || 0) < 3 && r.company && r.company.website).slice(0, siteChecks)) {
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
            if (rec.booking || !['ready', 'conversation'].includes(rec.status)) { out.push({ ...base, done: false, why: rec.booking ? 'booked' : 'status ' + rec.status }); continue; }
            const person = String(f.phone_person || '').trim();
            const nums = [f.phone, ...(f.phone_alternates || [])].map(digits10).filter((x, i, a) => x.length === 10 && a.indexOf(x) === i).map(x => '+1' + x);
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
            const phone = {
                number: primary, alternates: [...usable.slice(1), old.number, ...(old.alternates || [])].filter((n, i, a) => n && n !== primary && a.indexOf(n) === i).slice(0, 6),
                source: 'vendor', vendor: source, foundBy: old.foundBy || (rec.job && rec.job.foundBy) || null, person, lineType, grade: primary === nums[0] ? f.phone_grade || null : null,
                sourceUrl: null, context: `Looked up on ${source}`, checkedAt: f.checked_at || at, type: `${person}'s ${lineType} from ${source}`, owner: person,
                localCheckedAt: old.localCheckedAt || at, previous: { number: old.number || null, source: old.source || null, type: old.type || null },
            };
            // A card with no named contact takes the person whose line this is.
            const contact = rec.contact && rec.contact.name ? rec.contact : { ...(rec.contact || {}), name: person, firstName: firstNameOf(person.split(/\s+/)[0]), role: String(f.owner_title || '').trim() || null, status: 'named', source: `${source} lookup`, checkedAt: at };
            const next = { ...rec, phone, contact, updatedAt: at, ownerLine: { by: source, at, addedBy: by } };
            next.brief = briefFor(next);
            if (write) {
                await putRecord(kv, next);
                await kv.hset(HK.companies, { [phoneKey(primary)]: JSON.stringify({ id, verdict: 'ready', at }) });
            }
            out.push({ ...base, from: old.number || null, to: primary, lineType, done: write });
        } finally { if (write) await kv.del(lock).catch(() => {}); }
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
 * deps additionally: serpSearch(q) -> { links:[...] }, serpAccount() -> { left }, findymailCredits() -> { credits }
 * opts: { maxSearches, maxCandidates, deadlineMs, discover, refresh }
 * Order: keep ready cards honest, then work what is already waiting (pending, then due research),
 * and only then pay for new searches, and only when the pending queue has room.
 */
export async function runHiring(deps, { maxSearches = 5, maxCandidates = 25, deadlineMs = 230000, discover = true, refresh = 12, leadsOnly = false } = {}) {
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
    const work = async () => {
        for (const e of (await pendingDue(kv, now)).filter(e => !leadsOnly || e.kind === 'lead')) {
            if (!timeLeft() || worked >= maxCandidates) break;
            const r = await settle(e, d, report);
            if (r.reason === 'no_budget') { report.waitingForBudget = (report.waitingForBudget || 0) + 1; break; }
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

    // 4. New listings: Google Jobs, one role in one city per search, the last three days only. Only when
    // nothing already paid for is still waiting, and leaving room in the budget for the lookups.
    const waiting = Object.keys((await kv.hgetall(HK.pending)) || {}).length;
    report.pendingBeforeSearch = waiting;
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
        if (report.listings.queued) await work();
    }
    report.searchBudget.used = budget.used;
    report.pendingAfter = Object.keys((await kv.hgetall(HK.pending)) || {}).length;
    report.finishedAt = new Date().toISOString();
    report.ms = Date.now() - t0;
    await kv.lpush(HK.runs, JSON.stringify(report)).catch(() => {});
    await kv.ltrim(HK.runs, 0, 49).catch(() => {});
    return report;
}
