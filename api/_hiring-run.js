// One run of the Hiring now campaign: find current posts, read each back from the company's own
// hiring system, admit the company only on proof, find its listed number and a contact, apply every
// exclusion, and file the result as ready, research backlog or excluded. Nothing here dials or sends.
// ------------------------------------------------------------------
// Every outside call comes in through `deps`, so the tests run the whole path on fakes. The real
// ones live in api/hiring-intent.js. Paid calls (SerpApi, Findymail) are counted, capped and
// guarded; a vendor error is recorded as an error and the row stays retryable, never as "none
// found" (memory: an API error is not absence).
import {
    HIRING_ID, HK, QUERIES, MAX_AGE_DAYS, parseAts, postingKey, boardKey, idFor, qualifyPosting, priorityOf, ageDays,
    boardHomepage, linksToBoard, websiteCandidates, outboundLinks, careersLinks, hostOf, briefFor, firstNameOf,
    parseValue, putRecord, putBacklog, allBacklog, allRecords, getRecord, nextTry, domainKey,
} from './_hiring-intent.js';

export const SERP_RESERVE = 300;      // searches left in the month that this campaign never touches
export const SERP_DAILY_CAP = 24;
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
        if (page) return { website: page.url, domain: hostOf(page.url), how: 'board_link', evidenceUrl: posting.url, page };
    }
    const tried = [];
    for (const host of websiteCandidates({ company: posting.company, board: posting.board, links: [posting.homepage, ...(posting.links || [])].filter(Boolean) })) {
        const home = await getPage('https://' + host).catch(() => null);
        tried.push(host);
        if (!home) continue;
        if (linksToBoard(home.html, p)) return { website: home.url, domain: hostOf(home.url), how: 'backlink', evidenceUrl: home.url, page: home };
        for (const c of careersLinks(home)) {
            const cp = await getPage(c).catch(() => null);
            if (cp && linksToBoard(cp.html, p)) return { website: home.url, domain: hostOf(home.url), how: 'backlink', evidenceUrl: cp.url, page: home };
        }
    }
    return { unresolved: 'No website could be tied to this job board: the board names no homepage and no candidate site links back to it.', tried };
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
    const key = postingKey(p);
    const seen = parseValue(await kv.hget(HK.seen, key));
    if (seen && !provenance.seed) return { verdict: 'seen', reason: seen.verdict };
    let posting;
    try { posting = await fetchPosting(p, deps); }
    catch (e) { return { verdict: 'error', reason: 'posting_unreadable', detail: String(e.message || e).slice(0, 120) }; }
    const checkedAt = new Date(now).toISOString();
    const q = qualifyPosting(posting, now);
    const mark = async (verdict, reason, extra = {}) => { await kv.hset(HK.seen, { [key]: JSON.stringify({ at: checkedAt, verdict, reason, company: posting.company || p.board, title: posting.title || null, url: posting.url || null, ...extra }) }); };
    if (!q.ok) { await mark('excluded', q.reason, { detail: q.detail }); return { verdict: 'excluded', reason: q.reason, detail: q.detail }; }

    // One card per company. A second matching role joins the first card.
    const bk = boardKey(p);
    const job = { title: posting.title, url: posting.url, ats: posting.ats, board: posting.board, postingId: posting.id, postedAt: posting.postedAt, ageDays: q.age, checkedAt, location: posting.location, locations: posting.locations, workplace: posting.workplace || 'remote', team: posting.team, commitment: posting.commitment, restrictions: q.restrictions };
    const id = idFor(bk);
    const known = parseValue(await kv.hget(HK.companies, bk));
    if (known && ['client', 'in_outreach', 'suppressed'].includes(known.verdict)) { await mark('excluded', 'company_' + known.verdict); return { verdict: 'excluded', reason: 'company_' + known.verdict }; }
    const existing = await getRecord(kv, id);
    // A card that exists keeps its history. Only a retry of a wrong number re-researches it.
    if (existing && !(existing.status === 'number_research' && provenance.retry)) {
        if (!(existing.jobs || []).some(x => x.url === job.url)) { existing.jobs = [...(existing.jobs || []), job]; existing.brief = briefFor(existing); await putRecord(kv, existing); }
        await mark('merged', 'same_company', { id });
        return { verdict: 'merged', id };
    }
    if (!existing && known && known.verdict === 'backlog' && !provenance.retry && !provenance.seed) { await mark('merged', 'company_in_research', { id }); return { verdict: 'merged', reason: 'company_in_research', id }; }
    const base = {
        id, campaignId: HIRING_ID, family: q.family,
        company: { name: posting.company, board: bk, openRoles: posting.openRoles, website: null, domain: null, identity: null },
        job, jobs: [job],
        provenance: { ...provenance, postingKey: key, verifiedVia: posting.ats + ' public postings API', firstCheckedAt: checkedAt },
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

    // Who the company is, on proof only (PM, 2026-10-27).
    const ident = await resolveIdentity(posting, deps);
    if (!ident.website) return toBacklog('identity_unresolved', ident.unresolved, { missing: ['website', 'phone'], identityTried: ident.tried });
    const company = { ...base.company, website: ident.website, domain: ident.domain, identity: { how: ident.how, evidenceUrl: ident.evidenceUrl, checkedAt } };
    base.company = company;
    // One card per employer, not per board: a second board or a new ATS at a confirmed domain joins the card
    // already there, and a domain that was stopped, a client or in research stays that way.
    const byDomain = parseValue(await kv.hget(HK.companies, domainKey(ident.domain)));
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
    if (deps.outreachDomains && deps.outreachDomains.has(ident.domain)) { await kv.hset(HK.companies, { [bk]: JSON.stringify({ verdict: 'in_outreach', at: checkedAt }), [domainKey(ident.domain)]: JSON.stringify({ verdict: 'in_outreach', at: checkedAt }) }); await mark('excluded', 'already_in_outreach'); return { verdict: 'excluded', reason: 'already_in_outreach' }; }
    // A client, by company name, before any credit is spent.
    const byCompany = await deps.clientCheck({ email: null, company: posting.company }).catch(() => ({ status: 'unknown' }));
    if (byCompany.status === 'client') { await kv.hset(HK.companies, { [bk]: JSON.stringify({ verdict: 'client', at: checkedAt }), [domainKey(ident.domain)]: JSON.stringify({ verdict: 'client', at: checkedAt }) }); await mark('excluded', 'client'); return { verdict: 'excluded', reason: 'client' }; }
    if (byCompany.status === 'possible') return toBacklog('possible_client', byCompany.reason || 'The company name matches an existing client. A person checks before it is called.', { missing: ['client check'] });
    if (byCompany.status !== 'clear') return toBacklog('client_check_unavailable', byCompany.why || 'The client list could not be read, so this is not called yet.', { missing: ['client check'] });

    // The number: published on their own site.
    const phone = await deps.findSitePhone({ website: ident.website, fetchSite: deps.getPage, maxPages: 4 }).catch(() => null);
    // The contact: Findymail's domain search, then its verifier. Optional; recorded either way.
    let contact = null;
    try {
        const c = await deps.findContact(ident.domain);
        if (c && c.error) contact = { status: 'lookup_failed', reason: c.error, checkedAt };
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
        if (byEmail.status === 'client') { await kv.hset(HK.companies, { [bk]: JSON.stringify({ verdict: 'client', at: checkedAt }), [domainKey(ident.domain)]: JSON.stringify({ verdict: 'client', at: checkedAt }) }); await mark('excluded', 'client'); return { verdict: 'excluded', reason: 'client' }; }
        let props = null, crmError = null;
        try { const c = await deps.crmContact(email); props = c && c.properties || null; } catch (e) { if (!/CRM contact missing/.test(String(e && e.message))) crmError = String(e.message || e).slice(0, 80); }
        if (crmError) return toBacklog('crm_unavailable', 'HubSpot could not be checked: ' + crmError, { missing: ['CRM check'], company, contact });
        const stop = deps.crmStop(props);
        if (stop) { await mark('excluded', 'crm_stop', { detail: stop }); return { verdict: 'excluded', reason: 'crm_stop', detail: stop }; }
    }
    if (!phone || !phone.phone) return toBacklog('no_listed_phone', 'No phone number is published on ' + ident.domain + '.', { company, contact });
    const bad = await deps.loadBad(kv, id).catch(() => new Set());
    const usable = [phone.phone, ...(phone.alternates || [])].filter(n => !deps.isBad(bad, n));
    if (!usable.length) return toBacklog('no_listed_phone', 'Every number on ' + ident.domain + ' was logged as wrong.', { company, contact });
    for (const n of usable) if (await deps.isOptedOut({ phone: n })) { await mark('excluded', 'opted_out'); return { verdict: 'excluded', reason: 'opted_out' }; }

    const rec = {
        ...base, company, contact,
        phone: { number: usable[0], alternates: usable.slice(1), source: 'business website', sourceUrl: phone.sourceUrl, context: phone.context || null, checkedAt: phone.checkedAt || checkedAt, type: 'company line listed on their website', owner: 'the company, not a named person' },
        status: 'ready', callOutcome: null, nextCallAt: null, callOwner: null, callHistory: [],
    };
    // A wrong number re-researched: same card, same history and owner; the new number is a new lead to ring.
    if (existing) Object.assign(rec, { createdAt: existing.createdAt, callHistory: existing.callHistory || [], callOwner: existing.callOwner || null, callOwnerAt: existing.callOwnerAt || null, jobs: existing.jobs && existing.jobs.length ? existing.jobs : rec.jobs, provenance: existing.provenance || rec.provenance });
    rec.priority = priorityOf({ age: q.age, restrictions: q.restrictions, openRoles: posting.openRoles, contact });
    rec.brief = briefFor(rec);
    await putRecord(kv, rec);
    await kv.hdel(HK.backlog, id).catch(() => {});
    await kv.hset(HK.companies, { [bk]: JSON.stringify({ id, verdict: 'ready', at: checkedAt }), [domainKey(company.domain)]: JSON.stringify({ id, verdict: 'ready', at: checkedAt }) });
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
    const key = postingKey(p);
    const entry = { key, url: p.url || null, ats: p.ats, board: p.board, id: p.id, provenance, attempts: 0, addedAt: new Date(now).toISOString(), nextTryAt: new Date(now).toISOString() };
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
    try { r = await processPosting({ ats: entry.ats, board: entry.board, id: entry.id }, entry.provenance || {}, deps, report); }
    catch (e) { r = { verdict: 'error', reason: 'run_error', detail: String((e && e.message) || e).slice(0, 120) }; }
    if (DURABLE.has(r.verdict)) { await kv.hdel(HK.pending, entry.key); return r; }
    const attempts = (entry.attempts || 0) + 1;
    if (attempts >= PENDING_MAX_ATTEMPTS) {
        // Not lost and not retried forever: a visible research entry a person can look at.
        const id = idFor(boardKey(entry));
        await putBacklog(kv, { id, campaignId: HIRING_ID, company: { name: entry.board, board: boardKey(entry) }, job: { url: entry.url || null, ats: entry.ats, board: entry.board, postingId: entry.id }, provenance: entry.provenance, reason: 'posting_unreadable', detail: `The posting could not be read after ${attempts} tries: ${r.detail || r.reason}.`, missing: ['posting'], attempts, state: 'exhausted', firstSeenAt: entry.addedAt, lastTriedAt: new Date(now).toISOString(), nextTryAt: null });
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
    const recs = (await allRecords(kv)).filter(r => r.status === 'ready' && r.job && r.job.state !== 'closed' && r.job.state !== 'stale')
        .sort((a, b) => Date.parse(a.job.checkedAt || 0) - Date.parse(b.job.checkedAt || 0)).slice(0, limit);
    const out = { checked: 0, open: 0, closed: 0, stale: 0, errors: 0 };
    for (const rec of recs) {
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
export async function runHiring(deps, { maxSearches = 4, maxCandidates = 14, deadlineMs = 230000, discover = true, refresh = 12 } = {}) {
    const { kv } = deps;
    const t0 = Date.now(), now = deps.now || Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const report = { campaignId: HIRING_ID, startedAt: new Date(now).toISOString(), searches: [], postings: 0, verdicts: {}, reasons: {}, ready: [], backlog: [], samples: [], errors: [], credits: {}, maxAgeDays: MAX_AGE_DAYS };
    const tally = r => { report.verdicts[r.verdict] = (report.verdicts[r.verdict] || 0) + 1; if (r.reason) report.reasons[r.reason] = (report.reasons[r.reason] || 0) + 1; if (r.verdict === 'ready') report.ready.push(r.id); if (r.verdict === 'backlog') report.backlog.push(r.id); if (r.verdict === 'error') report.errors.push(r.detail || r.reason); };
    const timeLeft = () => Date.now() - t0 < deadlineMs;

    try { report.credits.findymail = await deps.findymailCredits(); } catch (e) { report.credits.findymail = { error: String(e.message || e).slice(0, 80) }; }
    const finderOk = Number(report.credits.findymail && report.credits.findymail.credits) >= FINDYMAIL_FLOOR;
    const findContact = finderOk ? deps.findContact : async () => ({ error: 'Findymail finder credits at or below the ' + FINDYMAIL_FLOOR + ' floor; contact lookups paused' });
    const d = { ...deps, findContact, now };

    // 1. Ready cards: is the job still open?
    if (refresh) await refreshReady(d, { limit: refresh, report });

    // 2. What is already waiting: seeds and earlier search results.
    let worked = 0;
    const work = async () => {
        for (const e of await pendingDue(kv, now)) {
            if (!timeLeft() || worked >= maxCandidates) break;
            const r = await settle(e, d, report);
            if (r.verdict !== 'seen') { worked++; report.postings++; }
            tally(r);
        }
    };
    await work();

    // 3. The research backlog whose time has come. Free work before paid.
    const due = (await allBacklog(kv).catch(() => [])).filter(b => b.state === 'open' && Date.parse(b.nextTryAt) <= now).sort((a, b) => Date.parse(a.nextTryAt) - Date.parse(b.nextTryAt)).slice(0, 4);
    for (const b of due) {
        if (!timeLeft()) break;
        const p = parseAts(b.job && b.job.url);
        if (!p) continue;
        report.postings++;
        let r;
        try { r = await processPosting(p, { ...(b.provenance || {}), retry: true }, d, report); }
        catch (e) { r = { verdict: 'error', reason: 'run_error', detail: String((e && e.message) || e).slice(0, 120) }; }
        tally(r);
    }

    // 4. New searches, inside the SerpApi budget, and only when nothing paid for is still waiting.
    const waiting = Object.keys((await kv.hgetall(HK.pending)) || {}).length;
    report.pendingBeforeSearch = waiting;
    if (discover && waiting < maxCandidates && timeLeft()) {
        let left = null;
        try { const a = await deps.serpAccount(); left = a.left; report.credits.serpapi = a; } catch (e) { report.credits.serpapi = { error: String(e.message || e).slice(0, 80) }; }
        const usedToday = Number(await kv.get(HK.serpDay(day)).catch(() => 0) || 0);
        const allowed = left == null || !Number.isFinite(left) ? 0 : Math.max(0, Math.min(maxSearches, SERP_DAILY_CAP - usedToday, left - SERP_RESERVE));
        report.searchBudget = { left, reserve: SERP_RESERVE, usedToday, dailyCap: SERP_DAILY_CAP, allowedThisRun: allowed };
        let cursor = Number(await kv.get(HK.cursor).catch(() => 0) || 0);
        for (let i = 0; i < allowed && timeLeft(); i++) {
            const { q, family } = QUERIES[cursor % QUERIES.length];
            cursor++;
            await kv.set(HK.cursor, cursor % QUERIES.length);
            await kv.incr(HK.serpDay(day)); await kv.expire(HK.serpDay(day), 3 * 86400).catch(() => {});
            try {
                const r = await deps.serpSearch(q);
                const posts = (r.links || []).map(l => { const p = parseAts(l); return p ? { ...p, url: l } : null; }).filter(Boolean);
                let added = 0;
                for (const p of posts) { if (await kv.hget(HK.seen, postingKey(p))) continue; await addPending(kv, p, { discoveredBy: 'SerpApi Google search', searchQuery: q, discoveredAt: report.startedAt }, now); added++; }
                // Where the results pointed, so a search that returns only job aggregators is visible in the run log.
                const hosts = [...new Set((r.links || []).map(l => { try { return new URL(l).hostname; } catch { return null; } }).filter(Boolean))].slice(0, 5);
                report.searches.push({ q, family, results: (r.links || []).length, postings: posts.length, queued: added, hosts });
            } catch (e) { report.searches.push({ q, family, error: String(e.message || e).slice(0, 80) }); }
        }
        await work();
    }
    report.pendingAfter = Object.keys((await kv.hgetall(HK.pending)) || {}).length;
    report.finishedAt = new Date().toISOString();
    report.ms = Date.now() - t0;
    await kv.lpush(HK.runs, JSON.stringify(report)).catch(() => {});
    await kv.ltrim(HK.runs, 0, 49).catch(() => {});
    return report;
}
