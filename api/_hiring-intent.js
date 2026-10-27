// Hiring now: businesses with a current job post for a role Staffify fills, called first.
// ------------------------------------------------------------------
// PM for Paul, 2026-10-27: "Stop targeting real estate media/REP agencies" and start "a NEW
// hiring-intent campaign: businesses with CURRENT evidence they are hiring remote administrative,
// customer support/service, scheduling, account-support or similar roles Staffify can fulfill from
// LATAM/Philippines." Its own tracking, its own call-first rule, a human call queue, and "missing
// numbers go to a persistent retry/research backlog, never the ready list".
//
// What makes a record ready, and where each fact comes from:
//   the job       the company's own posting on its applicant tracking system (Lever, Greenhouse,
//                 Ashby), read from that system's public posting API at the time stated.
//                 A search result alone is never enough: it only says where to look.
//   the company   its homepage, admitted only from the job board's own link or a careers page that
//                 links back to that exact board (see "who the company is" below).
//   the number    published on that website (api/_site-phone.js), with the page and the time. It is
//                 the company's line. It is never presented as a person's phone.
//   the contact   Findymail's domain search, then Findymail's verifier, with the status as returned.
//                 No contact is fine (the caller asks for whoever is hiring); no number is not.
// Excluded before anything is spent: staffing and outsourcing firms, large employers, onsite or
// hybrid roles, hard location rules (citizenship, clearance, a state licence), posts older than
// MAX_AGE_DAYS or no longer live. Excluded before a record is offered: opt-outs, clients, anyone
// already in an outreach thread or owned by a person in the CRM, and numbers marked wrong.
//
// Call first means exactly that: no email goes out before the call, no sequence, no AI caller.
// The record is worked by a person in the dialer and nowhere else.
import { createHash } from 'node:crypto';

export const HIRING_ID = 'staffify-hiring-intent';
export const MAX_AGE_DAYS = 45;
// A card is offered only while its posting was confirmed live this recently. The run re-reads the
// oldest ready cards every time (api/_hiring-run.js refreshReady); weekend gaps fit inside this.
export const FRESH_MS = 72 * 3600e3;
export const LARGE_EMPLOYER_OPEN_ROLES = 60;

export const HK = {
    records: 'staffify:hiring:records',     // hash: id -> ready (or worked) record
    backlog: 'staffify:hiring:backlog',     // hash: id -> missing-number / research entry
    seen: 'staffify:hiring:seen',           // hash: posting key -> { at, verdict, reason }
    companies: 'staffify:hiring:companies', // hash: board key -> { id, verdict, at }
    pending: 'staffify:hiring:pending',     // hash: posting key -> { url, provenance, attempts } until a verdict is saved
    runs: 'staffify:hiring:runs',           // list of run reports, newest first
    lock: 'staffify:hiring:lock',
    cursor: 'staffify:hiring:cursor',
    serpDay: day => 'staffify:hiring:serp:' + day,
    contact: domain => 'staffify:hiring:contact:' + domain,
    recLock: id => 'staffify:hiring:lock:' + id,
};

const parse = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
export const parseValue = parse;
export const idFor = key => 'hire:' + createHash('sha256').update(String(key).toLowerCase()).digest('hex').slice(0, 16);

// ---- where to look ---------------------------------------------------------------------------
// Google, restricted to the applicant tracking systems whose postings can be read back for free
// (Lever, Greenhouse, Ashby), over the past week. One search returns up to ten official posting URLs.
export const ROLE_TERMS = {
    support: '("customer support" OR "customer service" OR "customer care" OR "support specialist" OR "support agent" OR "technical support")',
    admin: '("administrative assistant" OR "executive assistant" OR "operations assistant" OR "admin assistant")',
    scheduling: '("scheduler" OR "scheduling coordinator" OR "patient coordinator" OR "dispatcher" OR "intake coordinator")',
    account: '("account coordinator" OR "client success associate" OR "customer success associate" OR "onboarding specialist" OR "account support")',
};
export const ATS_SITES = ['site:jobs.lever.co', 'site:boards.greenhouse.io OR site:job-boards.greenhouse.io', 'site:jobs.ashbyhq.com'];
export const REGIONS = ['("Latin America" OR LATAM OR Philippines) remote', 'remote'];
export const QUERIES = (() => {
    const out = [];
    for (const region of REGIONS) for (const family of Object.keys(ROLE_TERMS)) for (const s of ATS_SITES) out.push({ family, q: `${s} ${ROLE_TERMS[family]} ${region}` });
    return out;
})();

