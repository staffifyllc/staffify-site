import {createHash} from 'node:crypto';
export const INVENTORY='staffify:existing-inventory:v1';
export const emailKey=email=>createHash('sha256').update(email.toLowerCase()).digest('hex');
export function normalizeInventory(rows){
 const unique=new Map();
 for(const raw of rows){const email=String(raw.email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Invalid inventory email');
 const r={email};for(const key of ['company','domain','first','last','city','region','country','company_city','company_region','company_country','known_history','fit_review'])r[key]=String(raw[key]||'').slice(0,1500);
 const old=unique.get(email);if(old)r.known_history=[old.known_history,r.known_history].filter(Boolean).join(';');unique.set(email,r);}
 return [...unique.values()];
}
export function mergeInventory(existing,rows){const byEmail=new Map((existing?.records||[]).map(r=>[r.email,r]));for(const r of normalizeInventory(rows)){const old=byEmail.get(r.email);byEmail.set(r.email,old?{...r,...old,known_history:[old.known_history,r.known_history].filter(Boolean).join(';')}:r);}return {...existing,records:[...byEmail.values()],updatedAt:new Date().toISOString()};}
export function inventorySummary(inventory,now=Date.now()){const records=inventory?.records||[],outcomes={};for(const r of records){const k=r.result?.reason||'Not reviewed';outcomes[k]=(outcomes[k]||0)+1;}return {total:records.length,reviewed:records.filter(r=>r.result).length,pending:records.filter(r=>!r.result||r.nextAt&&Date.parse(r.nextAt)<=now).length,outcomes,updatedAt:inventory?.updatedAt||null};}
export function localBlock(item,state){
 if(state.suppressions.includes(item.email))return 'Global suppression';
 if(/excluded_or_terminal|prior_reply|crm_dnc|crm_not_interested|crm_human_owned|crm_mode_human_led|existing_opportunity|legacy_(?:unsubscribed|bounced|12step)|historic_campaign_send/.test(item.known_history||''))return 'Recovered exclusion or prior conversation';
 const row=state.records.find(r=>r.recipient===item.email),owner=state.assignments.find(a=>a.email===item.email)?.owner||row?.owner;
 if(owner&&state.pausedOwners.includes(owner))return 'Owner paused';
 if(row&&(!['prepared','draft_saved','awaiting_qualification','reserved_for_madison_external','mailbox_connection_required'].includes(row.status)||row.sentTouches||(row.events||[]).some(e=>e.kind==='sent')))return 'Existing sequence or protected hold';
 return null;
}
export function dueInventory(inventory,now=Date.now(),limit=60){return (inventory?.records||[]).filter(r=>!r.result||r.nextAt&&Date.parse(r.nextAt)<=now).sort((a,b)=>(!!a.result)-(!!b.result)||(/possible_media|existing_REP/.test(b.fit_review)?1:0)-(/possible_media|existing_REP/.test(a.fit_review)?1:0)).slice(0,limit);}
export function location(item){const personal=!!(item.country&&item.region);return {city:personal?item.city:item.company_city,state:personal?item.region:item.company_region,country:personal?item.country:item.company_country};}

export function supplyOwner({assigned,existing,crmOwnerId,reps=[],id}){if(assigned?.owner||existing?.owner)return assigned?.owner||existing.owner;if(crmOwnerId){const rep=reps.find(r=>String(r.hubspotOwnerId)===String(crmOwnerId));return rep&&/madison/i.test(rep.email)?'Madison':rep&&/^(paul|hello)@/.test(rep.email)?'Paul':null;}return Number(String(id).slice(-1))%2?'Madison':'Paul';}
