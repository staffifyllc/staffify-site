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
export async function researchIdentity({ redis, email, contactId, vendorCached = null, lookup, fill, now = Date.now() }) {
    const addr = String(email || '').toLowerCase();
    if (!addr) return { ok: false, found: false, reason: 'no_email' };
    let name = null, title = null, source = null, credit = false;
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
    const identity = { firstName, lastName, title, source, checkedAt: tried.at, email: addr };
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
