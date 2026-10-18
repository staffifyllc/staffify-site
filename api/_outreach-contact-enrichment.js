// Contact research is separate from campaign enrollment and call eligibility.
export const ENRICHMENT_KEY='staffify:outreach:contact-enrichment:v1';
export function contactResearch(row,doc){
 const e=doc?.records?.[row.id];
 return e&&e.campaignId===row.campaignId&&e.recipient?.toLowerCase()===row.recipient?.toLowerCase()?e:null;
}
export function researchedPhone(e,now=Date.now()){
 const p=e?.phone;
 if(e?.provider!=='RocketReach'||!e.identityMatched||!p||p.grade!=='A'||p.validity!=='valid'||!/^\+[1-9]\d{7,14}$/.test(p.e164||'')||!p.last_checked||!Number.isFinite(Date.parse(p.last_checked))||now-Date.parse(p.last_checked)>120*86400000)return null;
 return {phone:p.e164,status:'provider_matched',checkedAt:e.retrievedAt,providerCheckedAt:p.last_checked,sourceUrl:e.linkedinUrl,detail:'RocketReach grade A: valid number with a strong identity match. '+p.type+'; provider checked '+String(p.last_checked).slice(0,10)+'. Not independently dial-tested; line activity and who answers are not guaranteed.'};
}
