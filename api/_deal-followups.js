import {site} from './_outreach-supply.js';
import {redis,listReps} from './_auth.js';
import {draftBlockReason} from './_outreach-crm.js';
import {history,compactMessage} from './_outreach-gmail.js';
import {classify} from './_outreach-policy.js';
import {DEAL_PIPELINE,DEAL_STAGES,dealBlock,dealEmail,historyBlock} from './_deal-followup-policy.js';
export const DEAL_QUEUE='staffify:deal-followups:v1';
async function hs(path,body){const r=await fetch('https://api.hubapi.com'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+process.env.HUBSPOT_TOKEN,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Deal CRM unavailable: '+r.status);return r.json();}
async function catalogue(previous){
 if(previous?.loadedAt&&Date.now()-Date.parse(previous.loadedAt)<15*60000)return previous;
 const account=await hs('/account-info/v3/details');if(String(account.portalId)!=='51666712')throw Error('Wrong CRM portal');
 let after,rows=[];do{const page=await hs('/crm/v3/objects/deals/search',{filterGroups:[{filters:[{propertyName:'pipeline',operator:'EQ',value:DEAL_PIPELINE},{propertyName:'dealstage',operator:'IN',values:Object.keys(DEAL_STAGES)}]}],properties:['dealname','pipeline','dealstage','hubspot_owner_id','closed_lost_reason','hs_next_activity_date'],limit:100,...(after?{after}:{})});rows.push(...page.results);after=page.paging?.next?.after;if(rows.length>2000)throw Error('Deal audit exceeded safe page limit');}while(after);
 return {loadedAt:new Date().toISOString(),cursor:previous?.cursor||0,rows:rows.map(d=>({...d,...previous?.rows?.find(x=>x.id===d.id),id:d.id,properties:d.properties,stage:DEAL_STAGES[d.properties.dealstage]}))};
}
export async function supplyDealFollowups(state,cfg,tokens){
 let queue=await catalogue(await redis.get(DEAL_QUEUE));const reps=await listReps();const now=new Date().toISOString();let added=0;
 const active=cfg.accounts.filter(a=>a.brand==='Staffify'&&a.draftEnabled);const senders=active.map(a=>a.email);
 for(let i=0;i<2&&queue.rows.length;i++){
  const item=queue.rows[queue.cursor++%queue.rows.length];item.checkedAt=now;item.reason=dealBlock(item.properties);item.status='held';if(item.reason)continue;
  try{
   const assoc=await hs('/crm/v4/objects/deals/'+item.id+'/associations/contacts?limit=100');if(assoc.paging?.next||assoc.results.length!==1){item.reason='A single primary contact must be confirmed';continue;}
   const cid=String(assoc.results[0].toObjectId),c=await hs('/crm/v3/objects/contacts/'+cid+'?properties=email,firstname,lastname,company,website,hubspot_owner_id');const p=c.properties,email=String(p.email||'').toLowerCase();item.recipient=email;
   if(!email){item.reason='Contact email is missing';continue;}
   const rep=reps.find(r=>String(r.hubspotOwnerId||'')===String(item.properties.hubspot_owner_id||p.hubspot_owner_id||'')&&r.hubspotOwnerId);
   const owner=rep&&(/madison/i.test(rep.email)?'Madison':/^(paul|hello)@/.test(rep.email)?'Paul':null);item.owner=owner;
   if(!owner){item.reason='Assign this opportunity to Paul or Madison';continue;}
   const existing=state.records.find(r=>r.recipient===email);if(existing){item.status='tracked';item.recordId=existing.id;item.reason='Existing outreach record: '+existing.status;continue;}
   if(state.assignments.some(a=>a.email===email&&a.owner!==owner)){item.reason='Reserved for a different owner';continue;}
   if(state.pausedOwners.includes(owner)||state.suppressions.includes(email)){item.reason='Owner paused or globally excluded';continue;}
   const mailboxes=active.filter(a=>a.owner===owner);if(!mailboxes.length){item.reason='No authorized sender for this owner';continue;}
   const row={id:'deal-'+item.id,hubspotId:cid,crmDealId:item.id,lane:'deal_followup',dealStage:item.stage,recipient:email,company:p.company||item.properties.dealname,owner,sender:mailboxes[0].email,sentTouches:0,status:'prepared',createdAt:now,qualificationApproved:true,subject:'A practical staffing handoff',verifiedFirstName:null};
   item.reason=await draftBlockReason(row);if(item.reason)continue;
   if(!p.website){item.reason='Agency website required to verify real estate media fit';continue;}
   const evidence=await site(p.website);if(!/real[ -]estate.{0,50}(photograph|videograph|media)|(?:property|architectural) photography/i.test(evidence.text)){item.reason='Website does not establish real estate media services';continue;}
   row.agencyKey=new URL(evidence.url).hostname.replace(/^www\./,'');if(state.records.some(r=>r.agencyKey===row.agencyKey||r.company&&r.company.toLowerCase()===row.company.toLowerCase())||state.assignments.some(a=>a.agencyKey===row.agencyKey&&a.email!==email)){item.reason='Company already assigned or in an outreach sequence';continue;}
   row.source={url:evidence.url,checkedAt:now};
   // No name guesses, no reset of prior send count, and no bypass of any historic reply or opt-out.
   const messages=(await Promise.all(senders.map(async sender=>(await history(tokens[sender],email)).map(m=>compactMessage(m,sender))))).flat();
   item.reason=historyBlock(messages,email,senders,classify);if(item.reason)continue;
   const sent=classify(messages,email,senders).sent.sort((a,b)=>a.date-b.date),last=sent.at(-1);
   if(last){if(!mailboxes.some(a=>a.email===last.mailbox)){item.reason='Conversation belongs to another owner';continue;}Object.assign(row,{sender:last.mailbox,status:'sent',sentTouches:sent.length,verifiedSentTouches:sent.length,lastSentAt:new Date(last.date).toISOString(),nextEligibleAt:new Date(last.date+48*3600000).toISOString(),threadId:last.threadId,replyId:last.replyId,subject:last.subject});}
   row.bodyText=dealEmail(row,sent.length);row.events=messages.filter(m=>!m.draft).map(m=>({id:m.id,kind:m.sent?'sent':'received',at:new Date(m.date).toISOString(),subject:m.subject,body:m.text,from:m.from,to:m.to}));
   state.records.push(row);if(!state.assignments.some(a=>a.email===email))state.assignments.push({hubspotId:cid,email,company:row.company,owner,reservedAt:now});
   item.status='enrolled';item.reason=null;item.recordId=row.id;added++;
  }catch(e){item.reason=String(e.message).slice(0,160);}
 }
 queue.updatedAt=now;await redis.set(DEAL_QUEUE,queue);return {added,reviewed:queue.rows.filter(r=>r.checkedAt).length,total:queue.rows.length};
}
