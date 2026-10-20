import {checkBusinessPhone} from './_outreach-phone-evidence.js';
import {site} from './_outreach-supply.js';
import {redis,requireAccess} from './_auth.js';
import {KEY,ownerFor,visibleState,canUseCallQueue} from './_outreach-queue.js';
import {contact,draftBlockReason} from './_outreach-crm.js';
import {config,access,history,compactMessage} from './_outreach-gmail.js';
import {classify,callReady} from './_outreach-policy.js';
import {callScript} from './_call-scripts.js';
import {industryFor} from './_industry.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
 // Hoisted so the catch below can still answer with what we hold. A thrown error used to return a
 // bare message, which is the blank card all over again: on 2026-10-20 HubSpot rate limited and
 // EVERY prospect in the queue rendered "Call check unavailable" with nothing behind it.
 let state=null,row=null,stored=async()=>({callable:false});
 try{
  const rep=await requireAccess(req);const owner=canUseCallQueue(rep)?'all':null;const caller=rep?.role==='admin'?'[your name]':rep?.name||'[your name]';if(!owner)return res.status(401).json({error:'Sign in to the Hub'});
  state=await redis.get(KEY);row=visibleState(state,owner).records.find(r=>r.id===req.query.id);
  if(!row)return res.status(404).json({error:'Record not available'});
  // What we already know about this prospect, from the last worker sync. Shown even when the live
 // check refuses the call, because a caller still needs to see the proof, the site and the emails
 // rather than a bare error. callable:false means the outcome buttons stay off.
 // The CRM is a different system from the mailbox. An expired Gmail token says nothing about
 // HubSpot, so a blocked prospect still gets their website, company, location and number rather
 // than an empty card. Fetched on its own and wrapped, because a CRM outage must not take the
 // fallback down too: a card with the email trail still beats a card with nothing.
 stored=async()=>{
   let p={},crmId=null;
   try{const c=await contact(row.recipient);p=c?.properties||{};crmId=c?.id||null;}catch{/* CRM unavailable; stored evidence still renders */}
   return {callable:false,
     company:p.company||row.company||row.recipient,recipient:row.recipient,
     name:[p.firstname,p.lastname].filter(Boolean).join(' ')||null,
     location:[p.city,p.state,p.country].filter(Boolean).join(', ')||null,
     // Shown as a detail, never as a dial button: this prospect is not callable yet.
     crmPhone:p.phone||p.mobilephone||null,
     crmUrl:(row.hubspotId||crmId)?'https://app.hubspot.com/contacts/51666712/record/0-1/'+(row.hubspotId||crmId):null,
     website:p.website||row.website||row.source?.url||null,source:row.source||null,
     industry:industryFor({campaignId:row.campaignId,company:p.company||row.company,excerpt:row.source?.excerpt,crmIndustry:p.industry,title:p.jobtitle}),
     sentTouches:row.sentTouches,lastSentAt:row.lastSentAt||null,
     events:(row.events||[]).filter(e=>e.kind!=='draft').map(e=>({kind:e.kind,at:e.at,subject:e.subject,body:e.body,mailbox:e.from||row.sender})),
     callHistory:row.callHistory||[],syncedAt:state?.queueUpdatedAt||state?.updatedAt||null};
 };
 const reject=async error=>{await redis.set('staffify:call-block:'+row.id,{error,lastSentAt:row.lastSentAt,checkedAt:new Date().toISOString()},{ex:86400});return res.status(409).json({error,...await stored()});};
  if(!row.callReady)return reject('This prospect is not due for an unanswered-email call');
  const block=await draftBlockReason(row);if(block)return reject('Do not call: '+block);
  const accounts=(await config()).accounts.filter(a=>a.brand==='Staffify'&&a.draftEnabled);
  if(!accounts.some(a=>a.email===row.sender))throw Error('Sending mailbox is not active');
  // Each mailbox is read on its own. This used to be one Promise.all, so a single expired token
  // rejected the lot and every prospect in the queue showed "Call check unavailable", even though
  // only one mailbox was dead. Paul, 2026-10-20.
  const reads=await Promise.all(accounts.map(async a=>{
    try{return {email:a.email,ok:true,messages:(await history(await access(a.email),row.recipient)).map(m=>compactMessage(m,a.email))};}
    catch(e){return {email:a.email,ok:false,messages:[],error:String((e&&e.message)||e)};}
  }));
  const unreadable=reads.filter(r=>!r.ok).map(r=>r.email);
  // The prospect's OWN sender is where the four sent emails and the reply window are proven, so
  // without it there is no evidence and the block stands. Another mailbox being unreadable only
  // weakens the cross-mailbox reply check, which is reported rather than hidden.
  // Paul, 2026-10-20: that mailbox became Milton's and is being rewired, "we can still go
  // through". So an unreadable SENDER no longer blocks the call. What it costs is stated on the
  // card rather than hidden: the four-email proof falls back to the verification the worker
  // stored while the mailbox was still readable, and a reply sent TO that mailbox since then
  // cannot be seen by anyone, the worker included. Every other check is untouched: the six
  // readable mailboxes are still swept for replies, and suppressions, opt-outs and client
  // exclusions live in the queue state and the CRM, not in Gmail.
  const senderUnreadable=unreadable.includes(row.sender);
  const all=reads.flatMap(r=>r.messages);
  const verdict=classify(all,row.recipient,accounts.map(a=>a.email));
  if(verdict.status)return reject('Do not call from this queue: '+verdict.status+'. A human must review the conversation.');
  const sent=all.filter(m=>m.mailbox===row.sender&&m.sent&&m.to.includes(row.recipient));
  // With the sender readable this re-proves the four emails live. Without it, the stored
  // verifiedSentTouches from the last good sync is the evidence, and callReady still has to pass
  // on it: an unreadable mailbox lowers confidence, it does not waive the rule.
  if(!callReady(senderUnreadable?row:{...row,verifiedSentTouches:sent.length,lastSentAt:sent.length?new Date(Math.max(...sent.map(m=>m.date))).toISOString():null}))
   throw Error(senderUnreadable?'The stored four-email verification for this prospect is incomplete':'Four sent emails and the reply window could not be verified');
  const latest=await redis.get(KEY);if(!visibleState(latest,owner).records.find(r=>r.id===row.id)?.callReady)throw Error('Queue changed; refresh before calling');
  await redis.del('staffify:call-block:'+row.id);
  // One lookup, reused. This used to fetch the same contact a second time just to build the
  // CRM link whenever hubspotId was absent, doubling the cost of every such card.
  const crmContact=await contact(row.recipient);const p=crmContact.properties;const contactId=crmContact.id;
  const phoneEvidence=await checkBusinessPhone({phone:p.phone||p.mobilephone,website:p.website,fetchSite:site});
  await redis.set('staffify:call-phone-evidence:'+row.recipient,phoneEvidence,{ex:86400});
  return res.status(200).json({callable:true,checkedAt:new Date().toISOString(),owner:row.owner,callerName:caller,callQueue:'shared',website:p.website||row.website||row.source?.url||null,unreadableMailboxes:unreadable,
   industry:industryFor({campaignId:row.campaignId,company:p.company||row.company,excerpt:row.source?.excerpt,crmIndustry:p.industry,title:p.jobtitle}),
   staleVerification:senderUnreadable?{mailbox:row.sender,syncedAt:state?.queueUpdatedAt||state?.updatedAt||null,sentTouches:row.verifiedSentTouches||row.sentTouches||0}:null,name:[p.firstname,p.lastname].filter(Boolean).join(' ')||row.recipient,phone:phoneEvidence.status==='business_listed'?phoneEvidence.phone:null,phoneEvidence,location:[p.city,p.state,p.country].filter(Boolean).join(', ')||null,company:p.company||row.company,crmUrl:'https://app.hubspot.com/contacts/51666712/record/0-1/'+(row.hubspotId||row.crmContactId||contactId||''),fact:row.roleContext?('Research context: prior resume-reported work included '+row.roleContext+'. This is historical evidence, not a current vacancy. Ask about today’s workflow; do not mention applicant identities.'):row.source?.excerpt||null,source:row.source||null,...callScript({campaignId:row.campaignId,caller,company:p.company||row.company||'your business',firstName:p.firstname}),events:all.filter(m=>!m.draft).sort((a,b)=>a.date-b.date).map(m=>({kind:m.sent?'sent':'received',at:new Date(m.date).toISOString(),subject:m.subject,body:m.text,mailbox:m.mailbox})),instruction:'Read the actual emails below before calling. Ask about their situation; do not assume interest. Record the result and a dated next step. Any request to stop must use Exclude from outreach.'});
 }catch(e){
  // Degrade, do not go blank. The research, the website and the email trail live on the queue
  // record and owe nothing to whichever system just failed.
  const detail='Call check unavailable. Do not call yet. '+String((e&&e.message)||e);
  if(!row)return res.status(503).json({error:detail});
  try{return res.status(503).json({error:detail,...await stored()});}
  catch{return res.status(503).json({error:detail});}
 }
}
