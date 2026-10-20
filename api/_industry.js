// What kind of business is this, in one word, for the top of a call card.
// ------------------------------------------------------------------
// Paul, 2026-10-20: "can you put an industry tag at the top of each call like an icon".
//
// A caller glancing at a card should know instantly whether they are about to speak to a real
// estate photographer or the CEO of a cybersecurity company, because the whole conversation
// changes. Three sources, in order of how much they are worth trusting:
//
//   1. HubSpot's own industry field, when somebody actually filled it in.
//   2. The campaign, which is definitional for the agency list: that whole cohort IS real estate
//      media, it is the ICP the list was built on.
//   3. The researched excerpt and the company name, matched on terms that only appear in one
//      trade.
//
// When none of them says anything, the card gets NO tag. A wrong industry is worse than none: it
// walks a caller into the wrong opener with false confidence.
import { CAMPAIGN_ID } from './_outreach-campaign.js';

// Ordered: the first match wins, so the more specific patterns are listed first. `key` is what the
// card uses to pick an icon.
// Ordered by SPECIFICITY, not alphabetically, because the first match wins. A term that belongs to
// exactly one trade ("k-12", "matterport", "credit union") has to be tested before a word that
// shows up everywhere ("software", "platform"), or an edtech company reads as a software company
// and the caller opens on the wrong thing.
const RULES = [
    ['re-media', 'Real estate media', /real[ -]estate (photo|video|media|market)|property (photo|video|media)|listing (photo|video|media)|matterport|virtual (tour|staging)|twilight (photo|shoot)|floor ?plan|architectural photo|drone (photo|video)|aerial (photo|video)/i],
    ['education', 'Education', /\beducation\b|\bschool(s)?\b|\bk-?12\b|university|curriculum|\bstudents?\b|\bedtech\b|teaching|classroom/i],
    ['health', 'Healthcare', /\bhealth(care)?\b|medical|clinic|hospital|\bpatients?\b|dental|therapy|pharma|wellness centre|wellness center/i],
    ['legal', 'Legal', /\blaw (firm|office|group)\b|\battorneys?\b|\blegal\b|\bpllc\b|litigation/i],
    ['nonprofit', 'Nonprofit', /non[- ]?profit|charit(y|able)|\bfoundation\b|501\(c\)|\bdonors?\b|\bmuseum\b/i],
    ['construction', 'Construction', /\bconstruction\b|general contractor|civil engineer|design[- ]build|\bbuilders?\b|roofing|concrete|\bmasonry\b|site work|infrastructure/i],
    ['property', 'Property', /property manage|real estate (invest|develop|broker|group|holdings)|\brealty\b|apartments?|multifamily|leasing|commercial real estate/i],
    ['finance', 'Finance', /\bbank(ing)?\b|credit union|lending|mortgage|wealth manage|accounting|\bfintech\b|\bpayments\b|insurance|capital partners/i],
    ['logistics', 'Logistics', /logistics|freight|trucking|supply chain|warehous|distribution centre|distribution center/i],
    ['hospitality', 'Hospitality', /restaurants?|hospitality|\bhotels?\b|catering|\bcafe\b|brewery/i],
    ['home-services', 'Home services', /\bhvac\b|plumbing|electrician|landscap|pest control|cleaning service|garage door|\bpaving\b/i],
    ['marketing', 'Marketing', /marketing agency|digital marketing|advertising|\bbranding\b|\bseo\b|performance marketing|media buying/i],
    // Last on purpose: these words appear in every trade's copy.
    ['software', 'Software', /\bsaas\b|software|cloud platform|cyber ?security|\bdata (platform|protection|security)\b|developer platform|artificial intelligence|\bplatform for\b/i],
];

// HubSpot's own vocabulary, mapped onto ours so a filled-in CRM field is not wasted.
const CRM_MAP = [
    [/real estate|construction|architecture/i, 'construction'],
    [/photograph|motion picture|media production|broadcast/i, 're-media'],
    [/hospital|health|medical|pharmaceutic|biotech/i, 'health'],
    [/bank|financ|insurance|account|invest|capital/i, 'finance'],
    [/software|computer|information technology|internet|security/i, 'software'],
    [/education|e-learning|school/i, 'education'],
    [/marketing|advertis|public relations|design/i, 'marketing'],
    [/non-?profit|philanthrop|civic/i, 'nonprofit'],
    [/legal|law practice/i, 'legal'],
    [/logistics|transportation|warehous|supply/i, 'logistics'],
    [/restaurant|hospitality|food|leisure/i, 'hospitality'],
];

const LABELS = Object.fromEntries(RULES.map(([k, label]) => [k, label]));

/**
 * Returns { key, label, source } or null. `source` is kept so the card can be honest about where
 * the tag came from and so a wrong one is traceable rather than mysterious.
 */
export function industryFor({ campaignId, company = '', excerpt = '', crmIndustry = '', title = '' } = {}) {
    const crm = String(crmIndustry || '').trim();
    if (crm) {
        const hit = CRM_MAP.find(([re]) => re.test(crm));
        if (hit) return { key: hit[1], label: LABELS[hit[1]], source: 'CRM' };
        // A filled-in value we have no mapping for is still better than a guess from prose.
        return { key: 'other', label: crm.slice(0, 28), source: 'CRM' };
    }
    // The agency list is definitional: it was built as the real estate media ICP.
    if (campaignId === CAMPAIGN_ID) return { key: 're-media', label: 'Real estate media', source: 'campaign' };

    const hay = `${company} ${title} ${excerpt}`;
    const hit = RULES.find(([, , re]) => re.test(hay));
    return hit ? { key: hit[0], label: hit[1], source: 'research' } : null;
}
