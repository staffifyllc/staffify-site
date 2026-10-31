// Staffify UTM tagging and lead ids, for every email the site sends.
// ------------------------------------------------------------------
// A port of ~/Claude Code/staffify-utm.js, the helper every desktop email job tags its links with, so
// a cloud job builds exactly the links the Mac built. The rules below are the desktop file's, line for
// line; the only change is where the salt comes from.
//
// Scheme:
//   utm_source   = staffify        (constant: it came from us)
//   utm_medium   = email           (constant: it came from an email)
//   utm_campaign = the track       e.g. client-marketing, prospect-drip-general, precall, workshop
//   utm_content  = the specific email or link  e.g. admin-morning-qc, video-stage2
//
// Only owned properties and Calendly get tagged. Affiliate links are left alone on purpose: they carry
// their own attribution and extra params can break a partner's tracking.
//
// The lead id is a stable, opaque id per person, derived from their email so it never needs a lookup at
// send time and never changes. The raw email stays out of the URL. It must be the SAME id the Mac
// computes, so the salt has to be the same value: env LEAD_ID_SALT, copied from the desktop's
// staffify-calendly-config.env. The desktop quietly hashed with an empty salt when its file was
// unreadable. Here a missing salt gives no id at all (null), because an unsalted id is a different id
// for the same person and a guessable one; a sender that needs ids checks leadIdReady() and refuses.
import { createHash } from 'node:crypto';

const TAGGABLE_HOSTS = ['gostaffify.com', 'calendly.com'];
const NEVER_TAG = ['get.quo.com', 'repuso.com', 'staffify-rsvp.vercel.app'];

const SOURCE = 'staffify';
const MEDIUM = 'email';

const envSalt = () => String(process.env.LEAD_ID_SALT || '').trim();

/** Can lead ids be built here? False until LEAD_ID_SALT is set. */
export const leadIdReady = (salt = envSalt()) => !!salt;

/** The person's lead id, or null when there is no salt to build it with. */
export function leadId(email, salt = envSalt()) {
    if (!email || !salt) return null;
    return createHash('sha256')
        .update(String(email).toLowerCase().trim() + salt)
        .digest('base64url').slice(0, 12);
}

export function shouldTag(url) {
    if (!/^https?:\/\//i.test(url)) return false;           // mailto:, tel:, #anchor
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
    if (NEVER_TAG.some(h => host === h || host.endsWith('.' + h))) return false;
    return TAGGABLE_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

// Tag one URL. Existing utm_* params win: never overwrite a hand-set tag.
// `lid` rides as its own param on our own pages so the site tracker can pick it up. Calendly drops
// unknown params but keeps utm_term, so the id goes there instead and lands on the booking record.
export function tagUrl(url, { campaign, content, lid } = {}) {
    if (!shouldTag(url)) return url;
    let u;
    try { u = new URL(url); } catch { return url; }
    if (u.searchParams.has('utm_source')) return url;
    u.searchParams.set('utm_source', SOURCE);
    u.searchParams.set('utm_medium', MEDIUM);
    if (campaign) u.searchParams.set('utm_campaign', campaign);
    if (content) u.searchParams.set('utm_content', content);
    if (lid) {
        const host = u.hostname.toLowerCase();
        if (host === 'calendly.com' || host.endsWith('.calendly.com')) u.searchParams.set('utm_term', lid);
        else u.searchParams.set('lid', lid);
    }
    return u.toString();
}

// Rewrite every href in an HTML string. Image src is untouched.
export function tagHtml(html, opts = {}) {
    return html.replace(/href="([^"]*)"/g, (m, url) => {
        const tagged = tagUrl(url.replace(/&amp;/g, '&'), opts);
        return tagged === url ? m : `href="${tagged.replace(/&/g, '&amp;')}"`;
    });
}
