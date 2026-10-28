// One run of the Hiring now campaign: find current posts, read each back from the company's own
// hiring system, admit the company only on proof, find its listed number and a contact, apply every
// exclusion, and file the result as ready, research backlog or excluded. Nothing here dials or sends.
// ------------------------------------------------------------------
// Every outside call comes in through `deps`, so the tests run the whole path on fakes. The real
// ones live in api/hiring-intent.js. Paid calls (SerpApi, Findymail) are counted, capped and
// guarded; a vendor error is recorded as an error and the row stays retryable, never as "none
// found" (memory: an API error is not absence).
import {
    HIRING_ID, HK, QUERIES, JOB_QUERIES, MAX_AGE_DAYS, parseAts, postingKey, boardKey, idFor, qualifyPosting, qualifyJob, jobKey, companyKey, phoneKey, cityOf, stateOf, jobAgeDays, listingAge, profileMatches, priorityOf, ageDays, jobCurrent,
    boardHomepage, linksToBoard, websiteCandidates, outboundLinks, careersLinks, hostOf, briefFor, firstNameOf, companyExcluded, LARGE_EMPLOYEES,
    parseValue, putRecord, putBacklog, allBacklog, allRecords, getRecord, nextTry, domainKey,
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
        workplace: /\b(remote|work from home|anywhere)\b/i.test([l.location, ...(l.extensions || [])].join(' ')) ? 'remote' : 'onsite',
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
    const sz = profile.size || {};
    if ((sz.employees && sz.employees > LARGE_EMPLOYEES) || sz.listed || sz.parent) return { ok: false, large: true, unresolved: `Google's panel shows a large employer (${sz.employees ? sz.employees + ' employees' : sz.listed ? 'publicly traded' : 'part of ' + sz.parent}).` };
    const host = profile.website ? hostOf(profile.website) : null;
    const d = digits10(profile.phone);
    return { ok: true, how: 'google_business_profile', website: profile.website || null, domain: host, phone: d.length === 10 ? '+1' + d : null, address: profile.address || null, listingName: profile.title, evidenceUrl: profile.link || null };
}

// ---- one posting, start to finish ---------------------------------------------------------------
/**
 * deps: kv, getJson, getPage, findSitePhone, findContact, verifyEmail, isOptedOut, clientCheck,
 *       crmContact, crmStop, loadBad, isBad, outreachDomains (Set), now
 * Returns { verdict: 'ready'|'backlog'|'excluded'|'merged'|'seen'|'error', reason?, id?, record? }
 */
