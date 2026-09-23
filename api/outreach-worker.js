import {randomUUID} from 'node:crypto';
import {redis} from './_auth.js';
import {KEY} from './_outreach-queue.js';
import {config,access,gmail,history,headers,messageText,mime} from './_outreach-gmail.js';
import {supply} from './_outreach-supply.js';
import {canDraft,suppress} from './_outreach-crm.js';
import {eligible,quota,dayKey,classify,followup} from './_outreach-policy.js';
const LOCK='outreach:cloud:lock';
const CAS=`local s=redis.call('GET',KEYS[1]); if not s or cjson.decode(s).revision~=tonumber(ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1`;
async function save(state){const rev=state.revision;const next={...state,revision:rev+1,updatedAt:new Date().toISOString()};if(Number(await redis.eval(CAS,[KEY],[String(rev),JSON.stringify(next)]))!==1)throw Error('Concurrent control change; retry next tick');return next;}
function addresses(s){return (String(s||'').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)||[]);}
export default async function handler(req,res){res.setHeader('Cache-Control','no-store');if(!process.env.CRON_SECRET||req.headers.authorization!==`Bearer ${process.env.CRON_SECRET}`)return res.status(401).json({error:'Unauthorized'});
 const nonce=randomUUID();if(!await redis.set(LOCK,nonce,{nx:true,ex:180}))return res.status(200).json({status:'already_running'});
 const started=Date.now();let report={startedAt:new Date().toISOString(),created:0,checked:0,status:'blocked'};
 try{
  const cfg=await config();if(!cfg.enabled){report.reason='Hosted worker not enabled; mailbox authorization required';return res.status(200).json(report);}
  if(cfg.accounts.length!==cfg.expectedAccounts)throw Error('Mailbox inventory incomplete');
  const tokens={};for(const a of cfg.accounts)tokens[a.email]=await access(a.email);
  let state=await redis.get(KEY);if(!state)throw Error('Shared queue not initialized');
  const senders=cfg.accounts.map(a=>a.email);state.creations ||=state.records.filter(r=>r.draftId&&r.createdAt).map(r=>({id:r.id+':import',day:r.createdAt.slice(0,10),sender:r.sender,owner:r.owner,touch:r.sentTouches?Math.max(1,r.sentTouches):1}));
  // Incremental inbound scan. One account each tick; pagination resumes before watermark advances.
  const index=Number(await redis.get('outreach:cloud:inbox-index')||0)%cfg.accounts.length;const account=cfg.accounts[index];
  const cursor=await redis.get('outreach:cloud:inbox:'+account.email)||{after:Math.floor((Date.now()-48*3600000)/1000)};
  const scanUntil=cursor.until||Math.floor(Date.now()/1000);const query='in:anywhere -in:sent -in:drafts after:'+Math.max(0,cursor.after-300);
  const list=await gmail(tokens[account.email],'messages?'+new URLSearchParams({q:query,maxResults:'20',...(cursor.page?{pageToken:cursor.page}:{})}));
  for(const item of list.messages||[]){const m=await gmail(tokens[account.email],'messages/'+item.id+'?format=full');const h=headers(m);const from=addresses(h.from)[0];const body=messageText(m);const affected=state.records.filter(r=>r.recipient===from||(/mailer-daemon|postmaster/i.test(h.from||'')&&body.includes(r.recipient)));
   for(const row of affected){row.status=/\b(stop|unsubscribe|remove me|do not contact|not interested|no thanks)\b/i.test(body)?'suppressed':/mailer-daemon|postmaster/i.test(h.from||'')?'bounce_hold':'human_reply_hold';row.replyMessageId=m.id;row.replyReceivedAt=new Date(Number(m.internalDate)).toISOString();if(row.status==='suppressed'&&!state.suppressions.includes(row.recipient))state.suppressions.push(row.recipient);}
  }
  state=await save(state);
  await redis.set('outreach:cloud:inbox:'+account.email,list.nextPageToken?{...cursor,page:list.nextPageToken,until:scanUntil}:{after:scanUntil});
  if(!list.nextPageToken)await redis.set('outreach:cloud:inbox-index',(index+1)%cfg.accounts.length);
  for(const row of state.records.filter(r=>r.status==='suppressed'&&!r.globalSuppressionSynced)){if(Date.now()-started>40000)break;await suppress(row,'Email opt-out recorded by hosted outreach worker');row.globalSuppressionSynced=true;state=await save(state);}
  // Reconcile held drafts before making more. No delete or send endpoint is used.
  for(const row of state.records.filter(r=>r.draftId&&['suppressed','human_reply_hold','bounce_hold','reserved_for_madison_external'].includes(r.status)&&!r.cloudHeld)){
   if(Date.now()-started>40000)break;
   if(!tokens[row.sender])continue;
   let draft;try{draft=await gmail(tokens[row.sender],'drafts/'+encodeURIComponent(row.draftId));}catch(e){row.holdError='Draft unavailable; reconcile manually';continue;}
   const raw=mime({sender:row.sender,to:'',subject:'DO NOT SEND - '+row.status,body:row.bodyText||'',id:'hold-'+row.id});
   await gmail(tokens[row.sender],'drafts/'+encodeURIComponent(row.draftId),{message:{raw,threadId:draft.message.threadId}},'PUT');row.cloudHeld=true;state=await save(state);
  }
  if(Date.now()-started>40000){report.status='reconciled';return res.status(200).json(report);}
  // Refresh one rotating existing thread, so manually sent drafts become sequence events.
  const tracked=state.records.filter(r=>r.threadId&&tokens[r.sender]&&['draft_saved','sent'].includes(r.status));const offset=Number(await redis.get('outreach:cloud:thread-index')||0);
  for(const row of tracked.slice(offset%Math.max(1,tracked.length),offset%Math.max(1,tracked.length)+3)){
   const thread=await gmail(tokens[row.sender],'threads/'+row.threadId+'?format=full');const sent=(thread.messages||[]).filter(m=>m.labelIds?.includes('SENT')&&addresses(headers(m).to).includes(row.recipient));const drafts=(thread.messages||[]).filter(m=>m.labelIds?.includes('DRAFT'));
   if(sent.length){const latest=sent.sort((a,b)=>Number(a.internalDate)-Number(b.internalDate)).at(-1);row.sentTouches=Math.max(row.sentTouches||0,sent.length);row.lastSentAt=new Date(Number(latest.internalDate)).toISOString();row.nextEligibleAt=new Date(Number(latest.internalDate)+48*3600000).toISOString();row.replyId=headers(latest)['message-id'];}
   if(!drafts.length)row.status=sent.length?'sent':'missing_draft_hold';report.checked++;
  }
  await redis.set('outreach:cloud:thread-index',offset+3);state=await save(state);
  const hour=Number(new Intl.DateTimeFormat('en-US',{hour:'numeric',hourCycle:'h23',timeZone:'America/New_York'}).format(new Date()));
  if(Date.now()-started<15000&&hour>=8&&state.records.filter(r=>r.status==='prepared').length<30){report.qualified=await supply(state,cfg);state=await save(state);}
  const candidates=state.records.filter(r=>eligible(r,state)&&(r.sentTouches>0||hour>=8)).sort((a,b)=>b.sentTouches-a.sentTouches);
  for(const row of candidates){
   if(Date.now()-started>40000||report.created>=2)break;
   if(!cfg.accounts.find(a=>a.email===row.sender)?.draftEnabled||!tokens[row.sender]||!quota(row,state.creations))continue;
   if(!await canDraft(row)){row.status='crm_hold';state=await save(state);continue;}
   const assignment=state.assignments.find(a=>a.email===row.recipient);if(assignment&&assignment.owner!==row.owner)continue;
   let messages=[];for(const sender of senders)for(const m of await history(tokens[sender],row.recipient)){const h=headers(m);messages.push({from:addresses(h.from)[0],to:addresses(h.to),sent:m.labelIds?.includes('SENT'),text:messageText(m),mailbox:sender,id:m.id,date:Number(m.internalDate),replyId:h['message-id'],threadId:m.threadId});}
   const verdict=classify(messages,row.recipient,senders);if(verdict.status){row.status=verdict.status;if(verdict.status==='suppressed')state.suppressions.push(row.recipient);state=await save(state);continue;}
   if(row.sentTouches===0&&messages.length){row.status='prior_contact_hold';state=await save(state);continue;}
   const actual=verdict.sent;if(actual.some(m=>m.mailbox!==row.sender)){row.status='cross_account_history_hold';state=await save(state);continue;}
   if(actual.length){const latest=actual.sort((a,b)=>a.date-b.date).at(-1);row.sentTouches=Math.max(row.sentTouches,actual.length);row.lastSentAt=new Date(latest.date).toISOString();row.replyId=latest.replyId;row.threadId=latest.threadId;if(!eligible({...row,status:'sent'},state))continue;}
   // Durable reservation precedes Gmail: an uncertain create is held, never blindly retried.
   const operation=row.id+':'+(row.sentTouches+1);if(await redis.get('outreach:cloud:operation:'+operation))continue;
   const fresh=await redis.get(KEY);if(fresh.revision!==state.revision)throw Error('Controls changed before draft creation');
   await redis.set('outreach:cloud:operation:'+operation,{status:'reserved',at:Date.now()},{nx:true});
   state.creations.push({id:operation,day:dayKey(Date.now()),owner:row.owner,sender:row.sender,touch:row.sentTouches+1});row.status='draft_creation_pending';state=await save(state);
   try{const body=row.sentTouches?followup(row):row.bodyText;const raw=mime({sender:row.sender,to:row.recipient,subject:row.sentTouches?'Re: '+String(row.subject||'Your agency workflow').replace(/^Re:\s*/i,''):row.subject,body,id:'staffify-'+operation.replace(/[^a-z0-9-]/gi,'-'),replyId:row.sentTouches?row.replyId:undefined});
    const draft=await gmail(tokens[row.sender],'drafts',{message:{raw,...(row.sentTouches?{threadId:row.threadId}:{})}});
    await redis.set('outreach:cloud:operation:'+operation,{status:'saved',draft,at:Date.now()});
    Object.assign(row,{draftId:draft.id,messageId:draft.message.id,threadId:draft.message.threadId,status:'draft_saved',bodyText:body,draftCreatedAt:new Date().toISOString()});state=await save(state);report.created++;
   }catch(e){await redis.set('outreach:cloud:operation:'+operation,{status:'uncertain',at:Date.now(),error:'Inspect Gmail before any retry'});throw e;}
  }
  report.status='complete';return res.status(200).json(report);
 }catch(e){report.status='error';report.reason=String(e.message).slice(0,180);return res.status(503).json(report);
 }finally{report.finishedAt=new Date().toISOString();await redis.set('outreach:cloud:last-run',report);await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",[LOCK],[nonce]);}
}
