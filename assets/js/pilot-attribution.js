// Campaign labels only. Never forward contact identifiers, referrers or arbitrary query data.
export const CAMPAIGN_FIELDS = Object.freeze({
    utm_source: 'utmSource', utm_medium: 'utmMedium', utm_campaign: 'utmCampaign',
    utm_content: 'utmContent', utm_term: 'utmTerm',
});

export function campaignLabel(value) {
    const s = typeof value === 'string' ? value.trim() : '';
    return /^[a-zA-Z0-9_.~-]{1,100}$/.test(s) ? s : '';
}

export function bookingAttribution(tracking = {}) {
    const out = {};
    for (const [query, field] of Object.entries(CAMPAIGN_FIELDS)) {
        const value = campaignLabel(tracking?.[query]);
        if (value) out[field] = value;
    }
    return out;
}

export function mediaBookingUrl(attribution = {}) {
    const url = new URL('https://calendly.com/go-staffify/media-owner-workflow-chat');
    for (const [query, field] of Object.entries(CAMPAIGN_FIELDS)) {
        const value = campaignLabel(attribution[field]);
        if (value) url.searchParams.set(query, value);
    }
    if (!url.searchParams.has('utm_source')) url.searchParams.set('utm_source', 'real-estate-media');
    if (!url.searchParams.has('utm_content')) url.searchParams.set('utm_content', 'owner-page');
    return url.href;
}
