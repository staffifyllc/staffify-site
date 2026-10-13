import {createHash} from 'node:crypto';
export function performance(rows,confirmedReplies=[]){
 const sends=new Map(),reached=new Set(),replied=new Set(),missing=new Set(),variants=new Map();
 for(const r of rows){
  const email=String(r.recipient||'').toLowerCase();
  const events=(r.events||[]).filter(e=>e.kind==='sent'&&e.id&&e.at);
  if(r.sentTouches>0&&!events.length)missing.add(email);
  for(const e of events){const key=r.sender+':'+e.id;sends.set(key,e);reached.add(email);}
  if(events.length&&confirmedReplies.includes(email))replied.add(email);
  if(events.length&&r.status==='human_reply_hold'&&(r.replyReceivedAt||(r.events||[]).some(e=>e.kind==='received')))replied.add(email);
  const first=events.slice().sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))[0];
  if(first?.body){const hash=createHash('sha256').update(first.subject+'\n'+first.body).digest('hex').slice(0,12);const v=variants.get(hash)||{id:hash,subject:first.subject,contacts:new Set(),firstSentAt:first.at};v.contacts.add(email);variants.set(hash,v);}
 }
 return {records:rows.length,recordedSends:sends.size,contactsReached:reached.size,confirmedReplyEmails:[...replied],humanReplyContacts:replied.size,humanReplyRate:reached.size?Math.round(replied.size/reached.size*1000)/10:null,missingSendHistory:missing.size,coverage:missing.size?'Partial: some previously sent records have no retained message history':'Retained message history',replyDefinition:'Contacts with recorded human reply evidence; confirmed responses are retained in cloud snapshots even after handoff. Opt-outs and automatic replies are excluded.',optOutHolds:rows.filter(r=>r.status==='suppressed').length,bounceHolds:rows.filter(r=>r.status==='bounce_hold').length,autoReplyHolds:rows.filter(r=>r.status==='auto_reply_hold').length,readyForCall:rows.filter(r=>r.callReady).length,meetingEvidence:'Not connected to campaign attribution',revenueEvidence:'Not enabled',comparison:reached.size<20?'Small sample: fewer than 20 reached contacts':'Review reply quality before increasing volume',messageVersions:[...variants.values()].map(v=>({...v,contacts:v.contacts.size}))};
}
