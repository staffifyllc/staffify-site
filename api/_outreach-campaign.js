import {TALENT_ID,TALENT_CAMPAIGN} from './_talent-network-campaign.js';
import {TOBIT_ID,TOBIT_CAMPAIGN} from './_tobit-campaign.js';
// Existing untagged records belong to the original initiative, never a new campaign.
export const CAMPAIGN_ID='staffify-agency-outreach';
export const CAMPAIGN={id:CAMPAIGN_ID,name:'Staffify agency outreach',description:'Existing agency prospects: four emails, then a human call.',sendWindow:'Weekdays, 9 AM–9 PM America/New_York',maxEmails:4,minimumSpacingHours:48,calling:'Human callers only'};
export const campaignId=row=>row.campaignId||CAMPAIGN_ID;
export const inCampaign=row=>[CAMPAIGN_ID,TOBIT_ID,TALENT_ID].includes(campaignId(row));
export function tagCampaign(state){return {...state,campaigns:[CAMPAIGN,...(state.records.some(r=>r.campaignId===TALENT_ID)?[TALENT_CAMPAIGN]:[]),...(state.records.some(r=>r.campaignId===TOBIT_ID)?[TOBIT_CAMPAIGN]:[]),...(state.campaigns||[]).filter(c=>![CAMPAIGN_ID,TOBIT_ID,TALENT_ID].includes(c.id))],records:state.records.map(r=>({...r,campaignId:campaignId(r)}))};}
