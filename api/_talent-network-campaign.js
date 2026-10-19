export const TALENT_ID='staffify-talent-network-outreach';
export const TALENT_CAMPAIGN={id:TALENT_ID,name:'Talent network outreach',description:'Resume-informed company research: four emails, then a human call. Unverified contacts remain held.',maxEmails:4,minimumSpacingHours:48,calling:'Human callers only',sendWindow:'Weekdays, 9 AM–9 PM America/New_York'};
export const campaignAllowed=(row,cfg)=>!Array.isArray(cfg.allowedCampaignIds)||cfg.allowedCampaignIds.includes(row.campaignId||'staffify-agency-outreach');
export function talentFollowup(row){const text=row.followupBodies?.[String(row.sentTouches+1)];if(!text)throw Error('Talent network follow-up missing');return text;}
