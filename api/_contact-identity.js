// Who is this, when the CRM only has an email.
// ------------------------------------------------------------------
// Paul, 2026-10-23, on a card that said "McKinstry" and nothing else: "It should be a first name,
// last name ... the system should be capable of conducting research based on incomplete data."
//
// The order of evidence is the same one the number ladder uses. A vendor answer already paid for
// (the number research stores RocketReach's name and title beside the phone) costs nothing and is
// used first. Only then is a lookup credit spent. What is found fills the BLANK HubSpot fields and
// nothing else, through fillBlankContactProps, so a name a human typed is never overwritten, and
// the CRM stays the one source every page reads. The provenance is stored so the card can say
// "Name from RocketReach" rather than present a vendor's guess as a fact we checked.
export const IDENTITY_KEY = email => 'staffify:contact-identity:' + String(email || '').toLowerCase();
export const TRIED_KEY = email => 'staffify:contact-identity-tried:' + String(email || '').toLowerCase();
export const RETRY_DAYS = 30;

/** "Tom Rieck" -> first and last. A single word is a first name; the rest is the last name. */
export function splitName(name) {
    const parts = String(name || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!parts.length) return { firstName: '', lastName: '' };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** Does this CRM record need a name? A first name is what the opener needs. */
export const needsName = props => !String((props && props.firstname) || '').trim();

// A shared inbox is not a person. together@mckinstry.com will never come back from an email
// lookup with a name, and spending a credit asking is the kind of waste a metered API punishes.
// For these the question changes to "who runs this company", answered by a people search.
const GENERIC = new Set(['info','hello','hi','hey','together','contact','contactus','office','admin','sales','team','support','help','careers','hr','jobs','recruiting','marketing','media','press','pr','general','enquiries','inquiries','enquiry','inquiry','mail','email','reception','frontdesk','welcome','service','services','customerservice','booking','bookings','orders','accounts','billing','finance','studio','agency','partners','partnerships','newbusiness','business','work','projects','design','dispatch','operations','ops','estimating','estimates','bids','quotes','webmaster','noreply','no-reply','donotreply']);
export function isGenericAddress(email) {
    const local = String(email || '').toLowerCase().split('@')[0].replace(/[._-]/g, '');
    return !!local && GENERIC.has(local);
}
/** Titles that mean "the person who decides", in the order we would rather reach them. */
export const DECIDER = [/\b(ceo|chief executive)\b/i, /\b(owner|co-?owner|proprietor)\b/i, /\b(founder|co-?founder)\b/i, /\bpresident\b/i, /\b(managing director|managing partner|principal|partner)\b/i, /\b(coo|chief operating)\b/i, /\b(general manager|gm)\b/i, /\bdirector\b/i];
/** The best decision-maker in a list of search profiles, or null. Never a junior title. */
export function pickDecider(profiles = []) {
    const ranked = [];
    for (const pr of profiles) { const t = String((pr && (pr.current_title || pr.title)) || ''); const rank = DECIDER.findIndex(re => re.test(t)); if (rank >= 0 && pr.name) ranked.push({ rank, pr }); }
    ranked.sort((a, b) => a.rank - b.rank);
    return ranked.length ? ranked[0].pr : null;
}

/** The stored answer for an address, or null. Never throws. */
export async function knownIdentity(redis, email) {
    try { const v = await redis.get(IDENTITY_KEY(email)); return v && typeof v === 'object' && v.firstName ? v : null; }
    catch { return null; }
}

/**
 * Find a name for one contact and write it into the blank CRM fields.
 * @param vendorCached  the number research's stored RocketReach record for this address, if any
 * @param lookup        async email -> RocketReach result ({found, name, title, ...}); spends a credit
 * @param fill          async (contactId, {firstname,lastname,jobtitle}) -> {ok, filled}
 * @returns {{ok:boolean, found:boolean, source?:string, firstName?:string, lastName?:string, title?:string, filled?:string[], reason?:string, retryable?:boolean}}
 */
export async function researchIdentity({ redis, email, contactId, company = '', vendorCached = null, lookup, search, fill, now = Date.now() }) {
    const addr = String(email || '').toLowerCase();
    if (!addr) return { ok: false, found: false, reason: 'no_email' };
    let name = null, title = null, source = null, credit = false;
    // A shared inbox: find who runs the company instead. The answer is INFERRED, so it is kept
    // for the card ("ask for ...") and never written into the CRM as the inbox's own name.
    if (isGenericAddress(addr)) {
        if (!String(company || '').trim() || typeof search !== 'function') {
            const why = typeof search !== 'function' ? 'shared inbox; no people search is configured' : 'shared inbox; no company name to search by';
            try { await redis.set(TRIED_KEY(addr), { at: new Date(now).toISOString(), found: false, credit: false, source: 'RocketReach search', kind: 'inferred', reason: why }, { ex: 86400 }); } catch { /* still an answer */ }
            return { ok: true, found: false, reason: why, credit: false };
        }
        let r = null;
        try { r = await search({ company: String(company).trim() }); } catch (e) { return { ok: false, found: false, reason: String((e && e.message) || e).slice(0, 120), retryable: true }; }
        if (!r || r.retryable) return { ok: false, found: false, reason: (r && r.reason) || 'no answer', retryable: true };
        const who = pickDecider(r.profiles || []);
        const tried = { at: new Date(now).toISOString(), found: !!who, credit: false, source: 'RocketReach search', kind: 'inferred' };
        try { await redis.set(TRIED_KEY(addr), tried, { ex: RETRY_DAYS * 86400 }); } catch { /* result still returns */ }
        if (!who) return { ok: true, found: false, reason: 'shared inbox; no decision-maker found by search', credit: false };
        const { firstName, lastName } = splitName(who.name);
        const identity = { kind: 'inferred', firstName, lastName, title: who.current_title || who.title || null, source: 'RocketReach search', linkedin: who.linkedin_url || null, company: String(company).trim(), checkedAt: tried.at, email: addr };
        try { await redis.set(IDENTITY_KEY(addr), identity, { ex: 365 * 86400 }); } catch { /* the answer still returns */ }
        return { ok: true, found: true, kind: 'inferred', source: identity.source, firstName, lastName, title: identity.title, filled: [], credit: false };
    }
    if (vendorCached && vendorCached.name) { name = vendorCached.name; title = vendorCached.title || null; source = vendorCached.source || 'RocketReach'; }
    else if (typeof lookup === 'function') {
        let r = null;
        try { r = await lookup(addr); } catch (e) { return { ok: false, found: false, reason: String((e && e.message) || e).slice(0, 120), retryable: true }; }
        if (!r || r.retryable || r.pending) return { ok: false, found: false, reason: (r && r.reason) || 'no answer', retryable: true };
        credit = true;
        if (r.found && r.name) { name = r.name; title = r.title || null; source = 'RocketReach'; }
    }
    const tried = { at: new Date(now).toISOString(), found: !!name, credit, source };
    try { await redis.set(TRIED_KEY(addr), tried, { ex: RETRY_DAYS * 86400 }); } catch { /* the lookup result still returns */ }
    if (!name) return { ok: true, found: false, reason: 'not found', credit };

    const { firstName, lastName } = splitName(name);
    const identity = { kind: 'person', firstName, lastName, title, source, checkedAt: tried.at, email: addr };
    let filled = [];
    if (contactId && typeof fill === 'function') {
        try { const f = await fill(contactId, { firstname: firstName, lastname: lastName, jobtitle: title }); if (f && f.ok) filled = f.filled || []; identity.crm = f && f.ok ? { filled } : { error: (f && f.reason) || 'fill failed' }; }
        catch (e) { identity.crm = { error: String((e && e.message) || e).slice(0, 120) }; }
    }
    try { await redis.set(IDENTITY_KEY(addr), identity, { ex: 365 * 86400 }); } catch { /* the CRM write already happened */ }
    return { ok: true, found: true, source, firstName, lastName, title, filled, credit };
}

/** Has this address been looked up inside the retry window? Never throws. */
export async function triedRecently(redis, email, now = Date.now()) {
    try { const t = await redis.get(TRIED_KEY(email)); return !!(t && t.at && now - Date.parse(t.at) < RETRY_DAYS * 86400000); }
    catch { return false; }
}
