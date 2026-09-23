export const FOUR_TOUCHES=4;
export const dayKey=(now)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
export function eligible(record,state,now=Date.now()) {
 if(state.pausedOwners?.includes(record.owner)||state.suppressions?.includes(record.recipient))return false;
 if(!['sent','prepared'].includes(record.status)||record.sentTouches>=FOUR_TOUCHES)return false;
 if(record.status==='sent')return !!record.lastSentAt&&now-Date.parse(record.lastSentAt)>=48*3600000;
 return record.sentTouches===0&&!!record.bodyText&&record.qualificationApproved===true;
}
export function quota(record,creations,now=Date.now()) {
 const day=dayKey(now);const today=creations.filter(c=>c.day===day);
 // Madison's 50 TOTAL is across her queue, not 50 multiplied by her mailboxes.
 if(record.owner==='Madison')return today.filter(c=>c.owner==='Madison').length<50;
 if(record.sentTouches>0)return true;
 return today.filter(c=>c.sender===record.sender&&c.touch===1).length<50;
}
export function classify(messages,recipient,senders) {
 const sent=messages.filter(m=>m.sent&&m.to.includes(recipient));
 const incoming=messages.filter(m=>m.from===recipient&&!senders.includes(m.from));
 if(incoming.some(m=>/\b(stop|unsubscribe|remove me|do not (?:email|contact)|not interested|no thanks)\b/i.test(m.text)))return {status:'suppressed',sent};
 // All other inbound messages, including automatic responses, hold until reviewed.
 if(incoming.length)return {status:'human_reply_hold',sent};
 return {status:null,sent};
}
export function followup(record) {
 const parts=[
 'One useful handoff is a revision log: each requested change, who owns it, and whether it passed review. Which part of revision tracking still lands on your desk?',
 'Another task to hand off is checking that every promised deliverable is ready before a client is told the job is complete. Do you already have one person responsible for that last check?',
 'I will leave it here after this note. If you decide to delegate a recurring task, start with one written checklist and a clear rule for what comes back to you. Is there one task you would start with?'];
 return ['Hi there,',parts[Math.min(Math.max(record.sentTouches-1,0),2)],record.owner==='Madison'?'Madison\nStaffify':'Paul\nFlylisted + Staffify',"If you'd prefer no more emails, just let me know."].join('\n\n');
}