/** The official posting a URL points at, or null. Only systems with a public posting API. */
export function parseAts(url) {
    let u; try { u = new URL(String(url || '')); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const h = u.hostname.toLowerCase(), parts = u.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const slug = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,80}$/;
    if (h === 'jobs.lever.co' && slug.test(parts[0] || '') && uuid.test(parts[1] || '')) return { ats: 'lever', board: parts[0], id: parts[1].toLowerCase() };
    if ((h === 'boards.greenhouse.io' || h === 'job-boards.greenhouse.io') && slug.test(parts[0] || '') && parts[1] === 'jobs' && /^\d{4,14}$/.test(parts[2] || '')) return { ats: 'greenhouse', board: parts[0], id: parts[2] };
    if (h === 'boards.greenhouse.io' && parts[0] === 'embed' && u.searchParams.get('for') && /^\d{4,14}$/.test(u.searchParams.get('token') || '')) return { ats: 'greenhouse', board: u.searchParams.get('for'), id: u.searchParams.get('token') };
    if (h === 'jobs.ashbyhq.com' && slug.test(parts[0] || '') && uuid.test(parts[1] || '')) return { ats: 'ashby', board: parts[0], id: parts[1].toLowerCase() };
    return null;
}
export const postingKey = p => `${p.ats}:${String(p.board).toLowerCase()}:${p.id}`;
export const boardKey = p => `${p.ats}:${String(p.board).toLowerCase()}`;
// The same employer can move ATS or run two boards: once its website is confirmed, the domain is a key too.
export const domainKey = d => 'domain:' + String(d || '').toLowerCase().replace(/^www\./, '');

// ---- what a posting has to be ----------------------------------------------------------------
// The work Staffify places: support, admin, scheduling, account coordination. Leadership, sales,
// engineering and licensed clinical roles are not.
const ROLE_FIT = [
    ['support', /\b(customer|client|member|guest|player|patient|user)\s+(support|service|care|experience|happiness|success)\b|\bsupport\s+(agent|specialist|representative|rep|associate|advocate)\b|\b(technical|tech|it|product|l1|tier\s*1|level\s*1)\s+support\b|\bhelp\s*desk\b|\bcall\s+cent(er|re)\b/i],
    ['admin', /\b(administrative|admin|executive|personal|virtual|operations|office|team)\s+assistant\b|\badministrative\s+(coordinator|specialist|associate)\b|\bdata\s+entry\b|\bback\s+office\b/i],
    ['scheduling', /\bschedul(er|ing)\b|\bdispatch(er)?\b|\b(patient|intake|appointment|care)\s+(coordinator|setter|specialist)\b|\breceptionist\b|\bfront\s+desk\b/i],
    ['account', /\b(account|client|customer)\s+(coordinator|support|associate|onboarding)\b|\bonboarding\s+(specialist|coordinator|associate)\b|\b(customer|client)\s+success\s+(associate|coordinator|specialist|representative)\b|\bimplementation\s+(specialist|coordinator)\b/i],
];
const NOT_FILLABLE = /\b(director|head\s+of|vp|vice\s+president|chief|principal|staff\s+engineer|engineer|developer|architect|scientist|attorney|lawyer|counsel|physician|nurse|\brn\b|lpn|pharmacist|therapist|account\s+executive|sales\s+(rep|representative|development)|sdr|bdr|recruiter|intern(ship)?)\b/i;
const SENIOR = /\b(manager|lead|supervisor|senior|sr\.?)\b/i;

/** The role family a title belongs to, or null when it is not work Staffify places. */
export function roleFamily(title) {
    const t = String(title || '');
    if (!t || NOT_FILLABLE.test(t)) return null;
    // "Customer Support Manager" is a leader; "Customer Support Specialist (Senior)" is still a seat we
    // could fill, but a manager or team lead is not.
    if (/\b(manager|lead|supervisor)\b/i.test(t) && !/\bassistant\b/i.test(t)) return null;
    for (const [family, re] of ROLE_FIT) if (re.test(t)) return family;
    return null;
}
export const seniorTitle = title => SENIOR.test(String(title || ''));

