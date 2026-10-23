// The industry of a prospect, as a stored fact rather than a guess made at render time.
// ------------------------------------------------------------------
// Paul picked Option B, which groups every campaign by target industry. That design rests on a
// datapoint that does not currently exist: of 1,630 records in the queue, ZERO store an industry.
// Today the agency campaign reads as "real estate media" because its campaign id is treated as
// definitional in _industry.js, and the Spearhead sectors are recomputed on every request from a
// hand-written list of company names.
//
// Rendering that prettier would not make it true. So the industry becomes a real per-record field,
// derived once from evidence we already hold, stored with WHERE it came from and how much to trust
// it, and left empty when the evidence does not support a call.
//
// Three sources, in descending order of how much they are worth:
//
//   1. A HUMAN SAID SO. A rep or owner set it. Nothing overrides this, ever.
//   2. THE CRM SAYS SO. Somebody filled the field in HubSpot.
//   3. WE READ IT. Their own website copy and company name, through the same classifier the call
//      scripts use, so the card and the grouping can never disagree.
//
// And a fourth state that matters as much as the other three: UNCLASSIFIED. A record with no
// website, no excerpt and an opaque name stays unclassified rather than being swept into whatever
// its campaign happens to be about. On Option B's overview that is a visible count, not a silent
// reassignment, because "we do not know what 300 of these businesses do" is a fact worth seeing.
import { industryFor } from './_industry.js';
import { CAMPAIGN_ID } from './_outreach-campaign.js';

export const INDUSTRY_KEY = 'staffify:prospect-industry:v1';

// What the business itself is, from its name or its own copy.
const MEDIA_BUSINESS = /\b(photo\w*|pix|pics|video\w*|media|studios?|films?|filmmaking|drone|aerial|visuals?|imaging|cinematic|3d tours?|virtual tours?|matterport)\b/i;
// Whether that business serves real estate. Wider than the call-script rule on purpose: listing
// photographers say "realtor", "listings", "exterior" and "properties" far more than they say the
// exact phrase "real estate photography".
const SERVES_REAL_ESTATE = /\b(real[ -]?estate|realtors?|realty|listings?|mls|brokerages?|homes?|home sellers?|houses?|properties|property|open houses?|agents?|twilight|floor ?plans?|exteriors?|interiors?|staging|vacation rentals?|airbnb|builders?|new construction|model homes?|condos?|apartments?)\b/i;
// Positive evidence that a photographer's focus is something other than real estate.
const OTHER_FOCUS = /\b(weddings?|brides?|engagements?|elopements?|newborns?|maternity|boudoir|portraits?|headshots?|seniors?|family sessions?|pet photography|product photography|food photography|fashion|events?|concerts?|sports|lifestyle brands?)\b/i;

/** How far a classification can be trusted, and what it is allowed to drive. */
export const CONFIDENCE = Object.freeze({
    stated: 'A person recorded it.',
    crm: 'Filled in on the CRM record.',
    read: 'Read from their website and name.',
    campaign: 'Assumed from the campaign the list was built as. True of the cohort, unverified per business.',
    none: 'Not enough to say.',
});

/**
 * Classify one record. Pure, so the same input always gives the same answer and it can be tested
 * without a network.
 * @returns {{key:string|null, label:string|null, source:string, confidence:string, why:string}}
 */
