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
// Paul, 2026-10-28: "job postings ... might be good today, but they could have filled that role tomorrow,
// which I'm fine with. But we really don't want to be looking at data over like a very long span of time."
// A post older than MAX_AGE_DAYS is not called about; Google Jobs searches only look back DISCOVERY_DAYS.
export const MAX_AGE_DAYS = 14;
export const DISCOVERY_DAYS = 7;
// A card is offered only while its posting was confirmed live this recently. The run re-reads the
// oldest ready cards every time (api/_hiring-run.js refreshReady); weekend gaps fit inside this.
export const FRESH_MS = 72 * 3600e3;
export const LARGE_EMPLOYER_OPEN_ROLES = 60;
// Above this head count on Google's company panel, an employer has its own recruiting team.
export const LARGE_EMPLOYEES = 500;

export const HK = {
    records: 'staffify:hiring:records',     // hash: id -> ready (or worked) record
    backlog: 'staffify:hiring:backlog',     // hash: id -> missing-number / research entry
    seen: 'staffify:hiring:seen',           // hash: posting key -> { at, verdict, reason }
    companies: 'staffify:hiring:companies', // hash: board key -> { id, verdict, at }
    pending: 'staffify:hiring:pending',     // hash: posting key -> { url, provenance, attempts } until a verdict is saved
    runs: 'staffify:hiring:runs',           // list of run reports, newest first
    lock: 'staffify:hiring:lock',
    cursor: 'staffify:hiring:cursor',
    jobsCursor: 'staffify:hiring:jobs-cursor', // position in JOB_QUERIES (role x city)
    profile: key => 'staffify:hiring:profile:' + key, // Google business listing per employer, misses too, 30 days
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
// Searched: Ashby only. On 2026-10-27 Google, through SerpApi, ignored site: for jobs.lever.co and the
// Greenhouse boards (five test searches, every result an aggregator such as Indeed or Glassdoor, zero
// postings), while site:jobs.ashbyhq.com returned postings. Lever and Greenhouse URLs are still read
// and admitted when they arrive as seeds or from a company's own board; they are just not searched for.
export const ATS_SITES = ['site:jobs.ashbyhq.com'];
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
// The work Staffify places: support, admin, scheduling, account coordination and phone sales.
// Leadership, closing, engineering and licensed clinical roles are not.
const EXPLICIT_SALES = /\b(inside|telephone|phone|outbound|inbound|remote)\s+sales\b|\bsales\s+(development|coordinator|assistant|support|admin(istrator)?)\b|\b(sdr|bdr)\b|\bappointment\s+setter\b|\blead\s+gen(eration)?\b|\bbusiness\s+development\s+(representative|rep|associate)\b|\btelesales\b|\btelemarket(ing|er)\b/i;
const BARE_SALES = /\bsales\s+(representative|rep|associate|specialist|consultant|agent)\b/i;
const PHONE_SALES = /\b(inside\s+sales|phone|calls?|calling|outbound|inbound|remote|crm|book(ing)?\s+appointments|cold\s+call|leads?)\b/i;
const FIELD_SALES = /\b(territory|showroom|sales\s+floor|our\s+lot|dealership|door[- ]to[- ]door|in[- ]home|in[- ]person\s+(visits|meetings)|travel\s+to|visit\s+(customers|clients|prospects)|retail\s+store|walk[- ]in)\b/i;
/** Is a bare sales title a phone seat? Explicit inside/SDR titles always are; otherwise the post has to say so. */
export function salesSeatOk(title, text) {
    if (EXPLICIT_SALES.test(String(title || '')) || !BARE_SALES.test(String(title || ''))) return true;
    const t = String(text || '');
    return PHONE_SALES.test(t) && !FIELD_SALES.test(t);
}
const ROLE_FIT = [
    ['support', /\b(customer|client|member|guest|player|patient|user)\s+(support|service|care|experience|happiness|success)\b|\bsupport\s+(agent|specialist|representative|rep|associate|advocate)\b|\b(technical|tech|it|product|l1|tier\s*1|level\s*1)\s+support\b|\bhelp\s*desk\b|\bcall\s+cent(er|re)\b/i],
    ['admin', /\b(administrative|admin|executive|personal|virtual|operations|office|team)\s+assistant\b|\badministrative\s+(coordinator|specialist|associate)\b|\boffice\s+admin(istrator)?\b|\bdata\s+entry\b|\bback\s+office\b/i],
    ['scheduling', /\bschedul(er|ing)\b|\bdispatch(er)?\b|\b(patient|intake|appointment|care)\s+(coordinator|specialist)\b|\breceptionist\b|\bfront\s+desk\b/i],
    // Paul, 2026-10-28: "remote teams, like customer service, sales, and admin support". Sales here is the
    // seat that books and qualifies (inside sales, SDR/BDR, appointment setting), not a closer or a manager.
    ['sales', EXPLICIT_SALES],
    // A bare "Sales Representative" or "Sales Associate" is often a showroom, lot or territory job: it is a
    // phone seat only when the post says so (salesSeatOk, checked where the description is known).
    ['sales', BARE_SALES],
    ['account', /\b(account|client|customer)\s+(coordinator|support|associate|onboarding)\b|\bonboarding\s+(specialist|coordinator|associate)\b|\b(customer|client)\s+success\s+(associate|coordinator|specialist|representative)\b|\bimplementation\s+(specialist|coordinator)\b/i],
];
const NOT_FILLABLE = /\b(director|head\s+of|vp|vice\s+president|chief|principal|staff\s+engineer|engineer|developer|architect|scientist|attorney|lawyer|counsel|physician|nurse|\brn\b|lpn|pharmacist|therapist|account\s+executive|recruiter|intern(ship)?)\b/i;
// Work that needs a body in a place: no remote person can do it, whatever the title says.
// Always physical: the seat itself is a place. Sometimes physical: a word that is a seat on its own
// ("Driver", "HVAC Technician") but only a department next to a remote-capable seat ("Field Service
// Dispatcher", "Help Desk Technician", "Customer Service Representative - Driver Support").
const PHYSICAL = /\b(store|in[- ]store|retail|cashier|warehouse|valet|housekeep(er|ing)|janitor|custodian|cook|barista|bartender|caregiver|security\s+(officer|guard)|guard|merchandiser|stocker|loader|forklift|hotel|front\s+desk\s+agent|showroom|dealership|door[- ]to[- ]door|outside\s+sales|territory|route\s+sales|911|police|emergency|on[- ]site\s+only)\b/i;
const PHYSICAL_SEAT = /\b(field|driver|delivery|technician|installer|courier|porter|mechanic|server)\b/i;
const REMOTE_SEAT = /\b(help\s*desk|support|dispatch(er|ing)?|schedul(er|ing)|coordinator|customer\s+service|call\s+cent(er|re)|representative|specialist|assistant|admin(istrator)?|receptionist|sales\s+development|inside\s+sales|appointment\s+setter)\b/i;
const SENIOR = /\b(manager|lead|supervisor|senior|sr\.?)\b/i;

/** The role family a title belongs to, or null when it is not work Staffify places. */
export function roleFamily(title) {
    const t = String(title || '');
    if (!t || NOT_FILLABLE.test(t) || PHYSICAL.test(t)) return null;
    if (PHYSICAL_SEAT.test(t) && !REMOTE_SEAT.test(t)) return null;
    // "Customer Support Manager" is a leader; "Customer Support Specialist (Senior)" is still a seat we
    // could fill, but a manager or team lead is not.
    if (/\b(manager|lead(?!\s+gen)|supervisor)\b/i.test(t) && !/\bassistant\b/i.test(t)) return null;
    for (const [family, re] of ROLE_FIT) if (re.test(t)) return family;
    return null;
}
export const seniorTitle = title => SENIOR.test(String(title || ''));

// Staffing, recruiting, BPO and outsourcing firms are competitors, not buyers. Also job boards
// reposting someone else's role.
const COMPETITOR = /\b(staffing|recruit(ing|ment)\s+(agency|firm|partner|solutions)|talent\s+(solutions|partners|agency)|outsourc(e|ing)|\bbpo\b|offshore\s+(team|staff)|virtual\s+assistant\s+(company|agency|services)|on\s+behalf\s+of\s+(our|a)\s+client|our\s+client\s+is\s+(seeking|looking|hiring)|employer\s+of\s+record|nearshore\s+(staffing|talent))\b/i;
const COMPETITOR_NAMES = /\b(taskus|teleperformance|concentrix|ttec|alorica|sitel|foundever|startek|boldr|support\s*ninja|supportyourapp|helpware|belay|time\s*etc|prialto|wing\s+assistant|athena|magic\s+(virtual|assistant)|myoutdesk|virtual\s+staff\s+finder|cloudstaff|remote\s+staff|staffify|hirequotient|toptal|upwork|crossover|turing|andela|lemon\.io|bairesdev|near\s+(inc|staffing)|somewhere\.com|stealth\s+agents|go\s*remote|hire\s+overseas|support\s*shepherd|peak\s+support|influx|simplycontact|partnerhero|hugo|working\s+solutions|liveops|arise|transcom|ibex|ubiquity|5ca|everise|telus\s+international|qualfon|itel|global\s+lingo|randstad|robert\s+half|kelly\s+services|adecco|aerotek|manpower|insight\s+global|teksystems|express\s+employment|spherion|nextsource|frontline\s+source|spectraforce|beacon\s+hill|addison\s+group|vaco|aston\s+carter|peopleready|labor\s+finders|tandym|apex\s+systems|volt\s+workforce|allegis|kforce|ajilon|accountemps|officeteam|appleone|snelling|staffmark|employbridge|prolink|actalent|maximus|jobot|cybercoders|medix|hays|michael\s+page|lhh|korn\s+ferry|akkodis|collabera|cynet|mindlance|russell\s+tobin|solomon\s+page|24\s+seven|hirequest|trueblue|nesco|labormax|sutherland|conduent|iqor|sykes|vxi|alorica|green\s+key|vaco|lasalle\s+network|atrium|bluecrew|instawork|wonolo|veterans\s+sourcing)\b|\bmanpower\w*|^\s*kelly\s*$/i;
const STAFFING_IN_NAME = /\w*staff(ing|ers)?\b|\bstaff\w*|\brecruit\w*|\bresourcing\b|\bpersonnel\b|\bemployment\s+(agency|services|solutions)\b|\btemps?\b|\btemporary\s+(staffing|services|employment)\b|\bworkforce\b|\btalent\w*|\bsearch\s+(group|partners)\b|\bplacements?\b|\bhire\s*velocity\b/i;

/** Why a company is a competitor (they sell what Staffify sells), or null. */
export function competitorReason({ company, text }) {
    if (COMPETITOR_NAMES.test(String(company || ''))) return 'a staffing or outsourcing firm by name';
    if (STAFFING_IN_NAME.test(String(company || ''))) return 'a staffing or recruiting firm by its name';
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
    [/\b(licensed|license|licence)\s+(in|insurance|agent|producer|required)\b|\b(license|licence)\s+is\s+required\b|\bnmls\b|\bseries\s+(6|7|63|65)\b|\bp\s*&\s*c\b|\bproperty\s+(and|&)\s+casualty\b|\blife\s+(and|&)\s+health\b|\b(2-15|2-20|4-40)\b/i, 'requires a state or financial licence'],
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

// ---- Google Jobs: the loop that does not run dry ----------------------------------------------
// The ATS searches above reach one system (Ashby) and repeat within a day. Google Jobs, searched by
// role and city and limited to the last few days, returns local employers hiring for the seats
// Staffify fills, whether they posted the job as remote or in the office: a business hiring a front
// desk admin in Dallas can fill that seat with a remote person (Paul, 2026-10-28: "open positions
// that they have that can be filled remotely by us"). Every role here is one a remote person does.
export const JOB_TERMS = [
    ['support', 'customer service representative'], ['support', 'customer support specialist'],
    ['admin', 'administrative assistant'], ['admin', 'executive assistant'], ['admin', 'office administrator'],
    ['scheduling', 'receptionist'], ['scheduling', 'scheduling coordinator'], ['scheduling', 'dispatcher'],
    ['sales', 'inside sales representative'], ['sales', 'appointment setter'], ['sales', 'sales development representative'],
    ['account', 'account coordinator'],
    // Widened 2026-10-28 for two full-time callers (Paul: "3 to 5 is just impossible").
    ['support', 'call center representative'], ['support', 'customer care representative'], ['admin', 'data entry clerk'],
    ['scheduling', 'patient coordinator'], ['scheduling', 'intake coordinator'], ['sales', 'sales assistant'],
];
export const METROS = [
    'New York, New York', 'Los Angeles, California', 'Chicago, Illinois', 'Dallas, Texas', 'Houston, Texas', 'Phoenix, Arizona',
    'Philadelphia, Pennsylvania', 'San Antonio, Texas', 'San Diego, California', 'Austin, Texas', 'Jacksonville, Florida', 'Columbus, Ohio',
    'Charlotte, North Carolina', 'Indianapolis, Indiana', 'Denver, Colorado', 'Seattle, Washington', 'Nashville, Tennessee', 'Atlanta, Georgia',
    'Miami, Florida', 'Tampa, Florida', 'Orlando, Florida', 'Boston, Massachusetts', 'Las Vegas, Nevada', 'Salt Lake City, Utah',
    'Raleigh, North Carolina', 'Kansas City, Missouri', 'St. Louis, Missouri', 'Minneapolis, Minnesota', 'Detroit, Michigan', 'Pittsburgh, Pennsylvania',
    'Cincinnati, Ohio', 'Cleveland, Ohio', 'Sacramento, California', 'Portland, Oregon', 'Baltimore, Maryland', 'Richmond, Virginia',
    'Oklahoma City, Oklahoma', 'Louisville, Kentucky', 'Milwaukee, Wisconsin', 'Fort Lauderdale, Florida', 'West Palm Beach, Florida', 'Scottsdale, Arizona',
    'San Jose, California', 'Fort Worth, Texas', 'El Paso, Texas', 'Memphis, Tennessee', 'Albuquerque, New Mexico', 'Tucson, Arizona',
    'Fresno, California', 'Omaha, Nebraska', 'Colorado Springs, Colorado', 'Virginia Beach, Virginia', 'Tulsa, Oklahoma', 'New Orleans, Louisiana',
    'Birmingham, Alabama', 'Buffalo, New York', 'Greenville, South Carolina', 'Boise, Idaho', 'Des Moines, Iowa', 'Knoxville, Tennessee',
];
/** The (role, city) pairs in rotation order: every role in one city, then the next city. */
export const JOB_QUERIES = (() => {
    const out = [];
    for (const city of METROS) for (const [family, term] of JOB_TERMS) out.push({ family, q: `${term} in the last 3 days`, location: city + ', United States', term });
    // Interleave cities so consecutive searches never hit one city twice in a row.
    const byIndex = [];
    for (let i = 0; i < JOB_TERMS.length; i++) for (let c = 0; c < METROS.length; c++) byIndex.push(out[c * JOB_TERMS.length + ((i + c) % JOB_TERMS.length)]);
    return byIndex;
})();

/**
 * Days since a listing went up. Google's label ("3 days ago") is only true on the day it was read, so a
 * listing kept for later carries the date it implied (posted_at, stamped by compactListing) and its
 * age is counted from that date. A retry a week later is a week older.
 */
export function listingAge(l, now = Date.now()) {
    if (l && l.posted_at) { const t = Date.parse(l.posted_at); if (Number.isFinite(t)) return Math.max(0, Math.floor((now - t) / 864e5)); }
    return jobAgeDays(l && l.extensions);
}
/** Days since a Google Jobs listing went up, from its "3 days ago" / "5 hours ago" label, or null. */
export function jobAgeDays(extensions) {
    for (const e of extensions || []) {
        const m = String(e).match(/^(\d+)\+?\s+(minute|hour|day|week|month)s?\s+ago$/i);
        if (!m) continue;
        const n = Number(m[1]), unit = m[2].toLowerCase();
        return unit === 'minute' || unit === 'hour' ? 0 : unit === 'day' ? n : unit === 'week' ? n * 7 : n * 30;
    }
    return null;
}
// Big employers apply through enterprise systems; small and midsize ones through Indeed, ZipRecruiter,
// Paylocity, BambooHR, Workable. An enterprise apply link is the size signal Google Jobs gives us.
// A careers site of its own (jobs.spectrum.com, careers.x.com, amazon.jobs) is a big employer's habit.
const BRAND_CAREERS = /^(jobs|careers|career|work|join)\.[a-z0-9-]+\.[a-z]+$|\.jobs$/i;
const ENTERPRISE_ATS = /(myworkdayjobs\.com|wd\d+\.myworkday|oraclecloud\.com|taleo\.net|icims\.com|avature\.net|successfactors|brassring|ultipro|ukg\.net|phenompeople|dayforcehcm\.com|jobs\.jobvite\.com|smartrecruiters\.com\/[A-Z]|eightfold\.ai)/i;
// Public bodies by their form, not by a word that a small business can carry ("Lakewood Animal Hospital",
// "Orange County Plumbing", "University Park Dental", "The Roofing Authority").
const INSTITUTION = /^\s*(the\s+)?(city|county|state|town|village|commonwealth)\s+of\b|\bcounty\s+(government|sheriff|schools?|clerk|court)\b|\buniversity\s+of\b|\bstate\s+university\b|\bschool\s+district\b|\bpublic\s+schools\b|\bhealth\s+system\b|\bhospital\s+district\b|\bdepartment\s+of\b|\b(police|sheriff'?s?|fire\s+department|government|federal|municipal)\b|\b(state'?s?|district|county|city|u\.?s\.?)\s+attorney|attorney'?s?\s+office\b|\b(circuit|superior|district|municipal|county)\s+court\b|\bpublic\s+defender\b|\bboard\s+of\s+(education|supervisors|commissioners)\b|\bisd\b|\bindependent\s+school\b|\btax\s+board\b|\bfranchise\s+tax\b/i;
/** A staffing firm or a public body, by its name alone. The refresh pass re-applies this to cards already made. */
export function companyExcluded(name) {
    const comp = competitorReason({ company: name, text: '' });
    if (comp) return { reason: 'competitor', detail: comp };
    if (INSTITUTION.test(String(name || ''))) return { reason: 'institution', detail: `${name} is a public body, school or court.` };
    const big = String(name || '').match(KNOWN_LARGE);
    if (big) return { reason: 'large_employer', detail: `${name} is a large employer with its own recruiting team (${big[0]}).` };
    return null;
}
// Large employers and health systems that reached the list before the size checks existed (PM review,
// 2026-10-28: "UnityPoint, Beth Israel Deaconess, C&S, Byram and other known out-of-scope employers").
// Each is public knowledge: a health system, a teaching hospital, the largest US grocery wholesaler, an
// Owens & Minor company, a multinational, a statewide agency of a thousand staff.
const KNOWN_LARGE = /\b(unitypoint|beth\s+israel|deaconess|c\s*&\s*s\s+wholesale|byram\s+healthcare|altrad|one\s+hope\s+united|owens\s*&\s*minor|kaiser\s+permanente|advocate\s+aurora|atrium\s+health|banner\s+health|hca\s+healthcare|ascension|trinity\s+health|commonspirit|providence\s+health|mayo\s+clinic|cleveland\s+clinic|sutter\s+health|intermountain|baylor\s+scott|memorial\s+hermann|northwell|mass\s+general|brigham)\b/i;
export const jobKey = j => 'gjobs:' + createHash('sha256').update([j.company_name, j.title, j.location].map(x => String(x || '').trim().toLowerCase()).join('|')).digest('hex').slice(0, 20);
// "Royal Electric", "Royal Electric, LLC" and "Royal Electric Co." are one employer: the key drops legal suffixes.
export const companyKey = (name, location) => 'gco:' + (nameWords(name).join('') || String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '')) + ':' + String(stateOf(location) || '').toLowerCase();
// A business with no website still has one number: a second card on the same number is the same business.
export const phoneKey = n => 'phone:' + String(n || '').replace(/\D/g, '').slice(-10);
const STATES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC' };
/** The two-letter state in "Tampa, FL", "Tampa, Florida" or "4518 Ash Ln, Dallas, TX 75223", or null. */
export function stateOf(text) {
    const t = String(text || '');
    const m = t.match(/,\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,|$|\()/);
    if (m && Object.values(STATES).includes(m[1])) return m[1];
    const low = t.toLowerCase();
    for (const [name, code] of Object.entries(STATES)) if (new RegExp('\\b' + name + '\\b').test(low)) return code;
    return null;
}
export const cityOf = text => { const m = String(text || '').match(/^\s*([^,(]+?)\s*,/); return m ? m[1] : null; };

/**
 * The verdict on one Google Jobs listing, before anything is spent on the company.
 * Returns { ok:true, family, age, restrictions } or { ok:false, reason, detail }.
 */
export function qualifyJob(j, now = Date.now()) {
    const title = String(j && j.title || '');
    const family = roleFamily(title);
    if (!family) return { ok: false, reason: 'role_not_fillable', detail: `"${title}" is not a customer service, sales or admin seat a remote person fills.` };
    const age = listingAge(j, now);
    if (age == null) return { ok: false, reason: 'undated_post', detail: 'Google Jobs shows no posting age, so it may be old.' };
    if (age > DISCOVERY_DAYS) return { ok: false, reason: 'stale_post', detail: `Posted ${age} days ago; we only call about the last ${DISCOVERY_DAYS} days.` };
    const company = String(j.company_name || '');
    const comp = competitorReason({ company, text: j.description });
    if (comp) return { ok: false, reason: 'competitor', detail: comp };
    const links = (j.apply_options || []).map(a => a && a.link).filter(Boolean);
    const hosts = links.map(l => { try { return new URL(l).hostname.toLowerCase(); } catch { return ''; } });
    if (KNOWN_LARGE.test(company)) return { ok: false, reason: 'large_employer', detail: `${company} is a large employer with its own recruiting team.` };
    if (INSTITUTION.test(company) || hosts.some(h => /\.(edu|gov|mil)$/.test(h))) return { ok: false, reason: 'institution', detail: `${company} is a public body, school or hospital system.` };
    const big = links.find(l => ENTERPRISE_ATS.test(l));
    if (big) return { ok: false, reason: 'large_employer', detail: 'They hire through an enterprise system (' + (big.match(ENTERPRISE_ATS) || [''])[0] + '), a sign of a large employer.' };
    const own = hosts.find(h => BRAND_CAREERS.test(h.replace(/^www\./, '')));
    if (own) return { ok: false, reason: 'large_employer', detail: `They post on a careers site of their own (${own}), a sign of a large employer.` };
    // "Now Hiring", "Entry-Level ... - Chicago, IL", "no experience needed": mass recruiting ads, rarely the employer itself.
    if (/\bnow\s+hiring\b|\bhiring\s+(immediately|now)\b|\bimmediate\s+start\b|\bno\s+experience\s+(needed|necessary|required)\b|\bentry[- ]level\b.*\s-\s*[A-Z][a-zA-Z .]+,\s*[A-Z]{2}\s*$/i.test(title)) return { ok: false, reason: 'recruiting_ad', detail: `"${title}" reads as a mass recruiting ad, not an employer hiring for its own seat.` };
    if (!salesSeatOk(title, j.description)) return { ok: false, reason: 'field_sales', detail: 'A sales seat the post describes as in person (a lot, a showroom, a territory), or never says is by phone.' };
    const r = restrictions([title, j.description, j.location].join(' '));
    // Onsite attendance is fine here: the point is a remote person can do the seat. Licences and clearances are not.
    const hard = r.hard.filter(x => !/onsite/.test(x));
    if (hard.length) return { ok: false, reason: 'hard_restriction', detail: 'The post ' + hard.join(' and ') + '.' };
    if (!stateOf(j.location) && !/anywhere|remote|united states/i.test(String(j.location || ''))) return { ok: false, reason: 'outside_us', detail: `"${j.location}" is not a US location.` };
    return { ok: true, family, age, restrictions: { ...r, hard } };
}

const NAME_STOP = new Set(['inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'the', 'and', 'of', 'group', 'services', 'service', 'solutions', 'pllc', 'pc', 'pa', 'lp', 'llp', 'usa', 'us', 'america']);
function nameWords(n) { return String(n || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !NAME_STOP.has(w)); }
// Employer names that say nothing about who the employer is.
const GENERIC = new Set(['confidential', 'hiring', 'employer', 'private', 'practice', 'dental', 'office', 'medical', 'law', 'firm', 'insurance', 'agency', 'clinic', 'local', 'small', 'business', 'family', 'owned', 'home', 'health', 'care', 'remote', 'team', 'staff', 'client', 'our', 'a', 'an', 'company']);
// Same word, or the same word with a plural or adjective ending: electric/electrical, home/homes. Not smith/smithfield.
const sameWord = (a, b) => a === b || [a, b].some((x, i) => { const y = i ? a : b; return y.length > x.length && /^(s|es|al|als|ing|er|ers)$/.test(y.slice(x.length)) && y.startsWith(x); });
/**
 * Is this Google business listing the employer that posted the job? Two distinctive words in common
 * (or exactly the same name), every distinctive word of one name found in the other, and the same
 * state. One shared word is never enough: "Royal Services" is not "Royal Plumbing", "Spectrum" is not
 * "Spectrum Store", and a job with no state has nothing to confirm the place against.
 */
export function profileMatches(company, profile, jobLocation) {
    if (!profile || !profile.title) return { ok: false, why: 'Google shows no business listing for this name.' };
    const a = nameWords(company), b = nameWords(profile.title);
    if (!a.length || !b.length || a.every(w => GENERIC.has(w))) return { ok: false, why: `"${company}" is too generic a name to match to one business.` };
    const exact = a.join(' ') === b.join(' ');
    const aInB = a.filter(w => b.some(x => sameWord(w, x))).length, bInA = b.filter(w => a.some(x => sameWord(w, x))).length;
    // Both names mostly agree: "State Attorney" does not cover "Cook County State's Attorney's Office".
    const half = n => Math.ceil(n / 2);
    const nameOk = exact || ((aInB === a.length || bInA === b.length) && Math.min(aInB, bInA) >= 2 && aInB >= half(a.length) && bInA >= half(b.length));
    if (!nameOk) return { ok: false, why: `Google's listing "${profile.title}" is not clearly "${company}".` };
    const js = stateOf(jobLocation), ps = stateOf(profile.address);
    if (!js) return { ok: false, why: `The job location "${jobLocation}" names no state, so the listing cannot be confirmed as this employer.` };
    if (!ps) return { ok: false, why: 'Google\'s listing has no address to confirm the location.' };
    if (js !== ps) return { ok: false, why: `The listing is in ${ps}; the job is in ${js}.` };
    return { ok: true };
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
const FAMILY_WORDS = { support: 'customer support', admin: 'admin', scheduling: 'scheduling', account: 'account support', sales: 'sales' };
export const familyWords = f => FAMILY_WORDS[f] || 'support';

/** The short researched brief a caller reads before dialling. Facts only, each one sourced on the record. */
export function briefFor(rec) {
    const j = rec.job || {}, c = rec.company || {}, r = j.restrictions || {};
    const when = j.ageDays == null ? 'is live' : j.ageDays === 0 ? 'went up today' : j.ageDays === 1 ? 'went up yesterday' : `went up ${j.ageDays} days ago`;
    const where = r.offshore ? ` They list it as open to candidates in ${r.offshore}, which is where our people are.` : '';
    const caveat = (r.soft || []).length ? ` Note: the post ${r.soft.join(' and ')}. That is about who they hire directly; a managed placement is a different arrangement, so ask rather than assume.` : '';
    const more = (rec.jobs || []).length > 1 ? ` They have ${rec.jobs.length} matching roles open.` : '';
    return {
        summary: j.source === 'google_jobs'
            ? `${c.name} is hiring a ${j.title}${j.city ? ' in ' + j.city : ''}. The listing ${when} on Google Jobs${j.via ? ' (' + j.via + ')' : ''}.${where}${more} The seat is one a remote person can do, so offer to fill it and run their hiring for roles like it.`
            : `${c.name} is hiring a ${j.title}. The post ${when} and was still open on their careers page when we checked.${where}${more}`,
        need: `A ${familyWords(rec.family)} hire: ${j.title}${j.location ? ' (' + j.location + ')' : ''}.${caveat}${j.source === 'google_jobs' && j.workplace !== 'remote' ? ' They posted it as an in-office job, not a remote opening: offer a remote person for the seat and let them decide.' : ''}`,
        nextStep: 'Book a short call with Paul to scope the role and how we would run their remote hiring for customer service, sales and admin.',
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
        callContact: p.source === 'Google business listing'
            ? { phone: p.number || null, phoneStatus: p.number ? 'listing_main' : 'missing', phoneSource: 'Google business listing', phoneSourceUrl: p.sourceUrl || null, phoneAlternates: p.alternates || [], phoneCheckedAt: p.checkedAt || null, phoneDetail: 'The main line on their Google business listing, not a direct line.' }
            : { phone: p.number || null, phoneStatus: p.number ? 'site_main' : 'missing', phoneSource: 'Published on their website', phoneSourceUrl: p.sourceUrl || null, phoneAlternates: p.alternates || [], phoneCheckedAt: p.checkedAt || null, phoneDetail: 'The company line from their own website, not a direct line.' },
        industry: { key: 'hiring', label: 'Hiring now', source: 'job post' },
        hiring: { source: rec.job && rec.job.source || 'ats', city: rec.job && rec.job.city || null, title: rec.job && rec.job.title, url: rec.job && rec.job.url, postedAt: rec.job && rec.job.postedAt, checkedAt: rec.job && rec.job.checkedAt, jobState: rec.job && rec.job.state || 'open', location: rec.job && rec.job.location, priority: rec.priority || 0, offshore: !!(rec.job && rec.job.restrictions && rec.job.restrictions.offshore) },
    };
}

const RETRY = ['no_answer', 'voicemail', 'callback', 'gatekeeper', 'timing'];
const PROMISED = ['callback', 'gatekeeper', 'timing'];
/** The posting was confirmed live recently enough to call about it. */
export function jobCurrent(rec, now = Date.now()) {
    const j = rec && rec.job;
    if (!j || j.state === 'closed' || j.state === 'stale') return false;
    // A Google Jobs card has no posting API to re-read: it is current until MAX_AGE_DAYS after it went up.
    if (j.source === 'google_jobs') return Date.parse(j.postedAt) > now - MAX_AGE_DAYS * 864e5;
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