// Staffing, recruiting, BPO and outsourcing firms are competitors, not buyers. Also job boards
// reposting someone else's role.
const COMPETITOR = /\b(staffing|recruit(ing|ment)\s+(agency|firm|partner|solutions)|talent\s+(solutions|partners|agency)|outsourc(e|ing)|\bbpo\b|offshore\s+(team|staff)|virtual\s+assistant\s+(company|agency|services)|on\s+behalf\s+of\s+(our|a)\s+client|our\s+client\s+is\s+(seeking|looking|hiring)|employer\s+of\s+record|nearshore\s+(staffing|talent))\b/i;
const COMPETITOR_NAMES = /\b(taskus|teleperformance|concentrix|ttec|alorica|sitel|foundever|startek|boldr|support\s*ninja|supportyourapp|helpware|belay|time\s*etc|prialto|wing\s+assistant|athena|magic\s+(virtual|assistant)|myoutdesk|virtual\s+staff\s+finder|cloudstaff|remote\s+staff|staffify|hirequotient|toptal|upwork|crossover|turing|andela|lemon\.io|bairesdev|near\s+(inc|staffing)|somewhere\.com|stealth\s+agents|go\s*remote|hire\s+overseas|support\s*shepherd|peak\s+support|influx|simplycontact|partnerhero|hugo|working\s+solutions|liveops|arise|transcom|ibex|ubiquity|5ca|everise|telus\s+international|qualfon|itel|global\s+lingo)\b/i;

/** Why a company is a competitor (they sell what Staffify sells), or null. */
export function competitorReason({ company, text }) {
    if (COMPETITOR_NAMES.test(String(company || ''))) return 'a staffing or outsourcing firm by name';
    const t = String(text || '');
    const m = t.match(COMPETITOR);
    if (m) return 'the post describes a staffing, recruiting or outsourcing business ("' + m[0].slice(0, 60) + '")';
    return null;
}

// Location rules. HARD rules mean a person outside the country cannot do the work at all, so a remote
// hire through Staffify is not an answer: citizenship, clearance, government work, a state licence.
// SOFT rules ("US-based", "authorized to work in the US") are about who the employer hires directly;
// placing a managed remote team member is a different arrangement, so the record keeps them and the
// caller is told.
const HARD = [
    [/\b(u\.?s\.?|united\s+states|american)\s+citizen(ship)?\b/i, 'requires US citizenship'],
    [/\bsecurity\s+clearance\b|\bclearance\s+(required|eligible)\b|\bpublic\s+trust\b/i, 'requires a security clearance'],
    [/\bitar\b|\bexport[- ]controlled\b/i, 'export-controlled work (ITAR)'],
    [/\b(licensed|license|licence)\s+(in|insurance|agent|producer)\b|\bnmls\b|\bseries\s+(6|7|63|65)\b/i, 'requires a state or financial licence'],
    [/\bmust\s+(be\s+able\s+to\s+)?(commute|work\s+on[- ]?site|report\s+to\s+(the|our)\s+office)\b|\bon[- ]?site\s+(only|required)\b|\bin[- ]office\s+(only|required)\b/i, 'onsite attendance required'],
];
const SOFT = [
    [/\b(must|should)\s+(be\s+)?(reside|live|located|based)\s+in\s+(the\s+)?(u\.?s\.?a?|united\s+states|us)\b|\b(u\.?s\.?|us)[- ]based\s+(only|candidates|applicants)\b|\bremote\s*[(,-]?\s*(u\.?s\.?a?|us|usa|united\s+states)(?![a-z])\s*(only)?\s*\)?/i, 'asks for US-based applicants'],
    [/\b(legally\s+)?authori[sz]ed\s+to\s+work\s+in\s+(the\s+)?(u\.?s\.?|united\s+states|us)\b/i, 'asks for US work authorization'],
    [/\b(must|should)\s+(be\s+)?(reside|live|located|based)\s+in\s+(canada|the\s+uk|united\s+kingdom|europe|australia)\b/i, 'asks for applicants in one country'],
    [/\b(est|eastern|pst|pacific|cst|central)\s+(time|hours|business\s+hours)\b/i, 'works US business hours'],
];
const OFFSHORE = /\b(latin\s+america|latam|south\s+america|central\s+america|mexico|colombia|argentina|brazil|chile|peru|costa\s+rica|philippines|manila|cebu|anywhere\s+in\s+the\s+world|worldwide|global(ly)?\s+remote)\b/i;

