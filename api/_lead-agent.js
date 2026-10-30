// The lead agent's door into the Hub.
// ------------------------------------------------------------------
// Paul, 2026-10-30: "I need to create an agent who will go and get lists like maddie has all day every day". The agent
// runs on Anthropic's side (a scheduled Managed Agent) and calls api/lead-agent.js with its own key, kept in Paul's
// Staffify vault. It can ask four things and do one:
//   check    is this company, domain, number or address already known (a card, a waiting lead, the email queue, the
//            stop list)? Asked before any research is spent on it.
//   people   who runs this company, by title (RocketReach search, free).
//   lookup   one person's numbers and addresses (RocketReach premium lookup), inside a daily cap and above the monthly
//            reserve the Hub's own hourly lookups keep. collect picks up a lookup RocketReach is still finishing.
//   phone    what the carrier says each number is (Twilio line type), inside a daily cap, remembered per number.
//   submit   leads into the Hiring now pending queue, each with the owner's own cell and email, checked again here.
// Paul's rule holds at the door: a lead without the owner's mobile is refused, never a main line. The agent's word that a
// number is a cell is not proof: only a carrier's answer (with the carrier's name) or a RocketReach lookup this door
// made is. Paul, 2026-10-30: "It should not always count on Rocket Reach to go and find the cell phone numbers ... we
// have 1,000 a month", so the agent looks in public places first and asks the carrier, and looks people up last.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const LOOKUPS_PER_DAY = () => Math.max(0, Number(process.env.LEAD_AGENT_LOOKUPS_PER_DAY || 30));
export const CHECKS_PER_DAY = () => Math.max(0, Number(process.env.LEAD_AGENT_PHONE_CHECKS_PER_DAY || 150));
export const carrierConfigured = (env = process.env) => !!(env.TWILIO_SID && env.TWILIO_AUTH);
export const RESERVE = 100;   // the same monthly reserve as the Hub's own lookups (api/_hiring-run.js RR_RESERVE)
const K = {
    lookups: day => 'staffify:lead-agent:lookups:' + day,
    submitted: day => 'staffify:lead-agent:submitted:' + day,
    log: 'staffify:lead-agent:log',
    checks: day => 'staffify:lead-agent:phone-checks:' + day,
    // What we know a number is, and how: { by: 'carrier' | 'rocketreach', type, carrier, person, grade, at }.
    line: d10 => 'staffify:lead-agent:line:' + d10,
};

/** The agent's key: LEAD_AGENT_TOKEN when set, else derived from the cron secret (no new setting to make). */
export function agentToken(env = process.env) {
    if (env.LEAD_AGENT_TOKEN) return String(env.LEAD_AGENT_TOKEN);
    return env.CRON_SECRET ? createHmac('sha256', env.CRON_SECRET).update('staffify-lead-agent-v1').digest('hex').slice(0, 48) : '';
}
export function agentAuthorized(req, env = process.env) {
    const want = agentToken(env);
    const got = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '').replace(/^Bearer\s+/i, '');
    if (!want || !got || want.length !== got.length) return false;
    try { return timingSafeEqual(Buffer.from(want), Buffer.from(got)); } catch { return false; }
}

