// Staffify UTM tagging, ported from the Mac's staffify-utm.js so cloud email builds the same links.
// ------------------------------------------------------------------
// Scheme (unchanged from the Mac):
//   utm_source   = staffify       (constant: it came from us)
//   utm_medium   = email          (constant: it came from an email)
//   utm_campaign = the track      e.g. welcome, precall, client-marketing
//   utm_content  = the specific email or link, e.g. strategy-call
//
// Only owned properties and Calendly get tagged. Affiliate links are left alone on purpose: they
// carry their own attribution and extra params can break a partner's tracking.
//
// The lead id (lid) is sha256(email + LEAD_ID_SALT), base64url, 12 characters. It must be the SAME
// salt as the Mac's staffify-calendly-config.env, or a cloud email and a Mac email to one person
// carry different ids. The Mac silently used an empty salt when its file was missing; here a
// missing salt returns null, so a sender can refuse instead of minting ids nobody can resolve.
import { createHash } from 'node:crypto';

const TAGGABLE_HOSTS = ['gostaffify.com', 'calendly.com'];
const NEVER_TAG = ['get.quo.com', 'repuso.com', 'staffify-rsvp.vercel.app'];
const SOURCE = 'staffify';
const MEDIUM = 'email';

export const leadIdSalt = () => String(process.env.LEAD_ID_SALT || '').trim();

/** The person's lid, or null when there is no email or no salt. */
export function leadId(email, salt = leadIdSalt()) {
    if (!email || !salt) return null;
    return createHash('sha256').update(String(email).toLowerCase().trim() + salt).digest('base64url').slice(0, 12);
}

export function shouldTag(url) {
    if (!/^https?:\/\//i.test(url)) return false; // mailto:, tel:, #anchor
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
    if (NEVER_TAG.some(h => host === h || host.endsWith('.' + h))) return false;
    return TAGGABLE_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

// Tag one URL. Existing utm_* params win: never overwrite a hand-set tag. `lid` rides as its own
// param on our own pages so the site tracker can pick it up. Calendly drops unknown params but keeps
// utm_term, so the id goes there instead and lands on the booking record.
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

/** Every href in an HTML string, entity-decoded, in order. */
export const hrefs = html => [...String(html).matchAll(/href="([^"]*)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
