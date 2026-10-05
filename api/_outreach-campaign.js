// Existing untagged records belong to the original initiative, never a new campaign.
export const CAMPAIGN_ID='staffify-agency-outreach';
export const CAMPAIGN={id:CAMPAIGN_ID,name:'Staffify agency outreach',description:'Existing agency prospects: four emails, then a human call.',sendWindow:'Weekdays, 9 AM–9 PM America/New_York',maxEmails:4,minimumSpacingHours:48,calling:'Human callers only'};
export const campaignId=row=>row.campaignId||CAMPAIGN_ID;
export const inCampaign=row=>campaignId(row)===CAMPAIGN_ID;
export function tagCampaign(state){return {...state,campaigns:[CAMPAIGN,...(state.campaigns||[]).filter(c=>c.id!==CAMPAIGN_ID)],records:state.records.map(r=>({...r,campaignId:campaignId(r)}))};}