export async function processPosting(p, provenance, deps, report) {
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
        ? { source: 'google_jobs', title: posting.title, url: posting.url, applyUrl: posting.applyUrl, via: posting.via, googleJobId: p.listing.job_id || null, postedAt: posting.postedAt, ageDays: q.age, checkedAt, location: posting.location, city: cityOf(posting.location), state: stateOf(posting.location), workplace: posting.workplace, restrictions: q.restrictions }
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
    const company = { ...base.company, website: ident.website || null, domain: ident.domain || null, address: ident.address || null, identity: { how: ident.how, evidenceUrl: ident.evidenceUrl, listingName: ident.listingName || null, checkedAt } };
    base.company = company;
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

    // Already being worked anywhere in Staffify outreach: never a second, colder touch.
    if (ident.domain && deps.outreachDomains && deps.outreachDomains.has(ident.domain)) { await kv.hset(HK.companies, { [bk]: JSON.stringify({ verdict: 'in_outreach', at: checkedAt }), [domainKey(ident.domain)]: JSON.stringify({ verdict: 'in_outreach', at: checkedAt }) }); await mark('excluded', 'already_in_outreach'); return { verdict: 'excluded', reason: 'already_in_outreach' }; }
    // A client, by company name, before any credit is spent.
    const byCompany = await deps.clientCheck({ email: null, company: posting.company }).catch(() => ({ status: 'unknown' }));
    if (byCompany.status === 'client') { await kv.hset(HK.companies, { [bk]: JSON.stringify({ verdict: 'client', at: checkedAt }), ...(ident.domain ? { [domainKey(ident.domain)]: JSON.stringify({ verdict: 'client', at: checkedAt }) } : {}) }); await mark('excluded', 'client'); return { verdict: 'excluded', reason: 'client' }; }
    if (byCompany.status === 'possible') return toBacklog('possible_client', byCompany.reason || 'The company name matches an existing client. A person checks before it is called.', { missing: ['client check'] });
    if (byCompany.status !== 'clear') return toBacklog('client_check_unavailable', byCompany.why || 'The client list could not be read, so this is not called yet.', { missing: ['client check'] });

    // The number: from their Google business listing, else published on their own site.
    const listed = gj && ident.phone ? { phone: ident.phone, alternates: [], sourceUrl: ident.evidenceUrl, context: 'Google business listing for ' + (ident.listingName || posting.company), checkedAt, source: 'Google business listing' } : null;
    let phone = listed || (ident.website ? await deps.findSitePhone({ website: ident.website, fetchSite: deps.getPage, maxPages: 4 }).catch(() => null) : null);
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
        phone: { number: usable[0], alternates: usable.slice(1), source: phone.source || 'business website', sourceUrl: phone.sourceUrl, context: phone.context || null, checkedAt: phone.checkedAt || checkedAt, type: phone.source === 'Google business listing' ? 'main line on their Google business listing' : 'company line listed on their website', owner: 'the company, not a named person' },
        status: 'ready', callOutcome: null, nextCallAt: null, callOwner: null, callHistory: [],
    };
    // A wrong number re-researched: same card, same history and owner; the new number is a new lead to ring.
    if (existing) Object.assign(rec, { createdAt: existing.createdAt, callHistory: existing.callHistory || [], callOwner: existing.callOwner || null, callOwnerAt: existing.callOwnerAt || null, jobs: existing.jobs && existing.jobs.length ? existing.jobs : rec.jobs, provenance: existing.provenance || rec.provenance });
    rec.priority = priorityOf({ age: q.age, restrictions: q.restrictions, openRoles: posting.openRoles, contact });
    rec.brief = briefFor(rec);
    await putRecord(kv, rec);
    await kv.hdel(HK.backlog, id).catch(() => {});
    await kv.hset(HK.companies, { [bk]: JSON.stringify({ id, verdict: 'ready', at: checkedAt }), [phoneKey(rec.phone.number)]: JSON.stringify({ id, verdict: 'ready', at: checkedAt }), ...(company.domain ? { [domainKey(company.domain)]: JSON.stringify({ id, verdict: 'ready', at: checkedAt }) } : {}) });
    await mark('ready', 'ready', { id });
    if (report && report.samples.length < 3) report.samples.push({ id, company: company.name, job: job.title, jobUrl: job.url, postedAt: job.postedAt, website: company.website, identity: company.identity.how, phoneSource: rec.phone.sourceUrl, contact: contact && contact.name ? contact.name + (contact.role ? ', ' + contact.role : '') + ' (' + contact.status + ')' : (contact && contact.status) });
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
    const key = p.kind === 'gjob' ? p.key : postingKey(p);
    const entry = p.kind === 'gjob'
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
    const ref = entry.kind === 'gjob' ? { kind: 'gjob', key: entry.key, listing: entry.listing } : { ats: entry.ats, board: entry.board, id: entry.id };
    try { r = await processPosting(ref, entry.provenance || {}, deps, report); }
    catch (e) { r = { verdict: 'error', reason: 'run_error', detail: String((e && e.message) || e).slice(0, 120) }; }
    if (DURABLE.has(r.verdict)) { await kv.hdel(HK.pending, entry.key); return r; }
    // Out of searches for today is not a failed attempt: the listing waits, unchanged, for the next run.
    if (r.reason === 'no_budget') return r;
    const attempts = (entry.attempts || 0) + 1;
    if (attempts >= PENDING_MAX_ATTEMPTS) {
        // Not lost and not retried forever: a visible research entry a person can look at.
        const bk = entry.kind === 'gjob' ? companyKey(entry.listing.company_name, entry.listing.location) : boardKey(entry);
        const id = idFor(bk);
        await putBacklog(kv, { id, campaignId: HIRING_ID, company: { name: entry.kind === 'gjob' ? entry.listing.company_name : entry.board, board: bk }, job: entry.kind === 'gjob' ? { source: 'google_jobs', title: entry.listing.title, url: entry.url || null } : { url: entry.url || null, ats: entry.ats, board: entry.board, postingId: entry.id }, ...(entry.kind === 'gjob' ? { listing: entry.listing } : {}), provenance: { ...(entry.provenance || {}), postingKey: entry.key }, reason: entry.kind === 'gjob' ? 'lookup_unavailable' : 'posting_unreadable', detail: entry.kind === 'gjob' ? `The Google business listing lookup failed after ${attempts} tries: ${r.detail || r.reason}.` : `The posting could not be read after ${attempts} tries: ${r.detail || r.reason}.`, missing: ['posting'], attempts, state: 'exhausted', firstSeenAt: entry.addedAt, lastTriedAt: new Date(now).toISOString(), nextTryAt: null });
        await kv.hdel(HK.pending, entry.key);
        return { ...r, verdict: 'error', parked: true };
    }
    await kv.hset(HK.pending, { [entry.key]: JSON.stringify({ ...entry, attempts, lastError: r.detail || r.reason, lastTriedAt: new Date(now).toISOString(), nextTryAt: new Date(now + attempts * 3600e3).toISOString() }) });
    return r;
}

