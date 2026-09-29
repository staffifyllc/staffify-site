export function automatedModeAllowed(mode){return !mode||mode==='AUTOMATED';}
export const FOUR_TOUCHES=4;
export const dayKey=(now)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
export function eligible(record,state,now=Date.now()) {
 if(state.pausedOwners?.includes(record.owner)||state.suppressions?.includes(record.recipient))return false;
 if(!['sent','prepared'].includes(record.status)||record.sentTouches>=FOUR_TOUCHES)return false;
 if(record.nextEligibleAt&&now<Date.parse(record.nextEligibleAt))return false;
 if(record.status==='sent')return !!record.lastSentAt&&now-Date.parse(record.lastSentAt)>=48*3600000;
 return record.sentTouches===0&&!!record.bodyText&&record.qualificationApproved===true;
}
export function quota(record,creations,now=Date.now()) {
 const day=dayKey(now);const today=creations.filter(c=>c.day===day);
 // Each Madison mailbox has its own 50-total daily quota, including follow-ups.
 if(record.owner==='Madison')return today.filter(c=>c.owner==='Madison'&&c.sender===record.sender).length<50;
 if(record.sentTouches>0)return true;
 return today.filter(c=>c.sender===record.sender&&c.touch===1).length<50;
}
export function classify(messages,recipient,senders) {
 const seen=new Set();const sent=messages.filter(m=>{if(!m.sent||!m.to.includes(recipient))return false;const key=m.replyId||m.id;if(seen.has(key))return false;seen.add(key);return true;});
 const incoming=messages.filter(m=>m.from===recipient&&!senders.includes(m.from));
 if(incoming.some(m=>/\b(stop|unsubscribe|remove me|do not (?:email|contact|reach out)|don['’]?t (?:email|contact)|not interested|no thanks|no thank you|take me off|remove (?:us|my email)|not (?:a good fit|for us)|not looking (?:for|to))\b/i.test(replyText(m.text))))return {status:'suppressed',sent};
 // All other inbound messages, including automatic responses, hold until reviewed.
 if(incoming.length){const human=incoming.filter(m=>!m.automatic);return {status:human.length?'human_reply_hold':'auto_reply_hold',sent};}
 return {status:null,sent};
}
export function followup(record) {
 const parts=[
 'One useful handoff is a revision log: each requested change, who owns it, and whether it passed review. Which part of revision tracking still lands on your desk?',
 'Another task to hand off is checking that every promised deliverable is ready before a client is told the job is complete. Do you already have one person responsible for that last check?',
 'I will leave it here after this note. If you decide to delegate a recurring task, start with one written checklist and a clear rule for what comes back to you. Is there one task you would start with?'];
 return ['Hi '+(record.verifiedFirstName||'there')+',',parts[Math.min(Math.max(record.sentTouches-1,0),2)],record.owner==='Madison'?'Madison\nStaffify':'Paul\nFlylisted + Staffify',"If you'd prefer no more emails, just let me know."].join('\n\n');
}

// Only the newly authored reply is evidence of refusal, never quoted campaign copy.
export function replyText(text){return String(text||'').split(/<blockquote\b|<div[^>]*class=["']gmail_quote|\nOn .{0,200}wrote:|-----Original Message-----|\nFrom:\s/mi)[0].split('\n').filter(l=>!/^\s*>/.test(l)).join('\n').replace(/<[^>]*>/g,' ');}
export function callReady(r,now=Date.now()){return r.status==='sent'&&r.sentTouches>=4&&r.verifiedSentTouches>=4&&!!r.lastSentAt&&now-Date.parse(r.lastSentAt)>=48*3600000;}
export function reconcileThread(row,messages,now=Date.now()) {
 const sent=messages.filter(m=>m.sent&&m.to.includes(row.recipient)).sort((a,b)=>a.date-b.date);
 const drafts=messages.filter(m=>m.draft);const before=row.sentTouches||0;row.verifiedSentTouches=sent.length;
 row.events=messages.filter(m=>!m.draft).map(m=>({id:m.id,kind:m.sent?'sent':'received',at:new Date(m.date).toISOString(),subject:m.subject||'',body:m.text,from:m.from,to:m.to}));
 if(sent.length){const last=sent.at(-1);row.sentTouches=Math.max(before,sent.length);row.lastSentAt=new Date(last.date).toISOString();row.nextEligibleAt=new Date(last.date+48*3600000).toISOString();row.replyId=last.replyId;}
 if(!drafts.length){row.draftId=null;row.messageId=null;if(row.status==='draft_saved'&&sent.length<=before)row.status='missing_draft_hold';else if(['sent','draft_saved'].includes(row.status))row.status=sent.length?'sent':'missing_draft_hold';}
 const v=classify(messages,row.recipient,[row.sender]);if(v.status)row.status=v.status;
 row.verifiedAt=new Date(now).toISOString();row.callReady=callReady(row,now);return row;
}
