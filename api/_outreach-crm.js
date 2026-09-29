import {automatedModeAllowed} from './_outreach-policy.js';
import {isOptedOut,optOut} from './_optout.js';
import {clientCheck} from './_client-guard.js';
const properties=['email','firstname','lastname','lifecyclestage','rep_lifecycle_state','rep_terminal_state','rep_last_reply_at','rep_email_verified','rep_outreach_mode','hs_email_optout','do_not_contact'];
async function hs(path,body,method){const token=process.env.HUBSPOT_TOKEN;if(!token)throw Error('CRM connection missing');const r=await fetch('https://api.hubapi.com'+path,{method:method||(body?'POST':'GET'),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('CRM unavailable: '+r.status);return r.status===204?{}:r.json();}
export async function contact(email){const account=await hs('/account-info/v3/details');if(String(account.portalId)!=='51666712')throw Error('Wrong CRM portal');const found=await hs('/crm/v3/objects/contacts/search',{filterGroups:[{filters:[{propertyName:'email',operator:'EQ',value:email}]}],properties,limit:2});if(found.results.length!==1)throw Error('CRM contact missing or ambiguous');return found.results[0];}
export async function draftBlockReason(row){
 if(await isOptedOut({email:row.recipient}))return 'Global opt-out';
 const c=await contact(row.recipient),p=c.properties;const name=(p.firstname+' '+p.lastname).toLowerCase();
 if(['trey tatro','mike haymes','blake watkins'].some(n=>name.includes(n)))return 'Explicit exclusion';
 if(p.rep_email_verified!=='verified')return 'Email verification: '+(p.rep_email_verified||'missing');
 if(p.rep_last_reply_at)return 'CRM records a reply';
 if(p.rep_terminal_state)return 'CRM terminal state: '+p.rep_terminal_state;
 if(!automatedModeAllowed(p.rep_outreach_mode))return 'CRM outreach mode: '+p.rep_outreach_mode;
 if(['customer','opportunity'].includes(p.lifecyclestage))return 'CRM lifecycle: '+p.lifecyclestage;
 if(['DNC','HUMAN_OWNED','NOT_INTERESTED'].includes(p.rep_lifecycle_state))return 'CRM outreach lifecycle: '+p.rep_lifecycle_state;
 if(p.hs_email_optout==='true'||p.do_not_contact==='true')return 'CRM opt-out';
 const client=await clientCheck({email:row.recipient,company:row.company});return client.status==='clear'?null:'Client check: '+client.status;
}
export async function canDraft(row){return !await draftBlockReason(row);}

export async function suppress(row,reason){const result=await optOut({email:row.recipient,reason,source:'hosted-outreach',text:reason});if(!result.ok)throw Error('Global suppression write failed');const c=await contact(row.recipient);await hs('/crm/v3/objects/contacts/'+c.id,{properties:{rep_in_campaign:'false',rep_terminal_state:'DNC',rep_lifecycle_state:'DNC'}},'PATCH');}
