// Finding and storing the Instagram datapoint, so a caller is not guessing.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "Can we make sure that that is a datapoint that's available to us so we're not
// guessing I want our sales people to be armed."
//
// Two separate facts, with very different reliability, and the card keeps them apart:
//
//   1. WHICH ACCOUNT IS THEIRS. Solvable and cheap. Their own website links to it, which is the
//      strongest confirmation available: the business itself is telling us. That is persisted with
//      the page it was found on, so a rep can see why we think it is theirs.
//   2. WHEN THEY LAST POSTED. Not solvable from the open web. Instagram serves no post dates to a
//      logged-out fetch, and Paul has already ruled out search snippets as a source. Without an
//      authorized Instagram source this stays UNKNOWN, and unknown keeps the script branch off.
//
// Writing it this way is the point. The expensive failure here is a confident "they have not
// posted since March" built on a page we could not read, so a lookup that fails, is blocked, is
// private or returns no date is recorded AS a failure with its reason, and never as inactivity.
import { instagramBranch, evidenceVerdict, MIN_POST_AGE_DAYS, MAX_CHECK_AGE_DAYS } from './_instagram-branch.js';

export const IG_KEY = email => 'staffify:instagram:' + String(email || '').toLowerCase();
export { instagramBranch, evidenceVerdict, MIN_POST_AGE_DAYS, MAX_CHECK_AGE_DAYS };

const DAY = 86400000;
// Paths under instagram.com that are not a business profile.
const NOT_A_PROFILE = /^(p|reel|reels|stories|explore|accounts|directory|about|legal|developer|tv|s|challenge)$/i;

/** Instagram handles linked from a page, best first. */
export function handlesOnPage(page) {
    const html = String((page && page.html) || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
    const out = new Map();
    for (const m of html.matchAll(/https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?/gi)) {
        const handle = m[1];
        if (NOT_A_PROFILE.test(handle)) continue;
        if (!out.has(handle.toLowerCase())) out.set(handle.toLowerCase(), handle);
    }
    return [...out.values()];
}

/**
 * Look for the business's own Instagram, from their own website.
 * Never throws. Always returns a record, including when it found nothing.
 */
export async function researchInstagram({ website, fetchSite, contactLinks, now = Date.now() }) {
    const base = {
        checkedAt: new Date(now).toISOString(),
        profileUrl: null, profileConfirmed: false, profileConfirmedBy: null,
        latestPostAt: null, latestPostUrl: null, latestPostSummary: null,
        scanned: { feed: false, reels: false }, pinnedExcluded: false,
        private: false, loginBlocked: false, fetchFailed: false,
        unknownReason: null,
    };
    if (!website) return { ...base, unknownReason: 'No website on file to look for a linked profile.' };

    let page = null;
    try { page = await fetchSite(website); } catch (e) {
        return { ...base, fetchFailed: true, unknownReason: 'Their website could not be read: ' + String((e && e.message) || e).slice(0, 90) };
    }
    if (!page) return { ...base, fetchFailed: true, unknownReason: 'Their website returned nothing.' };

    let handles = handlesOnPage(page);
    let foundOn = page.url;
    if (!handles.length && typeof contactLinks === 'function') {
        for (const url of contactLinks(page, 2)) {
            let p = null;
            try { p = await fetchSite(url); } catch { continue; }
            if (!p) continue;
            handles = handlesOnPage(p);
            if (handles.length) { foundOn = p.url; break; }
        }
    }
    if (!handles.length) {
        return { ...base, unknownReason: 'No Instagram link on their website. They may still have an account; we just have no confirmed one.' };
    }
    // More than one linked handle is ambiguous, and guessing which is the business is exactly the
    // mistake that gets a caller talking about the wrong account.
    if (handles.length > 1) {
        return { ...base, candidates: handles.map(h => 'https://www.instagram.com/' + h + '/'),
            unknownReason: 'Their site links ' + handles.length + ' Instagram accounts, so which one is the business is not settled.' };
    }

    return {
        ...base,
        handle: handles[0],
        profileUrl: 'https://www.instagram.com/' + handles[0] + '/',
        profileConfirmed: true,
        profileConfirmedBy: 'linked from their own website, ' + foundOn,
        // Stated plainly rather than left as an empty field somebody might read as "no posts".
        unknownReason: 'Instagram serves no post dates to a logged-out request, so the last post date is unknown. '
            + 'A search snippet is not accepted as a source for this.',
    };
}

/**
 * What the call card shows. Always returns something: a caller should see the state of the
 * research, not a blank space they have to interpret.
 */
export function instagramPanel({ sector, company, evidence, flagged, now = Date.now() }) {
    if (sector !== 'marketing') return null;

    if (flagged && flagged.wrong) {
        return {
            status: 'flagged', label: 'Flagged as wrong',
            detail: `${flagged.by || 'A rep'} flagged this as the wrong profile or date${flagged.note ? ': ' + flagged.note : ''}. The question is suppressed until it is corrected.`,
            profileUrl: (evidence && evidence.profileUrl) || null, branch: null,
        };
    }
    if (!evidence) {
        return { status: 'unknown', label: 'Not researched yet', detail: 'Queued. The Instagram question stays off until there is evidence.', profileUrl: null, branch: null };
    }

    const verdict = evidenceVerdict(evidence, now);
    const checkedAgeDays = evidence.checkedAt ? Math.floor((now - Date.parse(evidence.checkedAt)) / DAY) : null;
    const common = {
        handle: evidence.handle || null,
        profileUrl: evidence.profileUrl || null,
        profileConfirmedBy: evidence.profileConfirmedBy || null,
        postUrl: evidence.latestPostUrl || null,
        postedAt: evidence.latestPostAt || null,
        postSummary: evidence.latestPostSummary || null,
        checkedAt: evidence.checkedAt || null,
        checkedAgeDays,
        candidates: evidence.candidates || null,
    };

    if (verdict.ok) {
        const branch = instagramBranch({ sector, company, evidence, now });
        return { ...common, status: 'verified_stale_posting', label: `Verified: last post ${verdict.postAgeDays} days ago`,
            detail: `At least ${MIN_POST_AGE_DAYS} days with no post, checked ${checkedAgeDays === 0 ? 'today' : checkedAgeDays + ' days ago'}. Grid and reels both checked, pinned posts excluded.`,
            ageDays: verdict.postAgeDays, branch };
    }
    // Recent is a real, verified answer and worth showing. It just means do not ask the question.
    if (typeof verdict.postAgeDays === 'number' && verdict.postAgeDays < MIN_POST_AGE_DAYS) {
        return { ...common, status: 'verified_recent', label: `Posted ${verdict.postAgeDays} day${verdict.postAgeDays === 1 ? '' : 's'} ago`,
            detail: 'They are posting. Do not raise it; use the normal discovery question.', ageDays: verdict.postAgeDays, branch: null };
    }
    if (checkedAgeDays != null && checkedAgeDays > MAX_CHECK_AGE_DAYS && evidence.latestPostAt) {
        return { ...common, status: 'stale', label: 'Evidence too old to quote',
            detail: `Last checked ${checkedAgeDays} days ago. It is being rechecked before the question can be used.`, branch: null };
    }
    return { ...common, status: 'unknown', label: 'Unknown',
        detail: evidence.unknownReason || verdict.reason,
        // Said in as many words, because this is the inference the whole design exists to prevent.
        warning: 'Not seeing posts is not the same as there being none. Do not say anything about their posting.',
        branch: null };
}
