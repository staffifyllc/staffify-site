import {site} from './_outreach-supply.js';
import {redis,requireAccess} from './_auth.js';
import {KEY,ownerFor,visibleState,canUseCallQueue} from './_outreach-queue.js';
import {contact,draftBlockReason} from './_outreach-crm.js';
import {IG_KEY,instagramPanel} from './_instagram-research.js';
import {config,access,history,compactMessage} from './_outreach-gmail.js';
import {classify,callReady} from './_outreach-policy.js';
import {callScript} from './_call-scripts.js';
import {industryFor} from './_industry.js';
import {resolveTimezone} from './_outreach-timezone.js';
import {knownIdentity,TRIED_KEY} from './_contact-identity.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
 // Hoisted so the catch below can still answer with what we hold. A thrown error used to return a
 // bare message, which is the blank card all over again: on 2026-10-20 HubSpot rate limited and
 // EVERY prospect in the queue rendered "Call check unavailable" with nothing behind it.
 let state=null,row=null,stored=async()=>({callable:false});
 try{
  const t0=Date.now(),timings={};const mark=k=>{timings[k]=Date.now()-t0;};
  const rep=await requireAccess(req);const owner=canUseCallQueue(rep)?'all':null;const caller=rep?.role==='admin'?'[your name]':rep?.name||'[your name]';if(!owner)return res.status(401).json({error:'Sign in to the Hub'});
  state=await redis.get(KEY);row=visibleState(state,owner).records.find(r=>r.id===req.query.id);mark('state');
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
  const block=await draftBlockReason(row);if(block)return reject('Do not call: '+block);mark('block');
  const accounts=(await config()).accounts.filter(a=>a.brand==='Staffify'&&a.draftEnabled);
  if(!accounts.some(a=>a.email===row.sender))throw Error('Sending mailbox is not active');
  // Each mailbox is read on its own. This used to be one Promise.all, so a single expired token
  // rejected the lot and every prospect in the queue showed "Call check unavailable", even though
  // only one mailbox was dead. Paul, 2026-10-20.
  // The CRM lookup does not depend on the Gmail reads, so it runs alongside them rather than after.
  // On a 2.1-second card that was ~300ms spent waiting for nothing.
  const crmPromise=contact(row.recipient);
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
  // Freshness. This re-read the whole state (7.9 MB) to learn one thing. Every writer bumps
  // revision and revision is the first key in the stored JSON, so the first bytes say whether
  // anything changed since the read above; only a changed or unreadable head costs the full read.
  mark('gmail');
  const head=await redis.getrange(KEY,0,48).catch(()=>null);const rev=typeof head==='string'&&/^\{"revision":(\d+)/.exec(head);
  if(!(rev&&Number(rev[1])===Number(state?.revision))){const latest=await redis.get(KEY);if(!visibleState(latest,owner).records.find(r=>r.id===row.id)?.callReady)throw Error('Queue changed; refresh before calling');}
  mark('freshness');
  await redis.del('staffify:call-block:'+row.id);
  // One lookup, reused. This used to fetch the same contact a second time just to build the
  // CRM link whenever hubspotId was absent, doubling the cost of every such card.
  const crmContact=await crmPromise;const p={...crmContact.properties};const contactId=crmContact.id;mark('crm');
  // A name the research pass found fills in for a blank CRM name. The CRM is patched by that pass
  // too, so this is only the window between a lookup and HubSpot catching up, plus provenance.
  let identity={status:p.firstname?'crm':'unknown'};
  if(!p.firstname){const known=await knownIdentity(redis,row.recipient);
   if(known){p.firstname=known.firstName;p.lastname=p.lastname||known.lastName;p.jobtitle=p.jobtitle||known.title||'';identity={status:'researched',source:known.source,checkedAt:known.checkedAt};}
   else{const tried=await redis.get(TRIED_KEY(row.recipient)).catch(()=>null);identity={status:'unknown',reason:tried&&tried.at?('Looked up on '+(tried.source||'RocketReach')+' '+new Date(tried.at).toLocaleDateString('en-US')+': not found.'):'A lookup is queued.'};}}
  // Phone evidence is READ here, never fetched. This used to fetch up to three pages of the
  // prospect's website live on every first open, which was most of the 2.1 seconds a caller waited
  // per card. The background research pass does that check now and stores the result; a record it
  // has not reached yet shows its CRM number honestly as uncorroborated until it does.
  const crmPhoneRaw=String(p.phone||'').trim()||String(p.mobilephone||'').trim()||null;
  let phoneEvidence=await redis.get('staffify:call-phone-evidence:'+row.recipient).catch(()=>null);
  if(!phoneEvidence||typeof phoneEvidence!=='object'){
   phoneEvidence={phone:crmPhoneRaw,status:crmPhoneRaw?'needs_confirmation':'missing',checkedAt:null,sourceUrl:null,
    detail:crmPhoneRaw?'Not yet compared with their website. That check runs in the background.':'No phone number in CRM'};
  }
  // Paul, 2026-10-22: "our sales people shouldn't have to do this." The card used to hand over a
  // number ONLY when the CRM number was found printed on the prospect's own website, and otherwise
  // showed nothing plus "Research before calling". Meanwhile the direct dials already bought from
  // RocketReach sat unread. Same evidence, ranked and surfaced rather than discarded: the caller
  // always gets the best number we hold and one line saying how good it is.
  // The Instagram datapoint, read not computed. Paul: "I want our sales people to be armed."
  // The panel renders whatever state the research is in, and only hands over a question when the
  // evidence supports one.
  const igSector=industryFor({campaignId:row.campaignId,company:p.company||row.company,excerpt:row.source?.excerpt,crmIndustry:p.industry,title:p.jobtitle});
  const [igEvidence,igFlag]=await Promise.all([
   redis.get(IG_KEY(row.recipient)).catch(()=>null),
   redis.get('staffify:instagram-flag:'+row.recipient.toLowerCase()).catch(()=>null),
  ]);
  const instagram=instagramPanel({sector:igSector?.key,company:p.company||row.company,evidence:igEvidence,flagged:igFlag});
  const [vendorDial,sitePhone]=await Promise.all([
   redis.get('staffify:call-phone-vendor:'+row.recipient.toLowerCase()).catch(()=>null),
   redis.get('staffify:call-site-phone:'+row.recipient.toLowerCase()).catch(()=>null),
  ]);
  const crmPhone=String(p.phone||'').trim()||String(p.mobilephone||'').trim()||null;
  const dial=phoneEvidence.status==='business_listed'
   ?{number:phoneEvidence.phone,label:'Published on their own website',detail:phoneEvidence.detail,sourceUrl:phoneEvidence.sourceUrl||null,alternates:[]}
   :vendorDial&&vendorDial.phone
   ?{number:vendorDial.phone,label:'Direct dial'+(vendorDial.type?' ('+vendorDial.type+')':''),detail:'Direct dial from '+(vendorDial.source||'a contact data vendor')+'. Not carrier-verified.',sourceUrl:null,alternates:(vendorDial.alternates||[]).slice(0,3)}
   :sitePhone&&sitePhone.phone
   ?{number:sitePhone.phone,label:'Main line published on their website',detail:'Ask for them by name. This is the number the business publishes, not a personal line.',sourceUrl:sitePhone.sourceUrl||null,alternates:(sitePhone.alternates||[]).slice(0,3)}
   :crmPhone
   ?{number:crmPhone,label:'From the CRM, not corroborated',detail:'Came with the list and is not on their website, so expect a main line or a front desk. Ask for them by name.',sourceUrl:phoneEvidence.sourceUrl||null,alternates:[]}
   :null;
  const clockZone=(row.prospectTimezone&&row.prospectTimezone.timeZone)?row.prospectTimezone
   :(!String(p.country||'').trim()&&String(p.state||'').trim())?(z=>z.timeZone?{...z,source:'CRM state; country assumed US for the clock only'}:null)(resolveTimezone({...p,country:'US'})):null;
  return res.status(200).json({timings:(mark('done'),timings),prospectTimezone:clockZone,identity,title:p.jobtitle||null,callable:true,checkedAt:new Date().toISOString(),owner:row.owner,callerName:caller,callQueue:'shared',website:p.website||row.website||row.source?.url||null,unreadableMailboxes:unreadable,
   industry:industryFor({campaignId:row.campaignId,company:p.company||row.company,excerpt:row.source?.excerpt,crmIndustry:p.industry,title:p.jobtitle}),
   staleVerification:senderUnreadable?{mailbox:row.sender,syncedAt:state?.queueUpdatedAt||state?.updatedAt||null,sentTouches:row.verifiedSentTouches||row.sentTouches||0}:null,name:[p.firstname,p.lastname].filter(Boolean).join(' ')||row.recipient,phone:dial&&dial.number||null,dial,phoneEvidence,location:[p.city,p.state,p.country].filter(Boolean).join(', ')||null,company:p.company||row.company,crmUrl:'https://app.hubspot.com/contacts/51666712/record/0-1/'+(row.hubspotId||row.crmContactId||contactId||''),fact:row.roleContext?('Research context: prior resume-reported work included '+row.roleContext+'. This is historical evidence, not a current vacancy. Ask about today’s workflow; do not mention applicant identities.'):row.source?.excerpt||null,source:row.source||null,...callScript({campaignId:row.campaignId,caller,callerEmail:rep?.email,company:p.company||row.company||'your business',firstName:p.firstname,website:p.website||row.website||row.source?.url||'',excerpt:row.source?.excerpt||'',crmIndustry:p.industry||'',title:p.jobtitle||'',igBranch:instagram&&instagram.branch}),instagram,events:all.filter(m=>!m.draft).sort((a,b)=>a.date-b.date).map(m=>({kind:m.sent?'sent':'received',at:new Date(m.date).toISOString(),subject:m.subject,body:m.text,mailbox:m.mailbox})),instruction:'Read the actual emails below before calling. Ask about their situation; do not assume interest. Record the result and a dated next step. Any request to stop must use Exclude from outreach.'});
 }catch(e){
  // Degrade, do not go blank. The research, the website and the email trail live on the queue
  // record and owe nothing to whichever system just failed.
  const detail='Call check unavailable. Do not call yet. '+String((e&&e.message)||e);
  if(!row)return res.status(503).json({error:detail});
  try{return res.status(503).json({error:detail,...await stored()});}
  catch{return res.status(503).json({error:detail});}
 }
}
