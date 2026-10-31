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
// Call first: a person works the record in the dialer, no AI caller. Since 2026-10-30 an owner with a verified email
// also gets the Hiring now emails beside the calls (api/_hiring-drip-copy.js); an opt-out there closes the card too.
import { createHash } from 'node:crypto';
import { HIRING_DRIP_ID } from './_hiring-drip-campaign.js';

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
// A free board's employer hiring in this many US states at once is a chain or a national firm, whatever its open-role
// count (Precoa, 2026-10-30: 58 open roles across 11 states, a Portland line for a Salt Lake City seat).
export const LARGE_EMPLOYER_STATES = 5;
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
    feedCursor: 'staffify:hiring:workable-cursor', // { term, page, token } in FEED_TERMS: the free Workable search
    profile: key => 'staffify:hiring:profile:' + key, // Google business listing per employer, misses too, 30 days
    serpDay: day => 'staffify:hiring:serp:' + day,
    rrDay: day => 'staffify:hiring:rr:' + day,  // RocketReach person lookups made that day (owner cells)
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
const EXPLICIT_SALES = /\blead\s+setter\b|\b(inside|telephone|phone|outbound|inbound|remote)\s+sales\b|\bsales\s+(development|coordinator|assistant|support|admin(istrator)?)\b|\b(sdr|bdr)\b|\bappointment\s+sett(er|ing)\b|\bcold\s+call(er|ing)\b|\blead[\s-]+gen(eration)?\b|\bbusiness\s+development\s+(representative|rep|associate)\b|\btelesales\b|\btelemarket(ing|er)\b/i;
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
    // Paul, 2026-10-28: "I specifically want to see the wedding video editor, where is that". Video editing is one of
    // the seats Staffify places (the site's nav: Exec Admins, CSR, Video Editors, Sales); a shoot on location is not.
    ['video', /\bvideo\s+(editor|editing|producer|specialist|assistant)\b|\bpost[- ]production\s+(specialist|editor|assistant|coordinator)\b|\b(reels?|short[- ]form|podcast|youtube|social\s+media)\s+(video\s+)?editor\b|\baudio\s+and\s+video\s+editor\b/i],
    // Widened 2026-10-28 from Madison's researched list: insurance service seats, legal support, retention and
    // client services are remote-doable desk work Staffify places. Licensed seats still fail the licence rule.
    ['admin', /\blegal\s+(assistant|secretary)\b|\bparalegal\b|\b(law\s+firm|legal)\s+case\s+manager\b|\bbilling\s+specialist\b|\bproject\s+assistant\b|\badministrative\s+(&|and)\s+operations\s+coordinator\b/i],
    ['account', /\b(insurance|commercial|personal|farm|private\s+client|casualty|lines)\b[\w\s/&-]{0,30}\baccount\s+(manager|representative|rep)\b|\b(customer|client)\s+account\s+manager\b|\binsurance\s+service\s+(associate|representative)\b/i],
    ['support', /\bcsr\b|\bcustomer\s+(sales\s+and\s+service|retention|relations)\s+(representative|specialist|rep|associate)\b|\bclient\s+services?\s+(coordinator|representative|specialist)\b/i],
    ['support', /\b(customer|client|member|guest|player|patient|user)\s+(support|service|care|experience|happiness|success)\b|\bsupport\s+(agent|specialist|representative|rep|associate|advocate)\b|\b(technical|tech|it|product|l1|tier\s*1|level\s*1)\s+support\b|\bhelp\s*desk\b|\bcall\s+cent(er|re)\b/i],
    ['admin', /\b(administrative|admin|executive|personal|virtual|operations|office|team)\s+assistant\b|\badministrative\s+(coordinator|specialist|associate)\b|\boffice\s+admin(istrator)?\b|\bdata\s+entry\b|\bback\s+office\b/i],
    // Widened 2026-10-28 from Paul's remote list: a booking coordinator books guests or calls; a membership coordinator
    // services members; a firm's tax administration is back-office desk work.
    ['scheduling', /\bbooking\s+(coordinator|specialist|agent)\b/i],
    ['account', /\bmembership\s+(coordinator|specialist|representative|associate)\b/i],
    // Widened 2026-10-28 night from the job-board sweep: desk seats small businesses post under plain titles.
    ['admin', /\bsecretary\b|\b(general|office)\s+administrator\b|\badmin(istrative)?\s+services?\s+(coordinator|specialist|assistant)\b|\badministrative\s*(&|and)\s*\w+\s+assistant\b|\bassistant\s+bookkeeper\b|\bbookkeeping\s+(assistant|clerk)\b|\baccounts\s+(payable|receivable)\s+(clerk|specialist|assistant)\b/i],
    ['scheduling', /\bfront\s+office\s+(coordinator|assistant|specialist)\b|\b(patient\s+)?enrollment\s+(specialist|coordinator)\b/i],
    ['support', /\bclient\s+services?\s+(assistant|associate)\b|\bclient\s+relations(hip)?\s+(associate|specialist|coordinator|representative)\b|\bcustomer\s+relations\b/i],
    ['admin', /\b(tax|practice|firm)\s+admin(istration|istrator)?\b/i],
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
// Public-safety dispatch stays out; a contractor's "Emergency CSR / Job Dispatcher" taking calls from home is a seat
// we fill (RooterMan of Muncie, Madison's 2026-10-30 list). A bank teller and an airline's counter or gate agent are a
// branch and an airport, whatever "CSR" or "Customer Service" sits beside them (First Southern National Bank's
// "Teller/CSR", Pacific Aviation's LAX "Airline Customer Service Agent", Workable 2026-10-30).
const PHYSICAL = /\b((bank\s+)?tellers?|airline\s+(customer\s+service\s+|passenger\s+service\s+|ticket(ing)?\s+)?agent|airport\s+(customer\s+service\s+|passenger\s+service\s+)?(agent|representative|ambassador)|gate\s+agent|ticket(ing)?\s+agent|ramp\s+agent|baggage\s+(handler|agent)|store|in[- ]store|retail|cashier|warehouse|valet|housekeep(er|ing)|janitor|custodian|cook|barista|bartender|caregiver|security\s+(officer|guard)|guard|merchandiser|stocker|loader|forklift|hotel|front\s+desk\s+agent|showroom|dealership|body\s+shop|collision\s+(center|repair)|door[- ]to[- ]door|outside\s+sales|territory|route\s+sales|911|police|emergency\s+(dispatch(er)?|communications|medical|services|response|telecommunicator)|on[- ]site\s+only)\b/i;
const PHYSICAL_SEAT = /\b(field|driver|delivery|technician|installer|courier|porter|mechanic|server)\b/i;
const REMOTE_SEAT = /\b(help\s*desk|support|dispatch(er|ing)?|schedul(er|ing)|coordinator|customer\s+service|call\s+cent(er|re)|representative|specialist|assistant|admin(istrator)?|receptionist|sales\s+development|inside\s+sales|appointment\s+setter)\b/i;
const SENIOR = /\b(manager|lead|supervisor|senior|sr\.?)\b/i;