/** The restrictions a post states, split into hard (exclude) and soft (keep, tell the caller). */
export function restrictions(text) {
    const t = String(text || '');
    const hard = HARD.filter(([re]) => re.test(t)).map(([, why]) => why);
    const soft = SOFT.filter(([re]) => re.test(t)).map(([, why]) => why);
    const offshore = (t.match(OFFSHORE) || [null])[0];
    return { hard, soft, offshore: offshore ? offshore.replace(/\s+/g, ' ') : null };
}

/** Days since a date, whole days, or null. */
export function ageDays(at, now = Date.now()) {
    const t = typeof at === 'number' ? at : Date.parse(at || '');
    return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 864e5)) : null;
}

/**
 * The verdict on one official posting, before anything is spent on the company. Returns
 * { ok:true, family, restrictions } or { ok:false, reason, detail }.
 */
export function qualifyPosting(p, now = Date.now()) {
    if (!p || !p.live) return { ok: false, reason: 'closed_post', detail: 'The posting is no longer live on their careers page.' };
    const family = roleFamily(p.title);
    if (!family) return { ok: false, reason: 'role_not_fillable', detail: `"${p.title}" is not a support, admin, scheduling or account role Staffify places.` };
    const age = ageDays(p.postedAt, now);
    if (age != null && age > MAX_AGE_DAYS) return { ok: false, reason: 'stale_post', detail: `Posted ${age} days ago; older than ${MAX_AGE_DAYS} days.` };
    const comp = competitorReason({ company: p.company, text: p.text });
    if (comp) return { ok: false, reason: 'competitor', detail: comp };
    if (p.workplace === 'onsite' || p.workplace === 'hybrid') return { ok: false, reason: 'not_remote', detail: `The role is ${p.workplace}.` };
    const where = [p.location, ...(p.locations || []), p.text].join(' ');
    if (p.workplace !== 'remote' && !/\bremote\b|work\s+from\s+home|\bwfh\b|anywhere/i.test(where)) return { ok: false, reason: 'not_remote', detail: 'The post does not say the role is remote.' };
    const r = restrictions(where);
    if (r.hard.length) return { ok: false, reason: 'hard_restriction', detail: 'The post ' + r.hard.join(' and ') + '.' };
    if (p.openRoles != null && p.openRoles > LARGE_EMPLOYER_OPEN_ROLES) return { ok: false, reason: 'large_employer', detail: `${p.openRoles} open roles on their board; we prioritize small and midsize businesses.` };
    return { ok: true, family, age, restrictions: r };
}

/** Higher first. LATAM or Philippines in the post, a fresh post, a small board, a named contact. */
export function priorityOf({ age, restrictions: r = {}, openRoles, contact }) {
    let s = 0;
    if (r.offshore) s += 3;
    if (age != null) s += age <= 7 ? 2 : age <= 14 ? 1 : 0;
    if (openRoles != null) s += openRoles <= 25 ? 2 : openRoles <= LARGE_EMPLOYER_OPEN_ROLES ? 1 : 0;
    if (contact && contact.status === 'verified') s += 1;
    if (r.soft && r.soft.some(x => /US-based|one country/.test(x))) s -= 1;
    return s;
}

