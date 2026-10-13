import {conversationEmail,nextConversationAt} from './_playbook-conversation.js';
const touches=[['day2_sent_at',7,"Start with inbox. Here's the math."],['day6_sent_at',14,'Why most first hires fail (and what works)'],['day12_sent_at',21,'60% off editing. Same quality.'],['day21_sent_at',28,"60 founder-hours, gone. Here's where they went."],['day45_sent_at',35,"Last one. Then I'm out."]];
const iso=v=>v&&Number.isFinite(Number(v))?new Date(Number(v)).toISOString():null;
export function websiteLead(rec,nurture={},suppressed=false,conversation=null){
 const source=String(rec.source||'unknown');const category=/test/i.test(source)?'test':/discovery-call-booked/.test(source)?'booking':'website';
 const events=[];
 if(rec.playbook_sent_at)events.push({at:iso(rec.playbook_sent_at),subject:'The 10 highest-ROI delegations, inside',type:'Playbook',evidence:'Recorded sent; delivery not independently confirmed'});
 for(const [key,day,subject] of touches)if(nurture[key])events.push({at:iso(nurture[key]),subject,type:'Nurture email',evidence:'Recorded sent; subject is the current template title'});
 events.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const state=suppressed?'Unsubscribed':nurture.graduated_at?'Stopped: '+(nurture.graduated_reason||'engaged'):rec.decision?'Decision recorded: '+rec.decision:nurture.cool_off_until?'Nurture cooldown':nurture.enrolled_at?'Nurture enrolled':'Not enrolled';
 const next=touches.find(([key])=>!nurture[key]);
 const nextAt=state==='Nurture enrolled'?iso(nextConversationAt(nurture.enrolled_at,[])):null;
 if(conversation){
  for(const e of conversation.events||[])events.push({...e,type:'Personal follow-up',evidence:'Verified in Gmail Sent · Message ID: '+e.id});
  for(const e of conversation.replies||[])events.push({...e,type:'Reply received',evidence:'Read from connected Gmail mailbox',url:'https://mail.google.com/mail/?authuser='+encodeURIComponent(e.mailbox)+'#all/'+e.threadId});
 }
 const personalState=conversation?conversation.status+(conversation.reason?': '+conversation.reason:''):null;
 const personalNext=conversation?.status==='scheduled'?new Date(conversation.nextAt).toISOString():null;
 return {sender:conversation?.sender||'paul@trystaffify.com',preview:conversationEmail(rec.first_name||'',Math.min(3,(conversation?.events?.length||0)+1)).body,signupSlack:rec.signup_slack_status||'Not recorded',email:rec.email,name:rec.first_name||'',source,category,signedUpAt:iso(rec.signed_up_at),state:suppressed?state:personalState||state,events,nextAt:conversation?personalNext:nextAt,nextSubject:conversation?personalNext?conversationEmail().subject:null:nextAt?next[2]:null,cycle:Number(nurture.cycle_count||0),cooldownUntil:iso(nurture.cool_off_until)};
}