// ---- keeping ready cards honest ---------------------------------------------------------------
// PM, 2026-10-27: "A job that closes tomorrow can therefore remain callable forever." Each run
// re-reads the ready cards whose post was checked longest ago. Closed or past MAX_AGE_DAYS: the
// card stops being offered (api/_hiring-intent.js hiringCallReady) and keeps its owner, history
// and any promised time. A read that fails changes nothing and is tried again next run; the
// freshness gate keeps an unconfirmed card off the list meanwhile.
export async function refreshReady(deps, { limit = 12, report = null } = {}) {
    const { kv } = deps;
    const now = deps.now || Date.now();
    const live = (await allRecords(kv)).filter(r => r.status === 'ready' && r.job && r.job.state !== 'closed' && r.job.state !== 'stale');
    // Every Google Jobs card (a date check, free) and the ATS cards checked longest ago (a fetch each).
    const recs = [...live.filter(r => r.job.source === 'google_jobs'), ...live.filter(r => r.job.source !== 'google_jobs').sort((a, b) => Date.parse(a.job.checkedAt || 0) - Date.parse(b.job.checkedAt || 0)).slice(0, limit)];
    const out = { checked: 0, open: 0, closed: 0, stale: 0, errors: 0, excluded: 0 };
    // The rules improve; cards made under older rules are held to the current ones. Free: a name check.
    for (const rec of live) {
        const x = companyExcluded(rec.company && rec.company.name);
        if (!x) continue;
        const lock = HK.recLock(rec.id);
        if (!await kv.set(lock, '1', { nx: true, ex: 10 })) continue;
        try {
            const fresh = await getRecord(kv, rec.id);
            if (fresh && fresh.status === 'ready' && !fresh.callOwner) { await putRecord(kv, { ...fresh, status: 'excluded', exclusion: { reason: x.reason, detail: x.detail, at: new Date(now).toISOString(), by: 'rules re-check' } }); out.excluded++; }
        } finally { await kv.del(lock).catch(() => {}); }
    }
    for (const rec of recs) {
        // A Google Jobs card has no posting API: it goes stale MAX_AGE_DAYS after it was posted.
        if (rec.job.source === 'google_jobs') {
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

// ---- a whole run ------------------------------------------------------------------------------
/**
 * deps additionally: serpSearch(q) -> { links:[...] }, serpAccount() -> { left }, findymailCredits() -> { credits }
 * opts: { maxSearches, maxCandidates, deadlineMs, discover, refresh }
 * Order: keep ready cards honest, then work what is already waiting (pending, then due research),
 * and only then pay for new searches, and only when the pending queue has room.
 */
export async function runHiring(deps, { maxSearches = 5, maxCandidates = 25, deadlineMs = 230000, discover = true, refresh = 12 } = {}) {
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
    const allowed = usedToday == null || left == null || !Number.isFinite(left) ? 0 : Math.max(0, Math.min(SERP_DAILY_CAP - usedToday, left - SERP_RESERVE, maxSearches + maxCandidates));
    const budget = { allowed, used: 0, remaining() { return this.allowed - this.used; },
        async take() { if (this.used >= this.allowed) return false; this.used++; await kv.incr(HK.serpDay(day)); await kv.expire(HK.serpDay(day), 3 * 86400).catch(() => {}); return true; } };
    report.searchBudget = { left, reserve: SERP_RESERVE, usedToday, dailyCap: SERP_DAILY_CAP, allowedThisRun: allowed };
    const d = { ...deps, findContact, now, searchBudget: budget };

    // 1. Ready cards: is the job still open, still recent?
    if (refresh) await refreshReady(d, { limit: refresh, report });

    // 2. What is already waiting: seeds and earlier search results.
    let worked = 0;
    const work = async () => {
        for (const e of await pendingDue(kv, now)) {
            if (!timeLeft() || worked >= maxCandidates) break;
            const r = await settle(e, d, report);
            if (r.reason === 'no_budget') { report.waitingForBudget = (report.waitingForBudget || 0) + 1; break; }
            if (r.verdict !== 'seen') { worked++; report.postings++; }
            tally(r);
        }
    };
    await work();

    // 3. The research backlog whose time has come. A retry that is now excluded (too old, a client) closes.
    const refOf = b => (b.listing ? { kind: 'gjob', key: (b.provenance && b.provenance.postingKey) || jobKey(b.listing), listing: b.listing } : parseAts(b.job && b.job.url));
    const dueAll = (await allBacklog(kv).catch(() => [])).filter(b => b.state === 'open' && Date.parse(b.nextTryAt) <= now);
    // An entry the run has no way to retry is closed with the reason, never left to hold a slot for ever.
    for (const b of dueAll.filter(b => !refOf(b))) await putBacklog(kv, { ...b, state: 'closed', closedReason: 'cannot_retry', closedAt: new Date(now).toISOString() });
    const due = dueAll.filter(refOf).sort((a, b) => Date.parse(a.nextTryAt) - Date.parse(b.nextTryAt)).slice(0, 4);
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
