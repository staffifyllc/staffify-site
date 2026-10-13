// Website resource follow-ups. Cloud scheduled; no repeated promotional cycles.
import {randomUUID} from 'node:crypto';
import {redis,adminAuthorized} from './_auth.js';
import {config,access,gmail,history,compactMessage,mime,assertDraft} from './_outreach-gmail.js';
import {classify} from './_outreach-policy.js';
import {draftBlockReason} from './_outreach-crm.js';
import {clientCheck} from './_client-guard.js';
import {verificationGate} from './_outreach-verification.js';
import {isOptedOut,optOut} from './_optout.js';
import {KEY} from './_outreach-queue.js';
import {conversationEmail,nextConversationAt,isWebsiteSource,SENDER} from './_playbook-conversation.js';
import {slackNotify} from './_slack.js';
export default async function handler(req,res){
 if(!adminAuthorized(req))return res.status(401).json({error:'Unauthorized'});
 const dry=req.query?.dry==='1',lock=randomUUID(),report={dry,sent:0,checked:0,held:[],replies:0};
 if(!await redis.set('website:conversation:lock',lock,{nx:true,ex:300}))return res.json({status:'already_running'});
 try{
 if(dry&&req.query?.notify_test==='1')report.slackTest=await slackNotify('Staffify website signup alerts are connected. New resource signups will appear here with a link to their Hub record. This is an integration test, not a new signup.\nhttps://www.gostaffify.com/website-leads/');
 const cfg=await config(),state=await redis.get(KEY);if(!state)throw Error('Outreach controls unavailable');if(!dry&&(!cfg.enabled||cfg.sendingEnabled!==true))throw Error('Automatic outreach is paused');
 const accounts=cfg.accounts.filter(a=>a.brand==='Staffify'&&a.draftEnabled);
 if(!accounts.some(a=>a.email===SENDER))throw Error('Paul sender unavailable');
 // Include the original playbook reply inbox in reconciliation, even though it cannot send outreach.
 const senders=[...new Set(accounts.map(a=>a.email))];
 const tokens={};for(const email of senders)tokens[email]=await access(email);
 const ids=await redis.zrange('softyes:active',0,-1),candidates=[];
 for(const email of ids){const [sub,old,rec]=await Promise.all([redis.hgetall('subscriber:'+email),redis.hgetall('softyes:'+email),redis.get('website:conversation:'+email)]);if(!sub||!isWebsiteSource(sub.source)||!sub.playbook_sent_at)continue;candidates.push({email,sub,old,rec:rec||{events:[],enrolledAt:Number(old?.enrolled_at||sub.signed_up_at),sender:SENDER,status:'enrolled'}});}
 candidates.sort((a,b)=>(a.rec.checkedAt||0)-(b.rec.checkedAt||0));
 const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',hourCycle:'h23'}).format(new Date()));
 for(const {email,sub,old,rec} of candidates.slice(0,dry?25:2)){
 const key='website:conversation:'+email;report.checked++;
 if(!dry&&sub.signup_slack_status==='failed'&&await redis.set('website:signup-alert-retry:'+email,'1',{nx:true,ex:600})){const notice=await slackNotify('New Staffify website signup (retried alert)\n'+email+'\nhttps://www.gostaffify.com/website-leads/');await redis.hset('subscriber:'+email,{signup_slack_status:notice.ok?'sent':'failed',signup_slack_checked_at:Date.now()});}rec.checkedAt=Date.now();
 const save=()=>redis.set(key,rec);
 try{
  let stop=await isOptedOut({email})?'Global opt-out':state.suppressions?.includes(email)?'Global suppression':state.pausedOwners?.includes('Paul')?'Paul is paused':state.assignments?.some(a=>a.email===email&&a.owner!=='Paul')?'Assigned to another owner':sub.decision?'Decision recorded':old?.completed_at?'Previous sequence completed':old?.graduated_at?'Previously engaged':null;
  if(!stop&&state.records?.some(r=>r.recipient===email))stop='Already tracked in another outreach campaign';
  if(!stop&&(await redis.hget('nurture:'+email,'enrolled_at')||await redis.zscore('disposition:pending',email)))stop='Meeting or human-owned follow-up';
  if(/@(gostaffify|staffifyhq|trystaffify|hirestaffify|flylisted)\.com$/i.test(email))stop='Internal address';
  if(stop){rec.status='held';rec.reason=stop;await save();report.held.push({email,reason:stop});continue;}
  const monitored=[...senders];
  if(sub.playbook_reply_to!==SENDER){if(!tokens['hello@gostaffify.com'])tokens['hello@gostaffify.com']=await access('hello@gostaffify.com');monitored.push('hello@gostaffify.com');}
  const messages=(await Promise.all(monitored.map(async a=>(await history(tokens[a],email)).map(m=>compactMessage(m,a))))).flat();
  const verdict=classify(messages,email,senders);
  const incoming=messages.filter(m=>m.from===email);
  rec.replies=incoming.map(m=>({id:m.id,at:new Date(m.date).toISOString(),body:m.text,subject:m.subject,mailbox:m.mailbox,threadId:m.threadId}));
  if(verdict.status){rec.status=verdict.status;rec.reason='Mailbox reply or bounce stops automated follow-ups';if(verdict.status==='suppressed')await optOut({email,reason:'Website sequence opt-out reply',source:'website-conversation'});if(incoming.length)report.replies++;await save();continue;}
  // Recover sends whose response or ledger write failed. Never recreate an uncertain attempt.
  if(rec.attempt){const found=messages.find(m=>m.sent&&m.mailbox===SENDER&&(m.id===rec.attempt.messageId||m.replyId==='<'+rec.attempt.id+'@gostaffify.com>'));
   if(found){if(!rec.events.some(e=>e.id===found.id))rec.events.push({id:found.id,kind:'sent',at:new Date(found.date).toISOString(),subject:found.subject,body:found.text});rec.threadId=found.threadId;rec.replyId=found.replyId;delete rec.attempt;}
   else {rec.status='held';rec.reason='Uncertain send or saved draft: reconcile before retry';await save();continue;}}
  const known=new Set(rec.events.map(e=>e.id));
  if(messages.some(m=>m.draft||m.sent&&!known.has(m.id))){rec.status='held';rec.reason='Existing conversation or draft requires review';await save();continue;}
  const row={recipient:email,owner:'Paul',company:sub.company||''};
  try{stop=await draftBlockReason(row,{requireVerified:false});}catch(e){if(e.message==='CRM contact missing'){const check=await clientCheck({email,company:row.company});stop=check.status==='clear'?null:'Client check: '+check.status;}else throw e;}
  if(stop){rec.status='held';rec.reason=stop;await save();report.held.push({email,reason:stop});continue;}
  const client=await clientCheck({email,company:row.company});if(client.status!=='clear')throw Error('Client check: '+client.status);
  rec.nextAt=nextConversationAt(rec.enrolledAt,rec.events);rec.status=rec.nextAt?'scheduled':'complete';rec.reason='';
  await save();
  if(!rec.nextAt||Date.now()<rec.nextAt||hour<9||hour>=21||dry)continue;
  if(!await verificationGate(row,redis)){rec.status='held';rec.reason='Email verification: '+row.emailVerification.status;await save();continue;}
  // Re-read authoritative controls just before creating/sending.
  const fresh=await redis.get(KEY);if(fresh.pausedOwners?.includes('Paul')||fresh.suppressions?.includes(email)||await isOptedOut({email}))throw Error('Controls changed; send held');
  const touch=rec.events.filter(e=>e.kind==='sent').length+1,copy=conversationEmail(sub.first_name||'',touch),id=randomUUID();
  rec.attempt={id,at:Date.now(),touch};await save();
  const draft=assertDraft(await gmail(tokens[SENDER],'drafts',{message:{raw:mime({sender:SENDER,to:email,subject:copy.subject,body:copy.body,id,replyId:rec.replyId}),...(rec.threadId?{threadId:rec.threadId}:{})}}),email);
  rec.attempt.draftId=draft.id;rec.attempt.messageId=draft.message.id;await save();
  assertDraft(await gmail(tokens[SENDER],'drafts/'+draft.id),email);
  const sent=await gmail(tokens[SENDER],'drafts/send',{id:draft.id});
  const verified=compactMessage(await gmail(tokens[SENDER],'messages/'+sent.id+'?format=full'),SENDER);
  if(!verified.sent||!verified.to.includes(email))throw Error('Send receipt not verified');
  rec.events.push({id:verified.id,kind:'sent',at:new Date(verified.date).toISOString(),subject:verified.subject,body:verified.text});rec.threadId=verified.threadId;rec.replyId=verified.replyId;delete rec.attempt;rec.nextAt=nextConversationAt(rec.enrolledAt,rec.events);rec.status=rec.nextAt?'scheduled':'complete';await save();report.sent++;
 }catch(e){rec.status='held';rec.reason=String(e.message).slice(0,160);await save();report.held.push({email,reason:rec.reason});}
 }
 await redis.set('website:conversation:health',{...report,checkedAt:new Date().toISOString(),status:'checked'});
 return res.json(report);
 }catch(e){const error=String(e.message).slice(0,160);await redis.set('website:conversation:health',{status:'blocked',error,checkedAt:new Date().toISOString()});if(!dry&&await redis.set('website:conversation:alert:'+error,'1',{nx:true,ex:86400}))await slackNotify('Website playbook follow-ups need attention: '+error+'\nhttps://www.gostaffify.com/website-leads/');return res.status(503).json({error});}
 finally{await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",['website:conversation:lock'],[lock]);}
}