// ---- who the company is ----------------------------------------------------------------------
// PM, 2026-10-27: "a guessed boardname.com homepage containing the brand word alone is insufficient
// (one-word companies collide). Prefer the official job board's linked company homepage or the
// company's careers backlink to that exact ATS board; unresolved identity belongs in research, not
// phone-ready." So a website is admitted two ways only:
//   board_link   the hiring system's own page names the homepage: Lever's "<company> Home Page"
//                link, Ashby's publicWebsite. The company set that link in its own job board.
//   backlink     a candidate site whose homepage or careers page links to this exact board
//                (jobs.lever.co/<board>, greenhouse.io/<board>, jobs.ashbyhq.com/<board>).
// A name on a page proves nothing on its own, and the number we would dial comes from that site.
const NOT_A_HOMEPAGE = /(lever\.co|greenhouse\.io|ashbyhq\.com|workable\.com|linkedin\.com|glassdoor|indeed|google\.|gstatic|facebook|twitter|(?:^|[/.])x\.com(?:[/:]|$)|instagram|youtube|bit\.ly|notion\.site|eeoc\.gov|dol\.gov|recaptcha|cloudflare|w3\.org|schema\.org|sentry|jsdelivr|unpkg|cdn\.|doubleclick|hubspot|calendly)/i;
const hostOf = u => { try { const x = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u); return x.hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
export { hostOf };

/** The homepage the hiring system's own posting page names, or null. */
export function boardHomepage(ats, html) {
    const h = String(html || '');
    if (ats === 'lever') {
        for (const m of h.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]{0,80})<\/a>/gi)) if (/home\s*page/i.test(m[2]) && !NOT_A_HOMEPAGE.test(m[1])) return m[1];
        return null;
    }
    if (ats === 'ashby') {
        const m = h.match(/"publicWebsite"\s*:\s*"(https?:\/\/[^"]+)"/i);
        return m && !NOT_A_HOMEPAGE.test(m[1]) ? m[1].replace(/\\u002F/gi, '/') : null;
    }
    return null;
}

