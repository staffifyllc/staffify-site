export const TOBIT_ID='staffify-tobit-outreach';
export const TOBIT_CAMPAIGN={id:TOBIT_ID,name:'Tobit business outreach',description:'Paul’s recruiter-sourced business contacts: four total emails, then a human call.',sendWindow:'Weekdays, 9 AM–9 PM America/New_York',maxEmails:4,minimumSpacingHours:48,calling:'Human callers only'};
export function tobitFollowup(row){
 const body=row.followupBodies?.[String(row.sentTouches+1)];
 if(!body)throw Error('Tobit follow-up copy missing; review required');
 return body;
}