export function classify(row, { stated = null, crmIndustry = '', title = '' } = {}) {
    if (stated && stated.key) {
        return { key: stated.key, label: stated.label || stated.key, source: 'stated',
            confidence: 'stated', why: `Set by ${stated.by || 'a teammate'}${stated.at ? ' on ' + String(stated.at).slice(0, 10) : ''}.` };
    }
    const company = (row && row.company) || '';
    const excerpt = (row && row.source && row.source.excerpt) || '';
    const website = (row && ((row.source && row.source.url) || row.website)) || '';

    if (crmIndustry && String(crmIndustry).trim()) {
        const g = industryFor({ company, excerpt, crmIndustry, title });
        if (g) return { key: g.key, label: g.label, source: 'crm', confidence: 'crm', why: `HubSpot industry: ${crmIndustry}.` };
    }

    // A photo or video business is classified by what IT does, not by what its clients do.
    //
    // The first live preview over the 1,508 put "Rancho Photos" in construction, "Bella
    // Photography" in healthcare, "Framed Listings" in hospitality and "Realty Pix Media" in
    // property. Every one is a listing photographer. Their copy says they shoot new-construction
    // homes, or hotels, or properties, and a keyword classifier read the client as the business.
    // So a media business is decided here, before any client-industry keyword gets a vote.
    const hay = `${company} ${excerpt} ${website}`;
    if (MEDIA_BUSINESS.test(company) || MEDIA_BUSINESS.test(excerpt)) {
        if (SERVES_REAL_ESTATE.test(hay)) {
            return { key: 're-media', label: 'Real estate media', source: 'read', confidence: 'read',
                why: 'A photo or video business whose own copy talks about realtors, listings or properties.' };
        }
        // Off target ONLY on positive evidence. A photographer whose copy is about weddings,
        // portraits or brands is a real finding: they may not belong on this list. But a
        // 120-character excerpt that simply never says "real estate" proves nothing about what they
        // shoot, and reading it as "not real estate" is the absence-as-evidence error this whole
        // codebase guards against. So silence falls through to the cohort assumption below, labelled
        // as an assumption, and never to a client's industry.
        if (OTHER_FOCUS.test(hay)) {
            return { key: 'media-other', label: 'Photo and video, other focus', source: 'read', confidence: 'read',
                why: 'A photo or video business whose own copy is about weddings, portraits, brands or events, with no mention of real estate. Possibly off target for this list.' };
        }
        if (row && row.campaignId === CAMPAIGN_ID) {
            return { key: 're-media', label: 'Real estate media', source: 'campaign', confidence: 'campaign',
                why: 'A photo or video business on the real estate media list whose copy does not say either way. Not verified for this business.' };
        }
    }

    // Read from their own words. The campaign is deliberately NOT passed in here: letting the
    // campaign id answer would make every one of the 1,508 agency records "real estate media" by
    // definition, which is the assumption this field exists to replace with evidence.
    if (excerpt.trim() || company.trim()) {
        const g = industryFor({ company, excerpt: excerpt + ' ' + website, crmIndustry: '', title });
        if (g) return { key: g.key, label: g.label, source: 'read', confidence: 'read',
            why: excerpt.trim() ? 'Matched against their website copy.' : 'Matched against the company name.' };
    }

    // The cohort assumption, kept as a LABELLED fallback rather than a fact. The agency list was
    // built as the real estate media ICP, so it is true of the cohort; it is just not evidence
    // about this one business, and the overview shows how many rows rest on it.
    if (row && row.campaignId === CAMPAIGN_ID) {
        return { key: 're-media', label: 'Real estate media', source: 'campaign', confidence: 'campaign',
            why: 'This list was built as the real estate media ICP. Not verified for this business.' };
    }

    return { key: null, label: null, source: 'none', confidence: 'none',
        why: 'No website copy, no CRM industry and nothing in the name. We do not know what they do.' };
}

/** Rate with a sample floor, so a small denominator cannot look like a proven winner. */
export const SAMPLE_FLOOR = 30;
export function rate(numerator, denominator) {
    if (denominator == null) return { value: null, label: '—', note: 'no data', small: true, unknown: true };
    if (denominator === 0) return { value: null, label: '—', note: 'nothing sent', small: true, unknown: true };
    if (denominator < SAMPLE_FLOOR) {
        return { value: null, label: '—', note: `n=${denominator}, below ${SAMPLE_FLOOR}`, small: true, unknown: false };
    }
    return { value: numerator / denominator, label: (Math.round((numerator / denominator) * 1000) / 10) + '%',
        note: `${numerator} of ${denominator}`, small: false, unknown: false };
}

/**
 * Does this campaign genuinely reach more than one industry? That decides where it is shown.
 *
 * "More than one key" was the first rule, and the first real classification broke it: the agency
 * campaign is 1,447 real estate media out of 1,508, with 61 strays, and two strays were enough to
 * move Paul's main campaign into the cross-industry band beside CEO outreach. A campaign built for
 * one industry that picked up a few off-target names is still that industry's campaign; the
 * strays are a list-quality finding, reported separately. So it spans only when no single industry
 * holds a clear majority.
 */
export const DOMINANT_SHARE = 0.8;
export function spansIndustries(counts) {
    const entries = Object.entries(counts || {}).filter(([k]) => k !== 'null' && k !== 'none');
    if (entries.length < 2) return false;
    const total = entries.reduce((n, [, v]) => n + v, 0);
    const top = Math.max(...entries.map(([, v]) => v));
    return total > 0 && top / total < DOMINANT_SHARE;
}

/** The strays in a single-industry campaign: names that are not its industry. */
export function offTarget(counts) {
    const entries = Object.entries(counts || {}).filter(([k]) => k !== 'null' && k !== 'none');
    if (!entries.length) return { dominant: null, strays: 0 };
    entries.sort((a, b) => b[1] - a[1]);
    return { dominant: entries[0][0], strays: entries.slice(1).reduce((n, [, v]) => n + v, 0) };
}