/** Strings that prove a page links to this exact board. */
export function boardMarkers(p) {
    const b = String(p.board || '').toLowerCase();
    if (p.ats === 'lever') return ['jobs.lever.co/' + b, 'api.lever.co/v0/postings/' + b];
    if (p.ats === 'greenhouse') return ['greenhouse.io/' + b + '/', 'greenhouse.io/' + b + '"', "greenhouse.io/" + b + "'", 'greenhouse.io/embed/job_board?for=' + b, 'greenhouse.io/embed/job_board/js?for=' + b, 'boards/' + b + '/jobs'];
    if (p.ats === 'ashby') return ['jobs.ashbyhq.com/' + b, 'ashbyhq.com/' + b];
    return [];
}
export function linksToBoard(html, p) {
    const h = String(html || '').toLowerCase().replace(/\\\//g, '/');
    // The board name has to end where the marker ends: jobs.lever.co/acme is not jobs.lever.co/acmecorp.
    return boardMarkers(p).some(m => { const esc = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return new RegExp(esc + (/[/"']$/.test(m) ? '' : '(?![a-z0-9_.-])')).test(h); });
}

/** Sites worth checking for a backlink: links on the posting or board text, then the board's own name. */
export function websiteCandidates({ company, board, links = [] }) {
    const out = [];
    const add = u => { const h = hostOf(u); if (h && !NOT_A_HOMEPAGE.test(h) && /\.[a-z]{2,}$/.test(h) && !out.includes(h)) out.push(h); };
    for (const l of links) add(l);
    const slug = String(board || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const joined = String(company || '').toLowerCase().replace(/&/g, 'and').replace(/\b(inc|llc|ltd|corp|co|company|the)\b/g, '').replace(/[^a-z0-9]/g, '');
    for (const base of [...new Set([slug, joined].filter(x => x && x.length >= 3))]) for (const tld of ['.com', '.io', '.co', '.ai']) add(base + tld);
    return out.slice(0, 6);
}
/** Outbound links on a page, for websiteCandidates. */
export const outboundLinks = html => [...new Set([...String(html || '').matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^"'\s<>)]*/gi)].map(m => m[0]))].filter(u => !NOT_A_HOMEPAGE.test(u)).slice(0, 40);
/** Careers-looking links on a homepage, same site only. */
export function careersLinks(page, limit = 2) {
    let origin; try { origin = new URL(page.url).origin; } catch { return []; }
    const out = [];
    for (const m of String(page.html || '').matchAll(/href\s*=\s*["']([^"'#]+)["'][^>]*>([^<]{0,60})/gi)) {
        if (!/career|jobs|join|hiring|work[- ]with[- ]us/i.test(m[1] + ' ' + m[2])) continue;
        let u; try { u = new URL(m[1], page.url); } catch { continue; }
        if (u.origin !== origin) continue;
        const s = u.href.split('#')[0];
        if (!out.includes(s)) out.push(s);
        if (out.length >= limit) break;
    }
    return out;
}

// ---- the record ------------------------------------------------------------------------------
export const firstNameOf = name => { const f = String(name || '').trim().split(/\s+/)[0] || ''; return /^[A-Za-z][A-Za-z'’-]{0,30}$/.test(f) ? f[0].toUpperCase() + f.slice(1) : ''; };
const FAMILY_WORDS = { support: 'customer support', admin: 'admin', scheduling: 'scheduling', account: 'account support' };
export const familyWords = f => FAMILY_WORDS[f] || 'support';

/** The short researched brief a caller reads before dialling. Facts only, each one sourced on the record. */
export function briefFor(rec) {
    const j = rec.job || {}, c = rec.company || {}, r = j.restrictions || {};
    const when = j.ageDays == null ? 'is live' : j.ageDays === 0 ? 'went up today' : j.ageDays === 1 ? 'went up yesterday' : `went up ${j.ageDays} days ago`;
    const where = r.offshore ? ` They list it as open to candidates in ${r.offshore}, which is where our people are.` : '';
    const caveat = (r.soft || []).length ? ` Note: the post ${r.soft.join(' and ')}. That is about who they hire directly; a managed placement is a different arrangement, so ask rather than assume.` : '';
    const more = (rec.jobs || []).length > 1 ? ` They have ${rec.jobs.length} matching roles open.` : '';
    return {
        summary: `${c.name} is hiring a ${j.title}. The post ${when} and was still open on their careers page when we checked.${where}${more}`,
        need: `A ${familyWords(rec.family)} hire: ${j.title}${j.location ? ' (' + j.location + ')' : ''}.${caveat}`,
        nextStep: 'Book a short call with Paul to scope the role, so we only send people who fit.',
    };
}

/** A hiring record as the dialer's shared call view expects a card. */
export function callRow(rec, viewer, now = Date.now()) {
    const me = String(viewer || '').toLowerCase();
    const owner = rec.callOwner || null;
    const mine = !!owner && String(owner).toLowerCase() === me;
    const ready = hiringCallReady(rec, now);
    const p = rec.phone || {};
    return {
        id: rec.id, campaignId: HIRING_ID, kind: 'hiring', callQueue: 'shared',
        company: rec.company && rec.company.name || null,
        recipient: rec.contact && rec.contact.email || null,
        verifiedFirstName: rec.contact && rec.contact.firstName || '',
        website: rec.company && rec.company.website || null,
        owner: null, salesOwner: null, sender: null, threadId: null, sentTouches: 0, verifiedSentTouches: 0, lastSentAt: null,
        status: rec.status, callReady: ready, callOutcome: rec.callOutcome || null, nextCallAt: rec.nextCallAt || null,
        callOwner: owner, callOwnerAt: rec.callOwnerAt || null, callHistory: rec.callHistory || [],
        claimed: !!owner, mine, unclaimed: ready && !owner, dueForMe: ready && mine, pausedFollowUp: false,
        phone: p.number || null,
        callContact: { phone: p.number || null, phoneStatus: p.number ? 'site_main' : 'missing', phoneSource: 'Published on their website', phoneSourceUrl: p.sourceUrl || null, phoneAlternates: p.alternates || [], phoneCheckedAt: p.checkedAt || null, phoneDetail: 'The company line from their own website, not a direct line.' },
        industry: { key: 'hiring', label: 'Hiring now', source: 'job post' },
        hiring: { title: rec.job && rec.job.title, url: rec.job && rec.job.url, postedAt: rec.job && rec.job.postedAt, checkedAt: rec.job && rec.job.checkedAt, jobState: rec.job && rec.job.state || 'open', location: rec.job && rec.job.location, priority: rec.priority || 0, offshore: !!(rec.job && rec.job.restrictions && rec.job.restrictions.offshore) },
    };
}

const RETRY = ['no_answer', 'voicemail', 'callback', 'gatekeeper', 'timing'];
const PROMISED = ['callback', 'gatekeeper', 'timing'];
/** The posting was confirmed live recently enough to call about it. */
export function jobCurrent(rec, now = Date.now()) {
    const j = rec && rec.job;
    if (!j || j.state === 'closed' || j.state === 'stale') return false;
    return Date.parse(j.checkedAt) > now - FRESH_MS;
}
/**
 * Due for a call now. A card nobody has worked needs a live, recently checked post: the post is
 * the reason for the call. A time someone promised (callback, gatekeeper, "try me later") stays
 * due for its owner even if the post has since closed: the promise was to a person, and the card
 * says the job closed. A plain no-answer retry on a closed or unchecked post is not offered.
 */
export function hiringCallReady(rec, now = Date.now()) {
    if (!rec || rec.status !== 'ready' || !rec.phone || !rec.phone.number) return false;
    if (!rec.callOutcome) return jobCurrent(rec, now);
    if (!RETRY.includes(rec.callOutcome) || !rec.nextCallAt || Date.parse(rec.nextCallAt) > now) return false;
    return PROMISED.includes(rec.callOutcome) && !!rec.callOwner ? true : jobCurrent(rec, now);
}

/**
 * A caller's outcome applied to a hiring record. Same rules as the email campaigns' controlState:
 * the first outcome claims the follow-up, retries need a future time, and a card that is no longer
 * due is refused rather than written over. Returns the new record or throws.
 */
export function applyOutcome(rec, { outcome, notes, nextCallAt, dialled }, caller, now = Date.now()) {
    if (!rec) throw Error('This prospect is no longer in the call queue');
    const valid = ['connected', 'no_answer', 'voicemail', 'callback', 'gatekeeper', 'timing', 'wrong_number', 'suppress'];
    if (!valid.includes(outcome)) throw Error('Invalid outcome');
    // An owned callback can be covered by anyone; a card nobody can call is refused.
    if (!hiringCallReady(rec, now)) throw Error('Call is no longer due');
    if (RETRY.includes(outcome) && !(Date.parse(nextCallAt) > now)) throw Error('Choose a future callback time');
    const at = new Date(now).toISOString();
    const d = String(dialled || '').replace(/\D/g, '').slice(-10);
    const entry = { outcome, notes: String(notes || '').slice(0, 4000), at, caller, nextCallAt: RETRY.includes(outcome) ? nextCallAt : null, ...(d.length === 10 ? { dialled: '+1' + d } : {}) };
    const status = outcome === 'connected' ? 'conversation' : outcome === 'wrong_number' ? 'number_research' : outcome === 'suppress' ? 'suppressed' : 'ready';
    return { ...rec, status, callOutcome: outcome, nextCallAt: entry.nextCallAt, callOwner: rec.callOwner || caller, callOwnerAt: rec.callOwnerAt || at, callHistory: [...(rec.callHistory || []), entry], updatedAt: at };
}

// ---- store helpers ---------------------------------------------------------------------------
export async function allRecords(kv) {
    const all = (await kv.hgetall(HK.records)) || {};
    return Object.values(all).map(parse).filter(Boolean);
}
export async function getRecord(kv, id) { return parse(await kv.hget(HK.records, id)); }
export async function putRecord(kv, rec) { await kv.hset(HK.records, { [rec.id]: JSON.stringify(rec) }); return rec; }
export async function allBacklog(kv) {
    const all = (await kv.hgetall(HK.backlog)) || {};
    return Object.values(all).map(parse).filter(Boolean);
}
export async function putBacklog(kv, entry) { await kv.hset(HK.backlog, { [entry.id]: JSON.stringify(entry) }); return entry; }

/** When a backlog entry is next worth trying: a day, then three, then a week, then it rests. */
export function nextTry(attempts, now = Date.now()) {
    const days = [1, 3, 7][attempts - 1];
    return days ? new Date(now + days * 864e5).toISOString() : null;
}

/** Every hiring card, worked or not, in the queue's row shape: for the daily report, reviews and campaign counts. */
export async function hiringReportRows(kv, now = Date.now()) {
    return (await allRecords(kv)).map(r => callRow(r, null, now));
}
/** Every hiring card for the dialer, in the shared call view's shape. A store that fails gives none. */
export async function hiringCallRows(kv, viewer, now = Date.now()) {
    const recs = await allRecords(kv);
    return recs.filter(r => r.status === 'ready' || r.callOwner).map(r => callRow(r, viewer, now));
}
