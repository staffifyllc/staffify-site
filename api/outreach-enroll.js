// Import previously sent, explicitly authorized Tobit threads. Never send from this endpoint.
import {redis,adminAuthorized,readBody} from './_auth.js';
import {KEY} from './_outreach-queue.js';
import {config,access,history,compactMessage} from './_outreach-gmail.js';
import {classify,reconcileThread} from './_outreach-policy.js';
import {draftBlockReason} from './_outreach-crm.js';
import {verificationGate} from './_outreach-verification.js';
import {TOBIT_ID} from './_tobit-campaign.js';
import {hubspotRequest} from './_outreach-hubspot.js';
const CAS=`local s=redis.call('GET',KEYS[1]);if not s or cjson.decode(s).revision~=tonumber(ARGV[1]) then return 0 end;redis.call('SET',KEYS[1],ARGV[2]);return 1`;
async function hs(path,body,method){const r=await hubspotRequest('https://api.hubapi.com'+path,{method:method||(body?'POST':'GET'),headers:{Authorization:'Bearer '+process.env.HUBSPOT_TOKEN,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined},{redis});if(!r.ok)throw Error('CRM request failed: '+r.status);return r.json();}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(!adminAuthorized(req))return res.status(401).json({error:'Unauthorized'});
 if(req.method!=='POST')return res.status(405).json({error:'POST required'});
 try{
 const b=readBody(req),recipient=String(b.recipient||'').trim().toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)||!b.initialMessageId||!b.company||!b.followupBodies||![2,3,4].every(n=>typeof b.followupBodies[n]==='string'&&b.followupBodies[n].length>80&&b.followupBodies[n].length<5000))return res.status(400).json({error:'Complete recipient, original sent message and follow-up copy required'});
 const cfg=await config(),accounts=cfg.accounts.filter(a=>a.brand==='Staffify'&&a.draftEnabled);
 const sender='paul@trystaffify.com';if(!accounts.some(a=>a.email===sender&&a.owner==='Paul'))throw Error('Authorized sender unavailable');
 let state=await redis.get(KEY);if(!state)throw Error('Queue unavailable');
 const previous=state.records.find(r=>r.recipient===recipient);
 if(previous)return res.json({status:'already_tracked',id:previous.id,campaignId:previous.campaignId,recordStatus:previous.status});
 const messages=(await Promise.all(accounts.map(async a=>(await history(await access(a.email),recipient)).map(m=>compactMessage(m,a.email))))).flat();
 const initial=messages.find(m=>m.id===b.initialMessageId&&m.mailbox===sender&&m.sent&&m.to.includes(recipient));
 if(!initial)return res.status(409).json({error:'Original sent message not verified'});
 const verdict=classify(messages,recipient,accounts.map(a=>a.email));
 let reason=verdict.status||(messages.some(m=>m.draft)?'existing_draft_hold':null)||(verdict.sent.some(m=>m.mailbox!==sender||m.threadId!==initial.threadId)?'cross_account_history_hold':null);
 const row={id:'tobit-'+b.initialMessageId,campaignId:TOBIT_ID,lane:'tobit_business',owner:'Paul',sender,recipient,company:String(b.company),verifiedFirstName:String(b.firstName||''),subject:initial.subject,threadId:initial.threadId,status:'sent',sentTouches:0,followupBodies:b.followupBodies,source:{label:'Sourcing Tracker - Tobit.xlsx',url:typeof b.sourceUrl==='string'&&/^https:\/\//.test(b.sourceUrl)?b.sourceUrl:null},enrolledAt:new Date().toISOString()};
 reconcileThread(row,messages.filter(m=>m.mailbox===sender&&m.threadId===initial.threadId));
 if(reason)row.status=reason;
 if(!reason){
  if(!await verificationGate(row,redis)){reason='email_verification_hold';row.holdError='Address verification: '+row.emailVerification.status;}
  else{
   const account=await hs('/account-info/v3/details');if(String(account.portalId)!=='51666712')throw Error('Wrong CRM portal');
   const found=await hs('/crm/v3/objects/contacts/search',{filterGroups:[{filters:[{propertyName:'email',operator:'EQ',value:recipient}]}],properties:['email'],limit:2});
   if(found.results.length>1)throw Error('Ambiguous CRM contact');
   if(!found.results.length){const c=await hs('/crm/v3/objects/contacts',{properties:{email:recipient,firstname:row.verifiedFirstName,company:row.company,lifecyclestage:'lead',rep_email_verified:'verified'}});row.crmContactId=c.id;}
   else {row.crmContactId=found.results[0].id;await hs('/crm/v3/objects/contacts/'+row.crmContactId,{properties:{rep_email_verified:'verified'}},'PATCH');}
   const block=await draftBlockReason(row);if(block){reason='crm_hold';row.holdError=block;}
  }
 }
 if(reason)row.status=reason;
 // CAS append only: preserve live worker writes and all authoritative controls.
 for(let attempt=0;attempt<8;attempt++){
  state=await redis.get(KEY);const duplicate=state.records.find(r=>r.recipient===recipient);if(duplicate)return res.json({status:'already_tracked',id:duplicate.id});
  if(state.suppressions.includes(recipient))row.status='suppressed';
  if(state.assignments.some(a=>a.email===recipient&&a.owner!=='Paul'))row.status='ownership_hold';
  if(state.pausedOwners.includes('Paul'))row.status='owner_paused_hold';
  const next={...state,revision:state.revision+1,records:[...state.records,row],queueUpdatedAt:new Date().toISOString()};
  if(Number(await redis.eval(CAS,[KEY],[String(state.revision),JSON.stringify(next)]))===1)return res.json({status:'enrolled',id:row.id,recordStatus:row.status,sentTouches:row.sentTouches,nextEligibleAt:row.nextEligibleAt,holdReason:row.holdError||null});
 }
 return res.status(409).json({error:'Queue changed; safe to retry enrollment'});
 }catch(e){return res.status(503).json({error:String(e.message).slice(0,180)});}
}