const ten = n => String(n || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const norm = n => String(n || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/\b(llc|inc|corp|co|pllc|pc|pa|llp|ltd|the|and|group|company)\b|&/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const host = u => { try { return new URL(/^https?:/i.test(String(u)) ? String(u) : 'https://' + u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const FREE = /^(gmail|yahoo|hotmail|outlook|aol|icloud|me|live|msn|proton|protonmail|comcast)\./i;

/**
 * Everything the Hub already knows, as four sets: company names, domains, numbers and addresses, each pointing at why.
 * deps: { cards: () => hiring records, pending: () => pending lead entries, queue: () => email queue state, stops: () => optedOutSet }
 */
export async function knownIndex(deps) {
    const [cards, pending, queue, stops] = await Promise.all([deps.cards(), deps.pending(), deps.queue(), deps.stops().catch(() => null)]);
    const idx = { names: new Map(), domains: new Map(), phones: new Map(), emails: new Map(), stops };
    const add = (m, k, why) => { if (k && !m.has(k)) m.set(k, why); };
    for (const r of cards || []) {
        const why = 'already a Hiring now card (' + r.status + ')';
        add(idx.names, norm(r.company && r.company.name), why);
        add(idx.domains, String(r.company && r.company.domain || '').toLowerCase().replace(/^www\./, ''), why);
        for (const n of [r.phone && r.phone.number, ...((r.phone && r.phone.alternates) || []), ...(r.mainLines || [])]) add(idx.phones, ten(n), why);
        for (const e of [r.contact && r.contact.email, r.contact && r.contact.candidateEmail]) add(idx.emails, String(e || '').toLowerCase(), why);
    }
    for (const p of pending || []) {
        const l = p && p.lead; if (!l) continue;
        const why = 'already waiting to be checked as a lead';
        add(idx.names, norm(l.business), why); add(idx.domains, host(l.website), why); add(idx.phones, ten(l.phone), why); add(idx.emails, String(l.owner_email || '').toLowerCase(), why);
    }
    for (const r of (queue && queue.records) || []) {
        const why = 'already in a Staffify email campaign';
        const e = String(r.recipient || '').toLowerCase();
        add(idx.emails, e, why);
        const d = e.split('@')[1]; if (d && !FREE.test(d)) add(idx.domains, d, why);
        if (r.website) add(idx.domains, host(r.website), why);
        if (r.company) add(idx.names, norm(r.company), why);
    }
    return idx;
}

/** Why an item is already known, or null. item: { company, domain|website, phone, email } */
export function knownWhy(idx, item) {
    const e = String(item.email || '').trim().toLowerCase(), p = ten(item.phone), d = host(item.domain || item.website || ''), n = norm(item.company || item.business);
    if (idx.stops && ((e && idx.stops.emails.has(e)) || (p.length === 10 && idx.stops.numbers.has(p)))) return 'on the do-not-contact list';
    return (n && idx.names.get(n)) || (d && !FREE.test(d) && idx.domains.get(d)) || (p.length === 10 && idx.phones.get(p)) || (e && idx.emails.get(e)) || null;
}

/** A lead just accepted, so a second one for the same business in the same batch reads as known. */
export function remember(idx, l, why = 'submitted earlier in this batch') {
    const set = (m, k) => { if (k && !m.has(k)) m.set(k, why); };
    set(idx.names, norm(l.business)); set(idx.domains, host(l.website)); set(idx.phones, ten(l.phone)); set(idx.emails, String(l.owner_email || '').toLowerCase());
}

const MOBILE = /\b(mobile|cell)\b/i;
const parseJson = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
const LINE_TTL = 90 * 86400;

/** Twilio's line type for one US number: { type, carrier }. Throws when Twilio does not answer. */
export async function carrierLookup(d10, { env = process.env, fetcher = fetch } = {}) {
    const r = await fetcher('https://lookups.twilio.com/v2/PhoneNumbers/%2B1' + d10 + '?Fields=line_type_intelligence', {
        headers: { Authorization: 'Basic ' + Buffer.from(env.TWILIO_SID + ':' + env.TWILIO_AUTH).toString('base64') }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw Error('carrier lookup failed: ' + r.status);
    const lti = ((await r.json()) || {}).line_type_intelligence || {};
    return { type: String(lti.type || 'unknown').toLowerCase(), carrier: String(lti.carrier_name || '').trim() };
}
/** A cell, and proven: a carrier that named itself and said mobile, or a RocketReach lookup this door made that said mobile. */
export const provenCell = proof => !!proof && (proof.by === 'carrier' ? proof.type === 'mobile' && !!proof.carrier : proof.by === 'rocketreach' && MOBILE.test(String(proof.type || '')));

/**
 * The carrier's answer for up to 10 numbers. A number asked before is answered from memory, free; a new one counts against
 * the day's cap. deps: { kv, day, lookup(d10), tollFree(d10) }. Each result: { number, type, carrier, mobile } or { number, error }.
 */
export async function phoneCheck(deps, numbers, now = Date.now()) {
    const { kv, day, lookup, tollFree } = deps;
    const cap = CHECKS_PER_DAY(), out = [];
    for (const raw of numbers.slice(0, 10)) {
        const d = ten(raw);
        if (d.length !== 10) { out.push({ number: String(raw), error: 'not a 10-digit US number' }); continue; }
        if (tollFree(d)) { out.push({ number: d, type: 'tollfree', carrier: null, mobile: false }); continue; }
        const known = parseJson(await kv.get(K.line(d)));
        if (known && known.by === 'carrier') { out.push({ number: d, type: known.type, carrier: known.carrier || null, mobile: provenCell(known), cached: true }); continue; }
        const used = Number(await kv.incr(K.checks(day)));
        await kv.expire(K.checks(day), 3 * 86400);
        if (used > cap) { await kv.decr(K.checks(day)).catch(() => {}); out.push({ number: d, error: `The day's ${cap} carrier checks are used.` }); continue; }
        try {
            const r = await lookup(d);
            const rec = { by: 'carrier', type: r.type, carrier: r.carrier || null, at: new Date(now).toISOString() };
            if (r.type !== 'unknown') await kv.set(K.line(d), rec, { ex: LINE_TTL });
            out.push({ number: d, type: r.type, carrier: r.carrier || null, mobile: provenCell(rec) });
        } catch (e) {
            await kv.decr(K.checks(day)).catch(() => {});
            out.push({ number: d, error: 'The carrier could not be asked: ' + String((e && e.message) || e).slice(0, 80) });
        }
    }
    return out;
}

/** The numbers a RocketReach lookup returned, remembered so a submit can prove them. A carrier's answer is never overwritten. */
export async function rememberLines(kv, profile, now = Date.now()) {
    for (const x of (profile && profile.phones) || []) {
        const d = ten(x && x.number);
        if (d.length !== 10) continue;
        const known = parseJson(await kv.get(K.line(d)));
        if (known && known.by === 'carrier') continue;
        await kv.set(K.line(d), { by: 'rocketreach', type: x.type || null, grade: x.grade || null, person: profile.name || null, at: new Date(now).toISOString() }, { ex: LINE_TTL });
    }
}
/** What we know about a submitted number (the submit handler reads it before leadProblem). */
export const lineProof = async (kv, phone) => { const d = ten(phone); return d.length === 10 ? parseJson(await kv.get(K.line(d))) : null; };
const EMAIL = /^[^\s@<>()",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
export const LEAD_FIELDS = ['owner_first', 'owner_last', 'owner_title', 'business', 'industry', 'city', 'state', 'website', 'owner_email', 'phone', 'phone_type', 'phone_source_url', 'role_posted', 'posting_url', 'posting_date', 'email_source_url', 'notes', 'vertical'];
/**
 * The phone fields the Hub writes itself from the proof, never the agent's: the hourly run then treats the number as a
 * named person's looked-up cell (it stays first, and the Hub spends no lookup of its own on the card).
 */
export function provenPhone(l, proof) {
    const person = [l.owner_first, l.owner_last].filter(Boolean).join(' ') || null;
    return proof.by === 'carrier'
        ? { phone_type: 'mobile', phone_source: 'carrier-checked public listing', phone_person: person, phone_grade: null }
        : { phone_type: 'mobile', phone_source: 'RocketReach', phone_person: proof.person || person, phone_grade: proof.grade || null };
}
/**
 * Why a submitted lead is refused, or null. The same rules the agent was given, checked again here: the owner's own
 * mobile and an email, a seat we fill, a post we may still call about (qualifyLead), and nobody we already know.
 */
export function leadProblem(l, { idx, qualify, tollFree, proof = null, now = Date.now() }) {
    if (!l.business || !l.role_posted) return 'business and role_posted are required';
    if (!/^https:\/\//i.test(String(l.posting_url || ''))) return 'posting_url must be the https link to the posting';
    if (!l.owner_first) return 'owner_first is required: a lead is a named owner';
    if (!EMAIL.test(String(l.owner_email || ''))) return 'owner_email is required';
    const p = ten(l.phone);
    if (p.length !== 10) return 'phone must be a 10-digit US number';
    if (tollFree(p)) return 'a toll-free number is never a lead';
    if (!proof) return 'phone is not proven a cell: ask the carrier (action phone) or look the owner up first. Never a main line.';
    if (!provenCell(proof)) return proof.by === 'carrier' ? `the carrier says this number is ${proof.type || 'unknown'}${proof.carrier ? ' (' + proof.carrier + ')' : ''}, not a cell: never a main line` : 'RocketReach did not list this number as a mobile: never a main line';
    if (proof.by === 'carrier' && !/^https:\/\//i.test(String(l.phone_source_url || ''))) return 'phone_source_url is required: the https page where the owner\'s number was found';
    const q = qualify(l, now);
    if (!q.ok) return 'refused by the Hub rules: ' + q.reason + (q.detail ? ' (' + String(q.detail).slice(0, 120) + ')' : '');
    const known = knownWhy(idx, { company: l.business, website: l.website, phone: l.phone, email: l.owner_email });
    return known ? 'already known: ' + known : null;
}

/** What the agent may see of a RocketReach profile: who, where, and each number and address with RocketReach's own type and grade. */
export const agentProfile = p => p && ({ id: p.id, name: p.name, title: p.title, employer: p.employer, employer_domain: p.employerDomain, location: p.location,
    phones: (p.phones || []).map(x => ({ number: x.number, type: x.type, grade: x.grade, valid: x.valid })),
    emails: (p.emails || []).map(x => ({ email: x.email, type: x.type, grade: x.grade, smtp: x.smtp })) });

/**
 * One premium lookup inside the day's cap and above the month's reserve. deps: { kv, rr: { account, lookupPerson }, day }
 * Returns { ok, ... } or { ok:false, error }.
 */
export async function capLookup(deps, { id, name, company }) {
    const { kv, rr, day } = deps;
    if (!id && !(name && company)) return { ok: false, status: 400, error: 'Give a RocketReach id, or a name and a company' };
    const cap = LOOKUPS_PER_DAY();
    const used = Number(await kv.incr(K.lookups(day)));
    await kv.expire(K.lookups(day), 3 * 86400);
    const refund = () => kv.decr(K.lookups(day)).catch(() => {});
    if (used > cap) { await refund(); return { ok: false, status: 429, error: `The day's ${cap} lookups are used. Stop for today.`, lookups_left: 0 }; }
    let left = null;
    try { const a = await rr.account(); const u = a && Array.isArray(a.creditUsage) ? a.creditUsage.find(c => c && c.credit_type === 'premium_lookup') : null; left = u && Number.isFinite(Number(u.remaining)) ? Number(u.remaining) : null; } catch { left = null; }
    if (left == null) { await refund(); return { ok: false, status: 503, error: 'The RocketReach balance could not be read. Try again later.' }; }
    if (left <= RESERVE) { await refund(); return { ok: false, status: 429, error: `${left} lookups left this month; ${RESERVE} are kept for the Hub. Stop for today.`, lookups_left: 0 }; }
    const r = await rr.lookupPerson(id ? { id } : { name, employer: company });
    if (r.profile) await rememberLines(kv, agentProfile(r.profile)).catch(() => {});
    // A lookup that found nobody costs nothing at RocketReach, so it does not count against the day either.
    if (!r.found && !r.pending && !r.profile) await refund();
    return { ok: true, found: !!r.found, pending: !!r.pending, reason: r.reason || null, profile: agentProfile(r.profile), lookups_left: Math.max(0, cap - (r.found || r.pending || r.profile ? used : used - 1)) };
}

export { K as LEAD_AGENT_KEYS };
