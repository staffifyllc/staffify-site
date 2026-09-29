import {dayKey,classify} from './_outreach-policy.js';
export function sendQuota(row,state,now=Date.now()) {
 const day=dayKey(now),seen=new Map();
 for(const r of state.records)for(const e of r.events||[])if(e.kind==='sent'&&dayKey(e.at)===day)seen.set(r.sender+':'+e.id,{owner:r.owner,sender:r.sender,touch:(r.events||[]).filter(x=>x.kind==='sent'&&Date.parse(x.at)<=Date.parse(e.at)).length});
 for(const s of state.sends||[])if(s.day===day)seen.set(s.sender+':'+(s.messageId||s.id),s);
 const today=[...seen.values()];return row.owner==='Madison'?today.filter(s=>s.owner==='Madison').length<50:row.sentTouches>0||today.filter(s=>s.sender===row.sender&&s.touch===1).length<50;
}
export function sendDecision(row,state,messages,senders,now=Date.now()) {
 if(state.pausedOwners.includes(row.owner)||state.suppressions.includes(row.recipient))return 'control_hold';
 if(state.assignments.some(a=>a.email===row.recipient&&a.owner!==row.owner))return 'ownership_hold';
 const verdict=classify(messages,row.recipient,senders);if(verdict.status)return verdict.status;
 const drafts=messages.filter(m=>m.draft);if(drafts.some(m=>m.mailbox!==row.sender||m.id!==row.messageId))return 'existing_draft_hold';
 if(verdict.sent.some(m=>m.mailbox!==row.sender))return 'cross_account_history_hold';
 if(verdict.sent.length!==row.sentTouches)return 'send_history_changed_hold';
 if(verdict.sent.length>=4)return 'sequence_complete_hold';
 if(verdict.sent.length&&now-Math.max(...verdict.sent.map(m=>m.date))<48*3600000)return 'followup_not_due_hold';
 return null;
}
export async function sendOne({state,cfg,tokens,senders,redis,KEY,save,gmail,history,compactMessage,assertDraft,messageText,canDraft,config,started,report,now=Date.now()}) {
 if(!cfg.sendingEnabled)return state;
 state.sends ||= [];
 // A request with an uncertain outcome is never retried automatically.
 for(const row of state.records.filter(r=>r.status==='auto_send_pending')){
  const op=await redis.get('outreach:cloud:send:'+(row.sendOperationId||row.id+':'+(row.sentTouches+1)));
  row.status='auto_send_uncertain_hold';row.holdError='Send outcome requires reconciliation; no automatic retry';
  if(op?.messageId){const m=compactMessage(await gmail(tokens[row.sender],'messages/'+op.messageId+'?format=full'),row.sender);if(m.sent)applySent(row,state,m,op.id);}
  state=await save(state);
 }
 const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',hourCycle:'h23'}).format(new Date(now)));if(hour<8)return state;
 const candidates=state.records.filter(r=>r.status==='draft_saved'&&r.draftId&&tokens[r.sender]&&cfg.accounts.some(a=>a.email===r.sender&&a.owner===r.owner)&&state.creations.some(c=>c.id===r.id+':'+(r.sentTouches+1)&&c.status==='verified')).sort((a,b)=>b.sentTouches-a.sentTouches);
 for(const row of candidates){
  if(Date.now()-started>170000)break;
  if(!sendQuota(row,state)||state.pausedOwners.includes(row.owner)||state.suppressions.includes(row.recipient))continue;
  if(!await canDraft(row)){row.status='crm_hold';state=await save(state);continue;}
  const messages=(await Promise.all(senders.map(async sender=>(await history(tokens[sender],row.recipient)).map(m=>compactMessage(m,sender))))).flat();
  const reason=sendDecision(row,state,messages,senders);if(reason){row.status=reason;if(reason==='suppressed'&&!state.suppressions.includes(row.recipient))state.suppressions.push(row.recipient);state=await save(state);continue;}
  const draft=assertDraft(await gmail(tokens[row.sender],'drafts/'+encodeURIComponent(row.draftId)),row.recipient);
  if(!draft.message.labelIds?.includes('DRAFT')||draft.message.id!==row.messageId||messageText(draft.message).trim()!==row.bodyText.trim()){row.status='draft_changed_hold';state=await save(state);continue;}
  const current=await config();if(!current.enabled||!current.sendingEnabled)return state;
  const fresh=await redis.get(KEY);if(fresh.revision!==state.revision)throw Error('Controls changed before send');
  const id=row.id+':'+(row.sentTouches+1),key='outreach:cloud:send:'+id;
  if(!await redis.set(key,{id,status:'reserved',at:Date.now()},{nx:true}))continue;
  state.sends.push({id,day:dayKey(Date.now()),sender:row.sender,owner:row.owner,touch:row.sentTouches+1,status:'reserved'});row.sendOperationId=id;row.status='auto_send_pending';state=await save(state);
  try{
   const sent=await gmail(tokens[row.sender],'drafts/send',{id:row.draftId});
   await redis.set(key,{id,status:'sent',messageId:sent.id,at:Date.now()});
   const verified=compactMessage(await gmail(tokens[row.sender],'messages/'+sent.id+'?format=full'),row.sender);
   if(!verified.sent||!verified.to.includes(row.recipient))throw Error('Sent message verification failed');
   applySent(row,state,verified,id);state=await save(state);report.sent=(report.sent||0)+1;break;
  }catch(e){report.sendError='Send outcome held for reconciliation; no automatic retry';throw e;}
 }
 return state;
}
function applySent(row,state,m,id){const at=new Date(m.date).toISOString();const entry=state.sends.find(s=>s.id===id);if(entry)Object.assign(entry,{status:'verified',messageId:m.id,day:dayKey(m.date),at});row.events ||= [];if(!row.events.some(e=>e.id===m.id))row.events.push({id:m.id,kind:'sent',at,subject:m.subject,body:m.text,from:m.from,to:m.to});Object.assign(row,{status:'sent',sentTouches:Math.max(row.sentTouches,entry?.touch||row.sentTouches+1),verifiedSentTouches:Math.max(row.verifiedSentTouches||0,entry?.touch||row.sentTouches+1),lastSentAt:at,nextEligibleAt:new Date(m.date+48*3600000).toISOString(),threadId:m.threadId,replyId:m.replyId,draftId:null,messageId:null,verifiedAt:new Date().toISOString(),autoSentAt:at,holdError:null});}
