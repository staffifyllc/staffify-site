// Only threads explicitly registered from prepared personal playbook drafts qualify.
export function reconcileManual(record,messages,{email,threadId,sender,now=Date.now()}){
 const matching=messages.filter(m=>m.threadId===threadId);
 const sent=matching.filter(m=>m.sent&&!m.draft&&m.from===sender&&m.to.includes(email));
 if(!sent.length)return null;
 const events=new Map((record.events||[]).map(e=>[e.id,e]));
 for(const m of sent)events.set(m.id,{id:m.id,kind:'sent',at:new Date(m.date).toISOString(),subject:m.subject,body:m.text,threadId,source:'gmail-manual-send'});
 const replies=new Map((record.replies||[]).map(e=>[e.id,e]));
 for(const m of matching.filter(m=>m.from===email&&!m.draft))replies.set(m.id,{id:m.id,at:new Date(m.date).toISOString(),body:m.text,subject:m.subject,mailbox:sender,threadId});
 return {...record,sender,manualFollowup:true,events:[...events.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)),replies:[...replies.values()],manualReconciledAt:new Date(now).toISOString()};
}
