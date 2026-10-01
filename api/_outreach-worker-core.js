import {copyIssue} from './_outreach-copy.js';
import {fairCandidates} from './_outreach-fairness.js';
import {sendOne} from './_outreach-send.js';
export function makeWorker({dealSupply,maintain,redis,KEY,config,access,gmail,history,headers,messageText,mime,compactMessage,assertDraft,supply,canDraft,suppress,eligible,quota,dayKey,classify,followup,reconcileThread,callReady,randomUUID,cronSecret}){
const LOCK='outreach:cloud:lock';
const CAS=`local s=redis.call('GET',KEYS[1]); if not s or cjson.decode(s).revision~=tonumber(ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1`;
async function save(state){const rev=state.revision;const next={...state,revision:rev+1,queueUpdatedAt:new Date().toISOString()};if(Number(await redis.eval(CAS,[KEY],[String(rev),JSON.stringify(next)]))!==1)throw Error('Concurrent control change; retry next tick');return next;}
function addresses(s){return (String(s||'').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)||[]);}
return async function handler(req,res){res.setHeader('Cache-Control','no-store');if(!cronSecret()||req.headers.authorization!==`Bearer ${cronSecret()}`)return res.status(401).json({error:'Unauthorized'});
 const nonce=randomUUID();if(!await redis.set(LOCK,nonce,{nx:true,ex:360}))return res.status(200).json({status:'already_running'});
 const started=Date.now();let report={startedAt:new Date().toISOString(),trigger:String(req.headers['user-agent']||'').startsWith('vercel-cron')?'schedule':'manual',created:0,checked:0,status:'blocked'};
 async function finish(code){report.finishedAt=new Date().toISOString();try{await redis.set('outreach:cloud:last-run',report);}finally{await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",[LOCK],[nonce]);}return res.status(code).json(report);} 
 try{
  const cfg=await config();if(req.query?.validate==='1'){cfg.draftingEnabled=true;report.validation=true;}if(!cfg.enabled){report.reason='Hosted draft worker paused; enable after validation';return await finish(200);}
  if(maintain)report.clientSources=await maintain();
  cfg.accounts=cfg.accounts.filter(a=>a.brand==='Staffify'&&a.draftEnabled);
  if(!cfg.accounts.length)throw Error('No Staffify mailboxes enabled');
  const tokens={};const errors=[];await Promise.all(cfg.accounts.map(async a=>{try{tokens[a.email]=await access(a.email);}catch(e){errors.push({email:a.email,error:e.message});}}));
  await redis.set('outreach:cloud:health',{checkedAt:new Date().toISOString(),ok:!errors.length,accounts:cfg.accounts.map(a=>({email:a.email,ok:!!tokens[a.email],error:errors.find(e=>e.email===a.email)?.error}))});
  report.mailboxErrors=errors;report.mode=cfg.draftingEnabled===false?'reconciliation':'drafting';
  // Without all Staffify histories, introductions cannot safely deduplicate globally.
  const historyComplete=!errors.length;
  const active=cfg.accounts.filter(a=>tokens[a.email]);if(!active.length)throw Error('No healthy mailbox connections');
  let state=await redis.get(KEY);if(!state)throw Error('Shared queue not initialized');
  const senders=cfg.accounts.map(a=>a.email);state.creations ||=state.records.filter(r=>r.draftId&&r.createdAt).map(r=>({id:r.id+':import',day:dayKey(r.createdAt),sender:r.sender,owner:r.owner,touch:r.sentTouches?Math.max(1,r.sentTouches):1}));
  // Recover a Gmail success whose final queue save was interrupted. Never create again.
  const pending=state.records.find(r=>r.status==='draft_creation_pending');
  if(pending){const op=await redis.get('outreach:cloud:operation:'+pending.id+':'+(pending.sentTouches+1));
   if(op?.status==='saved'&&op.draft?.id){try{const d=assertDraft(await gmail(tokens[pending.sender],'drafts/'+encodeURIComponent(op.draft.id)),pending.recipient);Object.assign(pending,{draftId:d.id,messageId:d.message.id,threadId:d.message.threadId,status:'draft_saved',draftCreatedAt:new Date(op.at).toISOString()});}catch{pending.status='draft_creation_uncertain_hold';pending.holdError='Inspect the Gmail conversation before retrying; a previous create may have succeeded';}}
   else {pending.status='draft_creation_uncertain_hold';pending.holdError='Creation outcome is uncertain; no automatic retry';}state=await save(state);
  }
  // Incremental inbound scan. One account each tick; pagination resumes before watermark advances.
  const index=Number(await redis.get('outreach:cloud:inbox-index')||0)%active.length;const account=active[index];
  const cursor=await redis.get('outreach:cloud:inbox:'+account.email)||{after:Math.floor(Math.min(Date.parse(state.updatedAt)||Date.now()-7*86400000,Date.now()-48*3600000)/1000)};
  const scanUntil=cursor.until||Math.floor(Date.now()/1000);const query='in:anywhere -in:sent -in:drafts after:'+Math.max(0,cursor.after-300)+' before:'+(scanUntil+1);
  const list=await gmail(tokens[account.email],'messages?'+new URLSearchParams({q:query,maxResults:'20',...(cursor.page?{pageToken:cursor.page}:{})}));
  const inbound=[];for(let i=0;i<(list.messages||[]).length;i+=5)inbound.push(...await Promise.all(list.messages.slice(i,i+5).map(item=>gmail(tokens[account.email],'messages/'+item.id+'?format=full'))));
  for(const m of inbound){const h=headers(m);const from=addresses(h.from)[0];const body=messageText(m);const affected=state.records.filter(r=>r.recipient===from||(/mailer-daemon|postmaster/i.test(h.from||'')&&body.includes(r.recipient)));
   for(const row of affected){row.status=/mailer-daemon|postmaster/i.test(h.from||'')?'bounce_hold':(classify([compactMessage(m,account.email)],row.recipient,senders).status||'human_reply_hold');row.replyMessageId=m.id;row.replyReceivedAt=new Date(Number(m.internalDate)).toISOString();if(row.status==='suppressed'&&!state.suppressions.includes(row.recipient))state.suppressions.push(row.recipient);}
  }
  state=await save(state);
  await redis.set('outreach:cloud:inbox:'+account.email,list.nextPageToken?{...cursor,page:list.nextPageToken,until:scanUntil}:{after:scanUntil});
  if(!list.nextPageToken)await redis.set('outreach:cloud:inbox-index',(index+1)%active.length);
  // Reconcile held drafts before making more. No delete or send endpoint is used.
  for(const row of state.records){const a=state.assignments.find(a=>a.email===row.recipient);if(state.suppressions.includes(row.recipient))row.status='suppressed';else if(a&&a.owner!==row.owner){row.owner=a.owner;row.status='ownership_hold';}else if(state.pausedOwners.includes(row.owner)&&row.draftId)row.status='owner_paused_hold';}
  for(const row of state.records.filter(r=>r.draftId&&(['email_verification_hold','suppressed','human_reply_hold','bounce_hold','auto_reply_hold','held_reply','held_out_of_office','ownership_hold','owner_paused_hold','crm_hold','control_hold','existing_draft_hold','send_history_changed_hold','cross_account_history_hold','sequence_complete_hold','followup_not_due_hold','draft_changed_hold','reserved_for_madison_external'].includes(r.status))&&!r.cloudHeld)){
   if(Date.now()-started>120000)break;
   if(!tokens[row.sender])continue;
   let draft;try{draft=await gmail(tokens[row.sender],'drafts/'+encodeURIComponent(row.draftId));}catch(e){row.holdError='Draft unavailable; reconcile manually';state=await save(state);continue;}
   if(!draft.message?.labelIds?.includes('DRAFT')){row.previousDraftId=row.draftId;row.draftId=null;row.messageId=null;row.cloudHeld=true;row.holdError=null;state=await save(state);continue;}
   const raw=mime({sender:row.sender,to:'',subject:'DO NOT SEND - '+row.status,body:row.bodyText||'',id:'hold-'+row.id});
   try{await gmail(tokens[row.sender],'drafts/'+encodeURIComponent(row.draftId),{message:{raw,threadId:draft.message.threadId}},'PUT');}catch(e){if(/Message not a draft/.test(e.message)){row.previousDraftId=row.draftId;row.draftId=null;row.messageId=null;row.holdError='Draft was sent or removed during reconciliation';state=await save(state);continue;}throw e;}assertDraft(await gmail(tokens[row.sender],'drafts/'+encodeURIComponent(row.draftId)),null);row.cloudHeld=true;state=await save(state);
  }
  for(const row of state.records.filter(r=>r.status==='suppressed'&&!r.globalSuppressionSynced)){if(Date.now()-started>120000)break;await suppress(row,'Email opt-out recorded by hosted outreach worker');row.globalSuppressionSynced=true;state=await save(state);}
  if(Date.now()-started>120000){report.status='reconciled';return await finish(200);}
  // Refresh a bounded rotating batch, including held conversations, to retain the complete paper trail.
  const tracked=state.records.filter(r=>r.threadId&&tokens[r.sender]);const offset=Number(await redis.get('outreach:cloud:thread-index')||0);
  for(const row of tracked.slice(offset%Math.max(1,tracked.length),offset%Math.max(1,tracked.length)+12)){
   if(Date.now()-started>120000)break;
   let thread;try{thread=await gmail(tokens[row.sender],'threads/'+row.threadId+'?format=full');}catch(e){row.status='thread_check_hold';row.holdError=e.message;report.checked++;continue;}
   let messages=thread.messages||[];
   if(row.sentTouches>=4){try{messages=await history(tokens[row.sender],row.recipient);}catch(e){row.status='thread_check_hold';row.holdError=e.message;report.checked++;continue;}}
   reconcileThread(row,messages.map(m=>compactMessage(m,row.sender)));
   if(row.status==='suppressed'&&!state.suppressions.includes(row.recipient))state.suppressions.push(row.recipient);
   if((row.status==='draft_saved'||row.callReady)&&!await canDraft(row))row.status='crm_hold';
   report.checked++;
  }
  await redis.set('outreach:cloud:thread-index',offset+report.checked);state=await save(state);
  // Retry transient eligibility holds against fresh live data, without recreating held or removed drafts.
  for(const row of state.records.filter(r=>r.status==='crm_hold'&&!r.draftId&&(!r.crmRecheckedAt||Date.now()-Date.parse(r.crmRecheckedAt)>30*60000)).slice(0,12)){
   row.crmRecheckedAt=new Date().toISOString();
   if(await canDraft(row)){if(row.sentTouches&&row.lastSentAt)row.status='sent';else if(row.qualificationApproved)row.status='prepared';}
  }
  state=await save(state);
  if(dealSupply&&cfg.draftingEnabled!==false&&historyComplete&&Date.now()-started<45000){try{report.dealFollowups=await dealSupply(state,cfg,tokens);state=await save(state);}catch(e){report.dealFollowupError=String(e.message).slice(0,120);}}
  if(historyComplete)state=await sendOne({state,cfg,tokens,senders,redis,KEY,save,gmail,history,compactMessage,assertDraft,messageText,canDraft,config,started,report});
  const hour=Number(new Intl.DateTimeFormat('en-US',{hour:'numeric',hourCycle:'h23',timeZone:'America/New_York'}).format(new Date()));
  if(cfg.draftingEnabled!==false&&historyComplete&&Date.now()-started<45000&&state.records.filter(r=>r.status==='prepared').length<30){report.qualified=await supply(state,cfg);state=await save(state);}
  const candidates=fairCandidates(state.records.filter(r=>eligible(r,state)&&cfg.draftingEnabled!==false&&historyComplete),state.creations);
  for(const row of candidates){
   if(Date.now()-started>120000||report.created>=1)break;
   if(!cfg.accounts.find(a=>a.email===row.sender&&a.owner===row.owner)?.draftEnabled||!tokens[row.sender]||!quota(row,state.creations))continue;
   if(!await canDraft(row)){row.status='crm_hold';state=await save(state);continue;}
   if(Date.now()-started>120000)break;
   const assignment=state.assignments.find(a=>a.email===row.recipient);if(assignment&&assignment.owner!==row.owner)continue;
   let messages=[];try{messages=(await Promise.all(senders.map(async sender=>(await history(tokens[sender],row.recipient)).map(m=>compactMessage(m,sender))))).flat();}catch(e){row.status='history_check_hold';row.holdError='Mailbox history could not be fully checked';state=await save(state);continue;}
   if(Date.now()-started>210000)break;
   if(messages.some(m=>m.draft)){row.status='existing_draft_hold';row.holdError='An existing Gmail draft was found; review it before creating another';state=await save(state);continue;}
   const verdict=classify(messages,row.recipient,senders);if(verdict.status){row.status=verdict.status;if(verdict.status==='suppressed')state.suppressions.push(row.recipient);state=await save(state);continue;}
   if(row.sentTouches===0&&messages.length){row.status='prior_contact_hold';state=await save(state);continue;}
   const actual=verdict.sent;if(actual.some(m=>m.mailbox!==row.sender)){row.status='cross_account_history_hold';state=await save(state);continue;}
   if(actual.length){const latest=actual.sort((a,b)=>a.date-b.date).at(-1);row.sentTouches=Math.max(row.sentTouches,actual.length);row.lastSentAt=new Date(latest.date).toISOString();row.replyId=latest.replyId;row.threadId=latest.threadId;if(!eligible({...row,status:'sent'},state))continue;}
   const body=row.sentTouches?followup(row):row.bodyText;const copyError=copyIssue(row,body);if(copyError){row.status='copy_review_hold';row.holdError=copyError;state=await save(state);continue;}
   // Durable reservation precedes Gmail: an uncertain create is held, never blindly retried.
   const operation=row.id+':'+(row.sentTouches+1);if(await redis.get('outreach:cloud:operation:'+operation))continue;
   const fresh=await redis.get(KEY);if(fresh.revision!==state.revision)throw Error('Controls changed before draft creation');
   if(!await redis.set('outreach:cloud:operation:'+operation,{status:'reserved',at:Date.now()},{nx:true}))continue;
   state.creations.push({id:operation,day:dayKey(Date.now()),owner:row.owner,sender:row.sender,touch:row.sentTouches+1,status:'reserved'});row.status='draft_creation_pending';state=await save(state);
   try{const raw=mime({sender:row.sender,to:row.recipient,subject:row.sentTouches?'Re: '+String(row.subject||'Your agency workflow').replace(/^Re:\s*/i,''):row.subject,body,id:'staffify-'+operation.replace(/[^a-z0-9-]/gi,'-'),replyId:row.sentTouches?row.replyId:undefined});
    const draft=await gmail(tokens[row.sender],'drafts',{message:{raw,...(row.sentTouches?{threadId:row.threadId}:{})}});
    assertDraft(await gmail(tokens[row.sender],'drafts/'+encodeURIComponent(draft.id)),row.recipient);
    await redis.set('outreach:cloud:operation:'+operation,{status:'saved',draft,at:Date.now()});
    state.creations.find(c=>c.id===operation).status='verified';
    Object.assign(row,{draftId:draft.id,messageId:draft.message.id,threadId:draft.message.threadId,status:'draft_saved',bodyText:body,draftCreatedAt:new Date().toISOString()});state=await save(state);report.created++;
   }catch(e){await redis.set('outreach:cloud:operation:'+operation,{status:'uncertain',at:Date.now(),error:'Inspect Gmail before any retry'});throw e;}
  }
  report.status=historyComplete?'complete':'partial';if(!historyComplete)report.reason='One or more mailbox histories are unavailable; new drafts paused to prevent duplicate outreach';return await finish(200);
 }catch(e){report.status='error';report.reason=String(e.message).slice(0,180);return await finish(503);
 }
}
}