/** The role family a title belongs to, or null when it is not work Staffify places. */
export function roleFamily(title) {
    const t = String(title || '');
    // "Executive Assistant to Chief Executive Officer": who the seat supports is not the seat.
    const seat = t.replace(/\b(assistant|coordinator|secretary)\s+to\s+(the\s+)?.*$/i, '$1');
    if (!t || NOT_FILLABLE.test(seat) || PHYSICAL.test(t)) return null;
    if (PHYSICAL_SEAT.test(t) && !REMOTE_SEAT.test(t)) return null;
    // "Customer Support Manager" is a leader; "Customer Support Specialist (Senior)" is still a seat we
    // could fill, but a manager or team lead is not.
    // An account manager at an insurance agency services accounts; a legal case manager runs files. Neither manages people.
    if (/\b(manager|lead(?![\s-]+(gen|sett))|supervisor)\b/i.test(seat) && !/\bassistant\b|\baccount\s+manager\b|\bcase\s+manager\b/i.test(t)) return null;
    for (const [family, re] of ROLE_FIT) if (re.test(t)) return family;
    return null;
}
export const seniorTitle = title => SENIOR.test(String(title || ''));

// Staffing, recruiting, BPO and outsourcing firms are competitors, not buyers. Also job boards
// reposting someone else's role.
const COMPETITOR = /\b(staffing|recruit(ing|ment)\s+(agency|firm|partner|solutions)|(is\s+)?partnering\s+with\s+an?\s+(established|leading|growing|well[- ]established|reputable)\s+(organization|company|firm|client)|talent\s+(solutions|partners|agency)|outsourc(e|ed|ing)|\bbpo\b|offshore\s+(team|staff)|virtual\s+assistant\s+(company|agency|services)|on\s+behalf\s+of\s+(our|a)\s+client|our\s+client\s+is\s+(seeking|looking|hiring)|employer\s+of\s+record|nearshore\s+(staffing|talent))\b/i;
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
    // "Licensed Farmers Administrative Assistant", "Insurance Service Associate (licensed)": the seat itself is licensed.
    [/\(licensed\)|\blicensed\s+(\w+\s+){0,3}(assistant|associate|representative|rep|csr|agent|account\s+manager|producer|specialist|coordinator)\b/i, 'requires a state or financial licence'],
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
    const ev = postEvidence({ company: p.company, title: p.title, text: p.text, family });
    if (ev) return { ok: false, ...ev };
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
// Office seats by their office names (PM, 2026-10-28): the bare "customer service representative", "call
// center", "customer care", "receptionist" and "sales assistant" searches kept returning store floors,
// staffing agencies, big call centers and care homes, which the admission rules then threw away after
// the search had been paid for. A coordinator, client-services or office title is a desk at a business.
export const JOB_TERMS = [
    ['support', 'customer service coordinator'], ['support', 'customer support specialist'],
    ['admin', 'administrative assistant'], ['admin', 'executive assistant'], ['admin', 'office administrator'],
    ['scheduling', 'office receptionist'], ['scheduling', 'scheduling coordinator'], ['scheduling', 'dispatcher'],
    ['sales', 'inside sales representative'], ['sales', 'appointment setter'], ['sales', 'sales development representative'],
    ['account', 'account coordinator'],
    // Widened 2026-10-28 for two full-time callers (Paul: "3 to 5 is just impossible").
    ['support', 'client service representative'], ['support', 'client care coordinator'], ['admin', 'data entry clerk'],
    ['scheduling', 'patient coordinator'], ['scheduling', 'intake coordinator'], ['sales', 'sales support coordinator'],
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
// The free Workable search (2026-10-30) runs the same titles nationwide, plus the video seat Google Jobs never searched
// for (Paul, 2026-10-28: "I specifically want to see the wedding video editor, where is that").
export const FEED_TERMS = [...JOB_TERMS, ['video', 'video editor']];
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
const INSTITUTION = /\bspca\b|\bhumane\s+society\b|\banimal\s+(shelter|rescue)\b|^\s*(the\s+)?(city|county|state|town|village|commonwealth)\s+of\b|\bcounty\s+(government|sheriff|schools?|clerk|court)\b|\buniversity\s+of\b|\bstate\s+university\b|\bschool\s+district\b|\bpublic\s+schools\b|\bhealth\s+system\b|\bhospital\s+district\b|\bdepartment\s+of\b|\b(police|sheriff'?s?|fire\s+department|government|federal|municipal)\b|\b(state'?s?|district|county|city|u\.?s\.?)\s+attorney|attorney'?s?\s+office\b|\bdistrict\s+attorney\b|\bd\.?a\.?['’]s\s+office\b|\b(circuit|superior|district|municipal|county)\s+court\b|\bpublic\s+defender\b|\bboard\s+of\s+(education|supervisors|commissioners)\b|\bisd\b|\bindependent\s+school\b|\btax\s+board\b|\bfranchise\s+tax\b/i;
/** A staffing firm or a public body, by its name alone. The refresh pass re-applies this to cards already made. */
// Law firms and insurance agencies are Milton's (Paul, 2026-10-28: "we do want the insurance and law firms, but those
// should specifically go to Milton not madison and I"). Read from the business name, the industry a researcher wrote
// down, or the Google listing type. Such a card is offered as new work to Milton only; it is never excluded for it.
const LAW_FIRM = /\b(law|legal|attorneys?|lawyers?|esq|litigation)\b|\bcounsel\b(?!ing)/i;
const INSURANCE_FIRM = /\b(insurance|insurers?|underwriters?|state\s+farm|allstate|ins\.?\s+agency)\b|\bfarmers\s+(insurance|agent|agency|ins)\b|\b(law\s+firm|attorney|lawyer|insurance\s+(agency|broker|company))\b/i;
export const SECTOR_CALLER = String(process.env.HIRING_LAW_INSURANCE_CALLER || 'miltion@trystaffify.com').toLowerCase();
/** 'law' or 'insurance' when the business is one, else null. */
export function sectorOf(name, context = '') {
    const t = [name, context].filter(Boolean).join(' ');
    return LAW_FIRM.test(t) ? 'law' : INSURANCE_FIRM.test(t) ? 'insurance' : null;
}
/** The one caller a card is offered to as new work, or null for the shared pool. */
export function laneFor(rec) {
    if (!rec) return null;
    const ctx = [rec.lead && rec.lead.industry, rec.lead && rec.lead.vertical, rec.company && rec.company.identity && rec.company.identity.listingType].filter(Boolean).join(' ');
    return sectorOf(rec.company && rec.company.name, ctx) ? SECTOR_CALLER : null;
}
export function companyExcluded(name, context = '') {
    const comp = competitorReason({ company: name, text: '' });
    if (comp) return { reason: 'competitor', detail: comp };
    if (INSTITUTION.test(String(name || ''))) return { reason: 'institution', detail: `${name} is a public body, school, court or charity.` };
    const big = String(name || '').match(KNOWN_LARGE);
    if (big) return { reason: 'large_employer', detail: `${name} is a large employer with its own recruiting team (${big[0]}).` };
    return null;
}
// Large employers and health systems that reached the list before the size checks existed (PM review,
// 2026-10-28: "UnityPoint, Beth Israel Deaconess, C&S, Byram and other known out-of-scope employers").
// Each is public knowledge: a health system, a teaching hospital, the largest US grocery wholesaler, an
// Owens & Minor company, a multinational, a statewide agency of a thousand staff.
const KNOWN_LARGE = /\b(unitypoint|beth\s+israel|deaconess|c\s*&\s*s\s+wholesale|byram\s+healthcare|altrad|one\s+hope\s+united|owens\s*&\s*minor|kaiser\s+permanente|advocate\s+aurora|atrium\s+health|banner\s+health|hca\s+healthcare|ascension|trinity\s+health|commonspirit|providence\s+health|mayo\s+clinic|cleveland\s+clinic|sutter\s+health|intermountain|baylor\s+scott|memorial\s+hermann|northwell|mass\s+general|brigham)\b/i;
// ---- what the post and the employer show (PM, 2026-10-28) --------------------------------------
// Title keywords let a Walgreens register job, a Circle K cashier, a Michael Kors store floor, a
// beverage route, a psychiatric hospital and a national health plan through in one morning. These
// read what the record already holds: the duties in the post, the employer's words about itself and
// the Google listing's website and type. A rule needs two separate signs, or one that only a large or
// institutional employer writes, so a stray word in a small firm's post does not cost it the card.
const hits = (res, t) => res.filter(re => re.test(t)).length;
// Work on a store, counter or warehouse floor: the seat is the place.
const FLOOR_DUTIES = [
    /\bcash\s+register\b|\brun(s|ning)?\s+the\s+register\b|\bregisters?\s+(customer\s+)?(sales|purchases)\b/i,
    /\bcashier/i,
    /\b(sales|selling|store|retail)\s+floor\b/i,
    /\bstock\s*room\b/i,
    /\b(re)?stock(s|ing)?\s+(the\s+)?shelves\b|\bcounters\s+and\s+shelves\b/i,
    /\bpos\s+experience\b/i,
    /\bstore\s+(manager|environment|tasks|appearance|associates?|hours)\b|\baround\s+the\s+store\b|\bstore\s+#?\d{3,}\b|\b(cleanliness|appearance|upkeep)\s+of\s+the\s+(store|showroom)\b/i,
    /\bshift\s+lead(er)?\b|\bkeyholder\b/i,
    /\bmerchandis(e|ing)\s+(displays?|standards)\b|\bvisual\s+merchandising\b|\b(maintain|manag)(s|es|ing)?\s+(tidy\s+|the\s+)?displays\b/i,
    // A mall jeweler's holiday floor (REEDS Jewelers, 2026-10-30): gift wrapping at the counter.
    /\bgift\s+wrap(ping)?\b/i,
    /\bwarehouse\s+(manager|floor|team|staff)\b|\bload[- ]out\b|\breceiving\s+tickets\b|\bforklift\b/i,
];
// Selling in person on a route or a territory.
const FIELD_DUTIES = [
    /\bcalls?\s+on\s+(accounts|customers|clients)\b/i,
    /\b(daily|assigned)\s+routes?\b|\broute\s+(sales|book)\b|\bcovers?\s+.{0,20}\broutes?\b/i,
    /\bterritor(y|ies)\s+(manager|management|coverage|sales)\b|\b(open|assigned|different)\s+territor(y|ies)\b|\b(rotate|travel)s?\s+(through|throughout|within|across)\b.{0,40}\bterritor(y|ies)\b/i,
    /\bvisit(s|ing)?\s+(accounts|customers|clients|stores|retailers|prospects|job\s*sites)\b|\bin[- ]person\s+(sales\s+)?(visits|calls|meetings)\b|\bface[- ]to[- ]face\s+(sales|meetings)\b/i,
    /\bdriver'?s\s+licen[cs]e\b|\breliable\s+(vehicle|transportation)\b|\bmileage\s+reimburse/i,
    /\bmerchandising\s+(department|periods?|duties)\b|\bresets?\b.{0,30}\b(shelf|shelves|displays?)\b/i,
    /\bdeliver(s|ing)?\s+(the\s+)?products?\b|\bproduct\s+deliver(y|ies)\b/i,
    /\bfield[- ]based\b|\bdoor[- ]to[- ]door\b/i,
];
// Paul, 2026-10-28: "if there are ones ... that truly cannot be done remotely, that didn't make it through
// our filters, please make sure to do that." Duties that need a body somewhere, whatever the title says:
// meeting customers face to face, visiting homes, driving a territory, a parts counter, a warehouse.
// One strong sign is enough; the others need two. A phone seat posted as in-office is still fine.
const IN_PERSON_STRONG = /\bface[- ]to[- ]face\s+(with\s+)?(customers|clients|patients|prospects)\b|\b(connect|meet|interact)\w*\s+(with\s+)?(customers|clients|prospects)\s+face[- ]to[- ]face\b|\bdoor[- ]to[- ]door\b|\bin[- ]home\s+(visits?|assessments?|consultations?)\b|\bhome\s+visits\b/i;
const IN_PERSON_DUTIES = [
    /\b(travel|drive|driving)\s+(through|throughout|within|across|to)\b.{0,40}\b(territor(y|ies)|client\s+homes|customers'?\s+homes|job\s*sites)\b|\b(assigned|open)\s+territor(y|ies)\b/i,
    /\bdriver'?s\s+licen[cs]e\s*(\(required\)|(is\s+)?required)|\bvalid\s+driver'?s\s+licen[cs]e\b|\breliable\s+transportation\b/i,
    /\bcounter\s+(customer\s+)?(service|sales)\b|\bparts\s+counter\b|\bbehind\s+the\s+counter\b/i,
    /\b(lift|carry)\s+(up\s+to\s+)?\d{2,3}\s*(lbs?|pounds)\b/i,
    /\bforklift\b/i,
    /\bshowroom\b/i,
    /\bbrand\s+ambassador\b/i,
    /\bgoes\s+on[- ]site\b|\bon[- ]site\s+(with|at)\s+(customers|clients)\b/i,
];
// A front desk: greeting visitors, the mail and the office itself. Phones alone are not this; three signs are.
const DESK_DUTIES = [
    /\bgreet(s|ing)?\s+(all\s+)?(clients|customers|visitors|guests|patients|walk[- ]?ins)\b/i,
    /\b(reception|front)[- ]desk\b/i,
    /\b(incoming|outgoing)(\s*\/\s*(incoming|outgoing))?\s+(mail|packages|shipments)\b|\bmail\s+and\s+(packages|shipments)\b/i,
    /\bkitchen\s+supplies\b|\b(clean|tidy)\s+office\s+environment\b|\b(stock|restock)\w*\s+(the\s+)?(kitchen|break\s*room)\b/i,
    /\bwalk[- ]?in\s+(clients|customers|patients)\b|\bcheck(s|ing)?[- ]in\s+(patients|clients|visitors)\b/i,
    // A clinic or service counter (Central California SPCA, 2026-10-31): cash at the desk, check-in to discharge, upkeep.
    /\b(cash|money)\s+(handling|transactions?)\b|\bprocess\w*\s+cash\b/i,
    /\bcheck[- ]in\b.{0,80}\b(discharge|check[- ]out)\b/i,
    /\b(cleanliness|upkeep)\b.{0,60}\b(facility|exam\s+rooms|lobby|waiting\s+(room|area))\b|\bfacility\s+upkeep\b/i,
];
// A hospital, a residential care home or a health plan: the employer is an institution, not a small business.
const CLINICAL_NAME = /\b(hospital|health\s*care\s+system|health\s+system|psychiatric|nursing\s+(home|center|facility)|skilled\s+nursing|wellness\s+and\s+rehabilitation|rehabilitation\s+hospital|assisted\s+living|senior\s+living|memory\s+care|hospice|health\s+plan)\b/i;
const NOT_CLINICAL_NAME = /\b(animal|pet|veterinar\w*|vet|equine)\b/i;
const FACILITY_TEXT = [
    /\binpatient\b/i, /\bpsychiatric\s+(hospital|unit|facility)\b/i, /\bacute\s+care\b/i, /\butilization\s+review\b/i,
    /\b(admission|admit)s?\s+(of\s+)?patients?\b|\bpatient\s+admissions?\b/i,
    /\b\d{2,3}[- ]bed\b|\bbeds?\s+(hospital|facility)\b/i,
    /\bskilled\s+nursing\b|\blong[- ]term\s+care\s+(facility|community|residents?)\b|\bnursing\s+(home|facility)\b/i,
    /\bassisted\s+living\b|\bmemory\s+care\b|\bsenior\s+(living|communit(y|ies))\b/i,
    /\bresidents?\s+(and|&)\s+(their\s+)?famil(y|ies)\b|\bour\s+residents\b/i,
    /\bcms\s+(five|four|5|4)[- ]star\b/i,
];
const PAYER_TEXT = [
    /\bhealth\s+plans?\b/i, /\bmembers?\s*(and|&|\/|or)\s*providers?\b/i, /\bprovider\s+(portal|inquiries|network)\b/i,
    /\bmember\s+(eligibility|services|inquiries|engagement|experience)\b/i, /\blines?\s+of\s+business\b/i,
];
// What only a large employer writes about ITSELF. One is enough. Never a phrase about its clients or
// customers ("Fortune 500 clients", "ships to all 50 states", "powers thousands of stores").
const ENTERPRISE_TEXT = [
    /\((nyse|nasdaq)\s*:\s*[a-z.]{1,6}\)|\b(nyse|nasdaq)\s*:\s*[a-z.]{1,6}\b/i,
    // "EVI Industries, Inc. (NYSE American: EVI) is the only U.S. public company ..." (2026-10-28).
    /\b(nyse|nasdaq)\s+(american|arca|global(\s+select)?\s+market|capital\s+market)\s*:\s*[a-z.]{1,6}\b/i,
    /\b(the\s+only\s+(u\.?s\.?\s+)?|a\s+growing\s+|our\s+)public(ly\s+traded)?\s+company\b/i,
    /\b(we\s+are|we're|is)\s+(a\s+|an\s+)?(publicly\s+traded|fortune\s+(50|100|500|1000))\b/i,
    /\b(our|we\s+have|with)\s+(over\s+|more\s+than\s+)?\d{1,3}(,\d{3})+\+?\s+(employees|team\s+members|associates|colleagues)\b/i,
    /\blarge,?\s+stable\s+employer\b/i,
    // An employee stock purchase plan is a public company's benefit.
    /\b(employee\s+)?stock\s+purchase\s+plan\b|\bespp\b/i,
    // "Builders FirstSource, America's largest supplier", "we are the nation's largest": the employer about itself.
    /(,|\bwe\s+are|\bwe're|\bis)\s+(america|the\s+nation|the\s+country|north\s+america|the\s+world|the\s+u\.?s\.?)['’]?s\s+largest\b/i,
    /\bthe\s+#\s?1\s+name\s+in\s+(our|the)\s+industry\b/i,
    /\bcurrent\s+(associate|employee|team\s+member)s?\b.{0,120}\b(internal|career\s+portal|jobs\s+hub|apply\s+internally)\b/i,
];
/**
 * The duties and the employer a post describes, before anything is spent. Null, or
 * { reason, detail } to exclude. `family` decides whether route and territory signs apply: a
 * dispatcher's post talks about routes and a field team without the seat being in the field.
 */
export function postEvidence({ company, title, text, family }) {
    const t = [title, text].join(' ');
    const name = String(company || '');
    if (hits(FLOOR_DUTIES, t) >= 2) return { reason: 'store_floor_role', detail: 'The duties are store, counter or warehouse floor work (a register, a sales floor, stock or load-out), not a seat a remote person fills.' };
    if ((family === 'sales' || family === 'account') && hits(FIELD_DUTIES, t) >= 2) return { reason: 'field_sales', detail: 'The duties are in-person selling on a route or a territory (account visits, driving, merchandising), not a phone seat.' };
    const strong = t.match(IN_PERSON_STRONG);
    if (strong || hits(IN_PERSON_DUTIES, t) >= 2) return { reason: 'in_person_role', detail: 'The duties need someone there in person' + (strong ? ' ("' + strong[0].replace(/\s+/g, ' ') + '")' : ' (a territory, a counter, lifting or a driver\'s licence)') + ', so a remote person cannot do the job.' };
    if (hits(DESK_DUTIES, t) >= 3) return { reason: 'in_person_desk', detail: 'The seat is a front desk: greeting visitors, handling the mail and keeping the office, which a remote person cannot do.' };
    if (CLINICAL_NAME.test(name) && !NOT_CLINICAL_NAME.test(name)) return { reason: 'institutional_clinical', detail: `${name} is a hospital, care facility or health plan by its name.` };
    if (hits(FACILITY_TEXT, t) >= 2) return { reason: 'institutional_clinical', detail: 'The post describes an inpatient, residential or long-term care facility.' };
    if (hits(PAYER_TEXT, t) >= 2) return { reason: 'institutional_clinical', detail: 'The post describes a health plan serving members and providers, not a small business.' };
    const big = ENTERPRISE_TEXT.find(re => re.test(t));
    if (big) return { reason: 'large_employer', detail: 'The post describes a large employer ("' + (t.match(big) || [''])[0].replace(/\s+/g, ' ').slice(0, 60) + '").' };
    return null;
}
// A store-locator system is a chain's; a /locations/<place> page is one branch of someone.
const LOCATOR_HOST = /^(locations?|stores?|local|branch(es)?|find|directory)\./i;
const LOCATOR_PATH = /\/(store-?locator|storelocator|locator|find-a-(store|location|branch)|store-?finder)(\/|$|\?)/i;
// Yext manages location listings for multi-location brands: its tag on the listing's link is a branch of a chain.
// Yext also tags links as utm_campaign=Yext, and PowerListings is its product name (Capital One, 2026-10-28).
const LOCATOR_TAG = /[?&](utm_source|y_source|utm_campaign|utm_medium)=(yext|powerlistings)\b/i;
const BRANCH_PATH = /\/(stores?|locations?|branch(es)?|offices?)\/[^/?#]+/i;
const BRANCH_NAME = /\b(store|shop|outlet|branch|location)\b/i;
// What Google says the business is, when that alone settles it: a recruiter is a competitor, a care home an institution.
const AGENCY_TYPE = /\b(employment\s+agency|staffing\s+agency|temp(orary)?\s+agency|recruiter|executive\s+search|employment\s+consultant)\b/i;
const CARE_TYPE = /\b(assisted\s+living|nursing\s+home|skilled\s+nursing|retirement\s+(home|community)|senior\s+(living|citizens?\s+center)|memory\s+care|hospice|rehabilitation\s+center|psychiatric|group\s+home)\b/i;
export const remotePost = ({ title, location, extensions }) => /\b(remote|work\s+from\s+home|wfh|telecommute|virtual)\b/i.test([title, location, ...(extensions || [])].join(' '));
/** The city in "3000 Corporate Exchange Dr, Columbus, OH 43231": the part before the state. */
export function addressCity(address) {
    const parts = String(address || '').split(',').map(x => x.trim()).filter(Boolean);
    const i = parts.findIndex(x => /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(x));
    return i > 0 ? parts[i - 1] : null;
}
/**
 * Is the Google listing proof of the employer that posted the job? Null when it is, else
 * { action: 'exclude'|'hold', reason, detail }. A hold is research: kept, never called.
 */
export function listingEvidence({ company, website, domain, listingName, listingType, address, jobLocation, remote }) {
    if (AGENCY_TYPE.test(String(listingType || ''))) return { action: 'exclude', reason: 'competitor', detail: `Google lists them as a ${listingType}: a recruiter, not an employer hiring for its own seat.` };
    if (CARE_TYPE.test(String(listingType || ''))) return { action: 'exclude', reason: 'institutional_clinical', detail: `Google lists them as a ${listingType}, a care institution.` };
    let u = null;
    try { u = website ? new URL(/^https?:/i.test(website) ? website : 'https://' + website) : null; } catch { u = null; }
    if (u && (LOCATOR_HOST.test(u.hostname.replace(/^www\./i, '')) || LOCATOR_PATH.test(u.pathname) || LOCATOR_TAG.test(u.search)))
        return { action: 'exclude', reason: 'chain_location', detail: `The Google listing is one store of a chain: its website is a store-locator page (${u.hostname}${u.pathname.slice(0, 40)}), not the employer's office.` };
    if (u && BRANCH_PATH.test(u.pathname)) return { action: 'hold', reason: 'branch_listing', detail: `The Google listing's website is a branch page (${u.hostname}${u.pathname.slice(0, 40)}), so its number is one location, not proof of who hires.` };
    if (listingName && BRANCH_NAME.test(listingName) && !BRANCH_NAME.test(String(company || ''))) return { action: 'hold', reason: 'branch_listing', detail: `Google's listing is "${listingName}", a store or branch, not "${company}" itself.` };
    if (!domain || NOT_A_HOMEPAGE.test(String(domain)) || /(yelp|linktr\.ee|business\.site|wixsite|square\.site|nextdoor)/i.test(String(domain))) return { action: 'hold', reason: 'no_employer_website', detail: domain ? `Their Google listing points to ${domain}, not a website of their own, so the employer and the number cannot be confirmed.` : 'Their Google listing names no website, so the employer and the number cannot be confirmed.' };
    const jc = cityOf(jobLocation), lc = addressCity(address);
    if (remote && jc && lc && jc.toLowerCase() !== lc.toLowerCase()) return { action: 'hold', reason: 'location_unconfirmed', detail: `A remote post listed in ${jc} was matched to an office in ${lc}; the listing may not be the employer that posted it.` };
    return null;
}
// A Google Jobs listing and a lead someone researched have no posting API to re-read: they age out by date.
// A free board's listing (Workable) keeps the 'google_jobs' source so every date rule holds for it too; job.feed names it.
export const ageBased = source => source === 'google_jobs' || source === 'provided';
/** Where a dated listing was found, as a caller reads it: the free board itself ("Workable"), or "Google Jobs (Indeed)". */
export const listedOn = j => (j && j.feed ? j.via || j.feed : 'Google Jobs' + (j && j.via ? ' (' + j.via + ')' : ''));

// ---- leads a person researched (Madison, 2026-10-28) -------------------------------------------
// Paul: "we just want to be able to give you data on top of what you find on your own". A provided lead
// already names the business, its website, the owner and a number, so it needs no search credit: it goes
// through the same role, employer, opt-out, client, booking and duplicate checks, and the owner's name and
// email ride on the card. The person who found it is credited on the card.
export const leadKey = l => 'lead:' + createHash('sha256').update([l.business, l.role_posted, l.state || l.city].map(x => String(x || '').trim().toLowerCase()).join('|')).digest('hex').slice(0, 20);
// Hosts that many unrelated businesses share (carrier and brokerage agent pages, franchises, directories, social
// sites): a domain here ties a business to nobody.
const SHARED_HOSTS = /(^|\.)(farmers\.com|farmersagent\.com|statefarm\.com|allstate\.com|nationwide\.com|libertymutual\.com|amfam\.com|countryfinancial\.com|edwardjones\.com|kw\.com|kellerwilliams\.com|remax\.com|century21\.com|coldwellbanker\.com|exprealty\.com|compass\.com|servpro\.com|indeed\.com|linkedin\.com|ziprecruiter\.com|glassdoor\.com|simplyhired\.com|facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|youtube\.com|linktr\.ee|nextdoor\.com|google\.com|yelp\.com|bbb\.org|yellowpages\.com|angi\.com|thumbtack\.com|homeadvisor\.com|houzz\.com|idealtraits\.com|careerplug\.com|wizehire\.com|gusto\.com)$/i;
/** A lead's own website domain, or null when the link is a franchise, job-board or social host shared by many businesses. */
export function leadDomain(url) {
    let h; try { h = new URL(/^https?:/i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
    return SHARED_HOSTS.test(h) ? null : h;
}
// Careers platforms and job boards a free board's "website" can point at instead of the employer's own site.
const JOB_BOARD_HOST = /(^|[.-])(careers?|jobs?|hiring|recruit\w*|talent)([.-]|$)|greatcareers|applytojob|jazzhr|breezy\.hr|bamboohr|paylocity|paycom|recruitee|workday|rippling|teamtailor|jobvite|smartrecruiters|dayforce|adp\.com|isolved|hirebridge|myworkday|wixsite|square\.site|business\.site|godaddysites|weebly|carrd\.co|linktr\.ee|careerbuilder|monster\.com|dice\.com|snagajob|wellfound|builtin\.com/i;
/**
 * Is this host the employer's own website? Null when it is, else why not. A website a job board names is proof of the
 * employer only when it is theirs: not a shared host, a careers platform or a job board, and the host carries a
 * distinctive word of the company's name or its initials (PIMCO's "website" was community.lgbtgreatcareers.com,
 * 2026-10-30). fsnb.net is First Southern National Bank's; bar-s.com is not SIGMA's.
 */
export function ownSite(host, company) {
    const h = String(host || '').toLowerCase().replace(/^www\./, '');
    if (!h || !/\.[a-z]{2,}$/.test(h)) return 'no website';
    if (!leadDomain(h)) return `${h} is a host many businesses share`;
    if (BRAND_CAREERS.test(h) || JOB_BOARD_HOST.test(h) || NOT_A_HOMEPAGE.test(h)) return `${h} is a careers site or job board, not their own website`;
    const label = h.split('.').slice(0, -1).join('').replace(/[^a-z0-9]/g, '');
    const words = nameWords(company);
    const distinct = words.filter(w => w.length >= 3 && !GENERIC.has(w));
    const initials = words.map(w => w[0]).join('');
    if (distinct.some(w => (w.length >= 4 ? label.includes(w) : label.startsWith(w))) || (initials.length >= 2 && label === initials) || (initials.length >= 3 && label.startsWith(initials))) return null;
    // The name run together: h2health.com for H2 Health, ablaw.com for AB Law.
    if (words.join('').length >= 4 && label.includes(words.join(''))) return null;
    return `${h} does not carry ${company}'s name`;
}
// Madison's spreadsheet keeps some dates as Excel serial numbers: 46266.0 is 2026-09-01. Read as text they
// matched nothing and the card took the import time, so an eight-week-old post was offered as new (2026-10-28).
const EXCEL_DAY0 = Date.UTC(1899, 11, 30);
/** The date a provided lead says its post was live (an Excel serial or an ISO date in the note), or null. */
export function leadStatedDate(l) {
    const raw = String(l && l.posting_date || '').trim();
    const serial = raw.match(/^(\d{5})(?:\.\d+)?$/);
    if (serial && Number(serial[1]) > 40000 && Number(serial[1]) < 60000) return new Date(EXCEL_DAY0 + Number(serial[1]) * 864e5 + 12 * 3600e3).toISOString();
    const m = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    const t = m ? Date.parse(m[1] + 'T12:00:00Z') : NaN;
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
/** The date a provided post was seen live: the date the lead states, else the import time. */
export function leadPostedAt(l, now = Date.now()) {
    const s = leadStatedDate(l);
    return s && Date.parse(s) <= now ? s : new Date(now).toISOString();
}
/** The lead's date the way a person reads it: a serial number becomes the date it stands for. */
export function leadDateLabel(l) {
    const raw = String(l && l.posting_date || '').trim();
    return /^\d{5}(\.\d+)?$/.test(raw) && leadStatedDate(l) ? 'Posted ' + leadStatedDate(l).slice(0, 10) : raw.slice(0, 160) || null;
}
/** The verdict on one provided lead, before anything is spent. { ok:true, family, ... } or { ok:false, reason, detail }. */
export function qualifyLead(l, now = Date.now()) {
    const title = String(l.role_posted || '').trim(), company = String(l.business || '').trim();
    if (!company || !title) return { ok: false, reason: 'incomplete_lead', detail: 'The lead has no business name or no role.' };
    const ctx = String(l.industry || l.vertical || '');
    const family = roleFamily(title) || (/insurance|agency|lines/i.test(ctx) && roleFamily('Insurance ' + title)) || (/\blaw|legal/i.test(ctx) && roleFamily('Legal ' + title)) || null;
    if (!family) return { ok: false, reason: 'role_not_fillable', detail: `"${title}" is not a customer service, sales, admin or account seat a remote person fills.` };
    const text = [title, l.notes].join(' ');
    const comp = competitorReason({ company, text: l.notes || '' });
    if (comp) return { ok: false, reason: 'competitor', detail: comp };
    const named = companyExcluded(company, [l.industry, l.vertical].filter(Boolean).join(' '));
    if (named) return { ok: false, ...named };
    const ev = postEvidence({ company, title, text, family });
    if (ev) return { ok: false, ...ev };
    const r = restrictions(text);
    const hard = r.hard.filter(x => !/onsite/.test(x));
    if (hard.length) return { ok: false, reason: 'hard_restriction', detail: 'The post ' + hard.join(' and ') + '.' };
    const st = /^[A-Z]{2}$/.test(String(l.state || '').trim().toUpperCase()) ? String(l.state).trim().toUpperCase() : stateOf(l.city || '');
    const remote = /\b(remote|work\s+from\s+home|wfh|telecommute|virtual)\b/i.test(text);
    const postedAt = leadPostedAt(l, now);
    const age = ageDays(postedAt, now);
    if (age > MAX_AGE_DAYS) return { ok: false, reason: 'stale_post', detail: `Seen live ${age} days ago; we only call about the last ${MAX_AGE_DAYS} days.` };
    const city = String(l.city || '').trim() || null;
    return { ok: true, family, age, postedAt, workplace: remote ? 'remote' : 'onsite', restrictions: { ...r, hard }, usState: st || null, city, location: st ? (city ? city + ', ' + st : st) : (remote ? 'Remote (US)' : null) };
}

export const jobKey = j => 'gjobs:' + createHash('sha256').update([j.company_name, j.title, j.location].map(x => String(x || '').trim().toLowerCase()).join('|')).digest('hex').slice(0, 20);
// "Royal Electric", "Royal Electric, LLC" and "Royal Electric Co." are one employer: the key drops legal suffixes.
export const companyKey = (name, location) => 'gco:' + (nameWords(name).join('') || String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '')) + ':' + String(stateOf(location) || '').toLowerCase();
// A business with no website still has one number: a second card on the same number is the same business.
export const phoneKey = n => 'phone:' + String(n || '').replace(/\D/g, '').slice(-10);
// Paul, 2026-10-28: "dont ever publish a 1800 number because we wont call it, go find the cell phone". A toll-free
// line is a switchboard: it is never the number on a card, never a backup, and a card with nothing else waits for a cell.
export const tollFree = n => /^(800|888|877|866|855|844|833)\d{7}$/.test(String(n || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''));
// Paul, 2026-10-28: "we don't want "main" unless they are cell phones in our database". Reversed 2026-10-30 on the call
// results: at these small owner-run businesses the business's own line got a conversation on 46% of dials against 30%
// for RocketReach cells, so a main line is called (the caller asks for the owner) and a lookup is spent only when that
// line fails (lineFailed in _hiring-run.js). MAIN_LINE and mainNumbers still name such lines for the record.
export const MAIN_LINE = /\b(main(\s*-?\s*line)?|mainline|switchboard|front[\s-]?desk|reception(ist)?|headquarters|hq)\b/i;
export const mainLabel = s => MAIN_LINE.test(String(s || '')) && !/\b(mobile|cell)\b/i.test(String(s || ''));
const ten = v => String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
/** The numbers a card knows are a company's main line: its lead's own, when labelled so, and any a later lead named. */
export function mainNumbers(r) {
    const l = r && r.lead || {};
    const note = String(l.phone || '').replace(/[\d+().\-\s]+/g, ' ');
    const own = !String(l.phone_source || '').trim() && ten(l.phone).length === 10 && (mainLabel(l.phone_type) || mainLabel(note)) ? ['+1' + ten(l.phone)] : [];
    return [...new Set([...own, ...((r && r.mainLines) || [])])];
}
/** The numbers a caller may see on a card: never a toll-free line. */
export function callerNumbers(rec) {
    const p0 = rec && rec.phone || {};
    return { number: tollFree(p0.number) ? null : p0.number, alternates: (p0.alternates || []).filter(n => !tollFree(n)) };
}
const STATES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC' };
/** The two-letter state in "Tampa, FL", "Tampa, Florida" or "4518 Ash Ln, Dallas, TX 75223", or null. */
export function stateOf(text) {
    const t = String(text || '');
    const m = t.match(/,\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,|$|\()/);
    if (m && Object.values(STATES).includes(m[1])) return m[1];
    // The state named last wins, and the longer name on a tie: "Charleston, West Virginia" is WV, not VA, and
    // "Kansas City, Missouri" is MO, not KS.
    const low = t.toLowerCase();
    let best = null;
    for (const [name, code] of Object.entries(STATES)) {
        for (const m of low.matchAll(new RegExp('\\b' + name + '\\b', 'g'))) {
            const end = m.index + name.length;
            if (!best || end > best.end || (end === best.end && name.length > best.len)) best = { code, end, len: name.length };
        }
    }
    return best ? best.code : null;
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
    // The employer's own website too, when the listing names one (Workable does): a school's or an agency's (FVI School
    // of Nursing at fvi.edu, 2026-10-30) is a public body whatever its name says.
    const site = j.company_website ? hostOf(j.company_website) : null;
    if (INSTITUTION.test(company) || [...hosts, site].some(h => h && /\.(edu|gov|mil)$/.test(h))) return { ok: false, reason: 'institution', detail: `${company} is a public body, school or hospital system.` };
    const big = links.find(l => ENTERPRISE_ATS.test(l));
    if (big) return { ok: false, reason: 'large_employer', detail: 'They hire through an enterprise system (' + (big.match(ENTERPRISE_ATS) || [''])[0] + '), a sign of a large employer.' };
    // "Columbus, OH (+7 others)": one job posted across many cities is a large employer's.
    const many = String(j.location || '').match(/\(\+\s*(\d+)\s+others?\)/i);
    if (many && Number(many[1]) >= 3) return { ok: false, reason: 'large_employer', detail: `The same job is posted in ${Number(many[1]) + 1} cities, a sign of a large employer.` };
    // The website a free board names counts too: careers.opus2.com is a careers site of their own (Opus 2, 2026-10-30).
    const own = [...hosts, site].find(h => h && BRAND_CAREERS.test(h.replace(/^www\./, '')));
    if (own) return { ok: false, reason: 'large_employer', detail: `They post on a careers site of their own (${own}), a sign of a large employer.` };
    // A free board's own count of the employer's open jobs, read once per company when the listing was found (Workable,
    // api/_hiring-run.js workableDiscovery): BKF 333, Serenity Mental Health Centers 364, LaBella 331 (2026-10-30).
    if (Number(j.open_roles) > LARGE_EMPLOYER_OPEN_ROLES) return { ok: false, reason: 'large_employer', detail: `${j.open_roles} open roles on their ${j.feed || 'job'} board; we prioritize small and midsize businesses.` };
    // Many states AND a real number of openings: one remote seat listed in four states is still a small company.
    if (Number(j.open_states) >= LARGE_EMPLOYER_STATES && Number(j.open_roles) >= 20) return { ok: false, reason: 'large_employer', detail: `They are hiring in ${j.open_states} states at once on their ${j.feed || 'job'} board, a chain or a national firm.` };
    // "Now Hiring", "Entry-Level ... - Chicago, IL", "no experience needed": mass recruiting ads, rarely the employer itself.
    if (/\bnow\s+hiring\b|\bhiring\s+(immediately|now)\b|\bimmediate\s+start\b|\bno\s+experience\s+(needed|necessary|required)\b|\bentry[- ]level\b.*\s-\s*[A-Z][a-zA-Z .]+,\s*[A-Z]{2}\s*$/i.test(title)) return { ok: false, reason: 'recruiting_ad', detail: `"${title}" reads as a mass recruiting ad, not an employer hiring for its own seat.` };
    if (!salesSeatOk(title, j.description)) return { ok: false, reason: 'field_sales', detail: 'A sales seat the post describes as in person (a lot, a showroom, a territory), or never says is by phone.' };
    const ev = postEvidence({ company, title, text: j.description, family });
    if (ev) return { ok: false, ...ev };
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
const FAMILY_WORDS = { support: 'customer support', admin: 'admin', scheduling: 'scheduling', account: 'account support', sales: 'sales', video: 'video editing' };
export const familyWords = f => FAMILY_WORDS[f] || 'support';

/** The short researched brief a caller reads before dialling. Facts only, each one sourced on the record. */
export function briefFor(rec) {
    const j = rec.job || {}, c = rec.company || {}, r = j.restrictions || {};
    const when = j.ageDays == null ? 'is live' : j.ageDays === 0 ? 'went up today' : j.ageDays === 1 ? 'went up yesterday' : `went up ${j.ageDays} days ago`;
    const where = r.offshore ? ` They list it as open to candidates in ${r.offshore}, which is where our people are.` : '';
    const caveat = (r.soft || []).length ? ` Note: the post ${r.soft.join(' and ')}. That is about who they hire directly; a managed placement is a different arrangement, so ask rather than assume.` : '';
    const more = (rec.jobs || []).length > 1 ? ` They have ${rec.jobs.length} matching roles open.` : '';
    return {
        summary: j.source === 'provided'
            ? `${c.name} is hiring a ${j.title}${j.city ? ' in ' + j.city : ''}. ${j.postedLabel ? 'Post: ' + j.postedLabel.replace(/\.$/, '') + '.' : 'The post ' + when + '.'}${j.via ? ' Listed on ' + j.via + '.' : ''} Found by ${j.foundBy || 'our team'}.${where}${more} The seat is one a remote person can do, so offer to fill it and run their hiring for roles like it.`
            : j.source === 'google_jobs'
            ? `${c.name} is hiring a ${j.title}${j.city ? ' in ' + j.city : ''}. The listing ${when} on ${listedOn(j)}.${where}${more} The seat is one a remote person can do, so offer to fill it and run their hiring for roles like it.`
            : `${c.name} is hiring a ${j.title}. The post ${when} and was still open on their careers page when we checked.${where}${more}`,
        need: `A ${familyWords(rec.family)} hire: ${j.title}${j.location ? ' (' + j.location + ')' : ''}.${caveat}${ageBased(j.source) && j.workplace !== 'remote' ? ' They posted it as an in-office job, not a remote opening: offer a remote person for the seat and let them decide.' : ''}`,
        nextStep: 'Book a short call with Paul to scope the role and how we would run their remote hiring for customer service, sales and admin.',
    };
}

/** A hiring record as the dialer's shared call view expects a card. */
export function callRow(rec, viewer, now = Date.now()) {
    const me = String(viewer || '').toLowerCase();
    const owner = rec.callOwner || null;
    const mine = !!owner && String(owner).toLowerCase() === me;
    const lane = laneFor(rec);
    const ready = hiringCallReady(rec, now);
    const p0 = rec.phone || {};
    const p = { ...p0, ...callerNumbers(rec) };
    return {
        id: rec.id, campaignId: HIRING_ID, kind: 'hiring', callQueue: 'shared',
        company: rec.company && rec.company.name || null,
        recipient: rec.contact && rec.contact.email || null,
        verifiedFirstName: rec.contact && rec.contact.firstName || '',
        website: rec.company && rec.company.website || null,
        owner: null, salesOwner: null, sender: null, threadId: null, sentTouches: 0, verifiedSentTouches: 0, lastSentAt: null,
        status: rec.status, exclusion: rec.exclusion ? { reason: rec.exclusion.reason } : null, hold: rec.hold ? { reason: rec.hold.reason } : null, callReady: ready, callOutcome: rec.callOutcome || null, nextCallAt: rec.nextCallAt || null,
        callOwner: owner, callOwnerAt: rec.callOwnerAt || null, callHistory: rec.callHistory || [],
        claimed: !!owner, mine, unclaimed: ready && !owner && (!lane || lane === me), dueForMe: ready && mine, pausedFollowUp: false, ...(lane ? { lane: 'Milton', laneCaller: lane } : {}),
        phone: p.number || null,
        callContact: p.source === 'vendor'
            ? { phone: p.number || null, phoneStatus: p.number ? 'vendor_direct' : 'missing', phoneSource: p.vendor || 'Data vendor', phoneSourceUrl: p.sourceUrl || null, phoneAlternates: p.alternates || [], phoneCheckedAt: p.checkedAt || null, phoneDetail: `${p.person ? p.person + '\'s ' : 'A '}${p.lineType || 'number'} from a ${p.vendor || 'data vendor'} lookup${p.grade ? ' (grade ' + p.grade + ')' : ''}${!p.siteCheck ? '.' : p.siteCheck.result === 'confirmed' ? ', also on their website.' : ', not published on their website.'}` }
            : p.source === 'provided'
            ? { phone: p.number || null, phoneStatus: p.number ? 'provided' : 'missing', phoneSource: 'Found by ' + (p.foundBy || 'our team'), phoneSourceUrl: p.sourceUrl || null, phoneAlternates: p.alternates || [], phoneCheckedAt: p.checkedAt || null, phoneDetail: 'The number from ' + (p.foundBy || 'our team') + '\'s research' + (p.siteCheck && p.siteCheck.result === 'confirmed' ? ', also on their website.' : ', not yet seen on their own website.') }
            : p.source === 'Google business listing'
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
    if (ageBased(j.source)) return Date.parse(j.postedAt) > now - MAX_AGE_DAYS * 864e5;
    return Date.parse(j.checkedAt) > now - FRESH_MS;
}
/**
 * Due for a call now. A card nobody has worked needs a live, recently checked post: the post is
 * the reason for the call. A time someone promised (callback, gatekeeper, "try me later") stays
 * due for its owner even if the post has since closed: the promise was to a person, and the card
 * says the job closed. A plain no-answer retry on a closed or unchecked post is not offered.
 */
export function hiringCallReady(rec, now = Date.now()) {
    if (!rec || rec.status !== 'ready' || !rec.phone || !rec.phone.number || tollFree(rec.phone.number)) return false;
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
    // An owned callback can be covered by anyone; a card nobody can call is refused. "Not interested / stop" always
    // lands: a no on a callback that is not due yet, after a conversation, or on a post gone stale is still a no, and
    // refusing it left the person contactable (Paul, 2026-10-30: "that person is not getting removed from our system").
    if (outcome !== 'suppress' && !hiringCallReady(rec, now)) throw Error('Call is no longer due');
    if (RETRY.includes(outcome) && !(Date.parse(nextCallAt) > now)) throw Error('Choose a future callback time');
    const at = new Date(now).toISOString();
    const d = String(dialled || '').replace(/\D/g, '').slice(-10);
    const entry = { outcome, notes: String(notes || '').slice(0, 4000), at, caller, nextCallAt: RETRY.includes(outcome) ? nextCallAt : null, ...(d.length === 10 ? { dialled: '+1' + d } : {}) };
    const status = outcome === 'connected' ? 'conversation' : outcome === 'wrong_number' ? 'number_research' : outcome === 'suppress' ? 'suppressed' : 'ready';
    return { ...rec, status, callOutcome: outcome, nextCallAt: entry.nextCallAt, callOwner: rec.callOwner || caller, callOwnerAt: rec.callOwnerAt || at, callHistory: [...(rec.callHistory || []), entry], updatedAt: at };
}

/**
 * The email-queue row that means someone at this card's company is being worked by email (a reply, a person's thread,
 * another campaign), so the card is worked there. A Hiring now drip row is never one: the drip runs beside the calls
 * (Paul, 2026-10-30: "milton needs folks to call"). Matches the card's address, or any address at its domain.
 */
export function companyThread(rec, records) {
    const email = String(rec && rec.contact && (rec.contact.email || rec.contact.candidateEmail) || '').toLowerCase();
    const domain = rec && rec.company && rec.company.domain;
    return (records || []).find(r => {
        if (!r || r.campaignId === HIRING_DRIP_ID) return false;
        const to = String(r.recipient || '').toLowerCase(), rd = to.split('@')[1];
        return (email && to === email) || (domain && rd && rd.replace(/^www\./, '') === domain);
    }) || null;
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
    // A card whose employer booked a call is off the list, owned or not (api/_booked-leads.js). So is a person who said
    // no: Paul, 2026-10-30, "not only being removed from our view, but removed from any automated contact as well".
    return recs.filter(r => (r.status === 'ready' || r.callOwner) && r.status !== 'booked' && r.status !== 'suppressed' && !r.booking).map(r => callRow(r, viewer, now));
}
