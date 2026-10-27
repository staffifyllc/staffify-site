// Campaigns paused for new outreach. History, suppressions and owned conversations are untouched.
// ------------------------------------------------------------------
// Paul, 2026-10-27 (relayed by the project manager he left in charge): "Stop targeting real estate
// media/REP agencies. Pause their sourcing, new introductions and automatic follow-ups immediately,
// preserve history/suppressions and legitimate existing human conversations. Remove that industry
// from the active unworked call pool without deleting records or hiding owned callbacks."
//
// What "paused" means here, and only here:
//   * no automatic draft or send for the campaign (the hosted worker's campaignAllowed), whatever
//     the cloud config's allowedCampaignIds says;
//   * its unworked cards leave every caller's pool (unclaimed=false). A card a caller already owns
//     (their callback, their retry) stays theirs, so a promise made on a call is still kept;
//   * records, history, suppressions and replies stay exactly as they are.
export const PAUSED_CAMPAIGNS = Object.freeze({
    'staffify-agency-outreach': Object.freeze({ since: '2026-10-27', reason: 'Paul: stop targeting real estate media / REP agencies' }),
});
export const PAUSED_INDUSTRIES = Object.freeze({
    're-media': Object.freeze({ since: '2026-10-27', reason: 'Paul: stop targeting real estate media / REP agencies' }),
});
const AGENCY = 'staffify-agency-outreach';   // a record with no campaign id is the original agency list
export const campaignPaused = row => !!PAUSED_CAMPAIGNS[(row && row.campaignId) || AGENCY];
/** Out of the unworked call pool: a paused campaign, or a card whose industry is paused. */
export const poolPaused = row => campaignPaused(row) || !!(row && row.industry && PAUSED_INDUSTRIES[row.industry.key]);
