// Do-not-contact list. One source of truth for the whole sales hub.
//
// Someone who says STOP has withdrawn consent, and that applies to EVERY channel, not just the one
// they replied on. Carriers honour STOP for SMS automatically, but that does nothing about our calls,
// our emails or a text from a different number, so we keep our own list and check it before we reach out.
//
// Stored as last-10 digits for numbers and lowercased addresses for email, so formatting never lets
// a suppressed contact slip back through.

import { redis } from './_auth.js';

const NUMS = 'optout:numbers';
const MAILS = 'optout:emails';
const LOG = 'optout:log';
// The email side of the house already had its own list, fed by the one-click unsubscribe footer.
// It stays where it is, but every suppression check consults it as well, so there is one gate on the
// way out rather than two lists that each know half the story.
const LEGACY_MAILS = 'unsubscribed:set';

// What counts as an opt-out. Carriers treat STOP as an EXACT match and so do we: a bare keyword on
// its own is an opt-out, but "stop by tomorrow and we can chat" is a person being friendly and must
// not be suppressed. Longer phrases that are unambiguous ("unsubscribe", "opt out", "remove me")
// are honoured anywhere in a short reply, because nobody writes those casually.
const EXACT = new Set(['stop','stopall','stop all','end','quit','cancel','unsubscribe','optout','opt out',
                       'remove','remove me','no more','delete','stop texting','stop texting me']);
const PHRASE = /\b(unsubscribe|opt\s*out|remove me|take me off|stop (texting|calling|contacting|messaging)|do ?n[o']?t contact)\b/i;

export function looksLikeOptOut(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    const norm = raw.toLowerCase().replace(/[.!,;:'"()\-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (EXACT.has(norm)) return true;
    if (norm.length <= 60 && PHRASE.test(norm)) return true;
    return false;
}

export const last10 = (p) => String(p || '').replace(/[^0-9]/g, '').slice(-10);
const normEmail = (e) => String(e || '').trim().toLowerCase();

export async function optOut({ phone, email, reason, source, text }) {
    const d = last10(phone), m = normEmail(email);
    if (!d && !m) return { ok: false, reason: 'no_identifier' };
    try {
        if (d) await redis.sadd(NUMS, d);
        if (m) await redis.sadd(MAILS, m);
        await redis.lpush(LOG, JSON.stringify({
            at: Date.now(), phone: d || '', email: m || '',
            reason: reason || 'replied stop', source: source || '', text: String(text || '').slice(0, 200),
        }));
        await redis.ltrim(LOG, 0, 999);
    } catch (e) { return { ok: false, reason: 'store_failed' }; }
    return { ok: true, phone: d, email: m };
}

// Checked before ANY outbound touch. Fails closed: if the store cannot be read we treat the contact
// as suppressed, because sending to someone who opted out is worse than missing one send.
export async function isOptedOut({ phone, email }) {
    const d = last10(phone), m = normEmail(email);
    if (!d && !m) return false;
    try {
        if (d && await redis.sismember(NUMS, d)) return true;
        if (m && await redis.sismember(MAILS, m)) return true;
        if (m && await redis.sismember(LEGACY_MAILS, m)) return true;
        return false;
    } catch (e) { return true; }
}

// Bulk check, so a queue of leads can be filtered in one round trip rather than one call per lead.
export async function optedOutSet() {
    try {
        const [nums, mails, legacy] = await Promise.all([
            redis.smembers(NUMS), redis.smembers(MAILS), redis.smembers(LEGACY_MAILS),
        ]);
        return {
            numbers: new Set(nums || []),
            emails: new Set([...(mails || []), ...(legacy || [])].map(normEmail)),
        };
    } catch (e) { return { numbers: new Set(), emails: new Set() }; }
}

// A STOP arrives on one channel but withdraws consent for all of them. The text gives us a phone
// number and nothing else, so we look the person up in HubSpot and suppress their email address at the
// same time. Without this step "unsubscribe from all comms" would still leave the nurture emails running.
export async function optOutEverywhere({ phone, email, reason, source, text }) {
    const first = await optOut({ phone, email, reason, source, text });
    if (!first.ok) return first;

    const alsoSuppressed = [];
    try {
        const hs = await import('./_hubspot.js');
        if (hs.configured && hs.configured()) {
            const contact = await hs.findContact({ phone, email });
            const props = (contact && contact.properties) || {};
            const otherMail = normEmail(props.email);
            const otherPhone = last10(props.phone || props.mobilephone);
            if (otherMail && otherMail !== normEmail(email)) {
                await optOut({ email: otherMail, reason, source: (source || '') + ' (linked contact)', text });
                alsoSuppressed.push(otherMail);
            }
            if (otherPhone && otherPhone !== last10(phone)) {
                await optOut({ phone: otherPhone, reason, source: (source || '') + ' (linked contact)', text });
                alsoSuppressed.push(otherPhone);
            }
        }
    } catch (e) { /* the primary suppression already landed; linking is best effort */ }

    return { ...first, alsoSuppressed };
}

export async function optOutList() {
    try {
        const [nums, mails, log] = await Promise.all([redis.smembers(NUMS), redis.smembers(MAILS), redis.lrange(LOG, 0, 199)]);
        return {
            numbers: nums || [], emails: mails || [],
            recent: (log || []).map(x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } }).filter(Boolean),
        };
    } catch (e) { return { numbers: [], emails: [], recent: [] }; }
}
