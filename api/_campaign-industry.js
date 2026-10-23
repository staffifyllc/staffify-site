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

/** Does this campaign reach more than one industry? That decides where it is shown. */
export function spansIndustries(counts) {
    const keys = Object.keys(counts || {}).filter(k => k !== 'null' && k !== 'none');
    return keys.length > 1;
}
