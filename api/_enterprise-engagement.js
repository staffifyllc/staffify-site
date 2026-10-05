const DAY=86400000;
export const ENGAGEMENT_STEPS=[
 {id:'connect',channel:'LinkedIn',day:0,title:'Send a relevant connection invitation',manual:true},
 {id:'email-1',channel:'Email',day:3,title:'Ask about the supplier route',emailIndex:0},
 {id:'email-2',channel:'Email',day:10,title:'Offer a short capability brief',emailIndex:1},
 {id:'linkedin-followup',channel:'LinkedIn',day:14,title:'Message only if connected',requiresConnection:true,manual:true},
 {id:'email-3',channel:'Email',day:21,title:'Explore the intake or pilot path',emailIndex:2},
 {id:'email-4',channel:'Email',day:28,title:'Close the loop respectfully',emailIndex:3}
];
export function linkedinURL(value){
 if(!value)return null;
 let u;try{u=new URL(value);}catch{throw Error('Use a full LinkedIn profile URL');}
 if(u.protocol!=='https:'||!['www.linkedin.com','linkedin.com'].includes(u.hostname)||!/^\/in\/[^/]+\/?$/.test(u.pathname))throw Error('Use an individual linkedin.com/in/ profile URL');
 return 'https://www.linkedin.com'+u.pathname.replace(/\/$/,'')+'/';
}
export function engagementPlan(a,now=Date.now()){
 const p=a.engagement,events=p?.events||[],contact=a.contacts.find(c=>c.name===p?.contactName);
 const stop=a.engagementStop||(['paused','human_conversation'].includes(a.status)?a.status:null);
 let lastActual=null,priorDone=true;
 const steps=ENGAGEMENT_STEPS.map((step,index)=>{
  const event=events.find(e=>e.stepId===step.id&&['reported_complete','skipped'].includes(e.kind));
  const base=p?.startedAt?Date.parse(p.startedAt)+step.day*DAY:null;
  const dueAt=base==null?null:Math.max(base,lastActual==null?base:lastActual+3*DAY);
  const current=priorDone&&!event;priorDone=priorDone&&!!event;
  if(event?.kind==='reported_complete')lastActual=Date.parse(event.occurredAt);
  let state=event?.kind||(!p?'not_started':stop?'held':!current?'waiting_previous':dueAt>now?'scheduled':'due');
  let reason=stop||null;
  if(state==='due'&&step.requiresConnection&&!p.connected){state='needs_connection';reason='Confirm acceptance or skip this LinkedIn step; do not send another invitation.';}
  if(state==='due'&&step.channel==='Email'){state='email_not_connected';reason='Enterprise automatic email delivery is not connected. Copy is available for review; manual sends must be logged explicitly.';}
  return {...step,state,reason,dueAt:dueAt==null?null:new Date(dueAt).toISOString(),event:event||null,current:!!p&&current&&!stop};
 });
 return {started:!!p,contact:contact||null,stop,connected:!!p?.connected,steps,completed:events.filter(e=>e.kind==='reported_complete').length};
}
export function engagementUpdate(a,body,actor,now){
 if(body.action==='engagement-start'){
  if(a.engagement)throw Error('This account already has an outreach plan');
  if(a.engagementStop||['paused','human_conversation'].includes(a.status))throw Error('Account is on hold');
  const c=a.contacts.find(c=>c.name===body.contactName);if(!c?.linkedin)throw Error('Choose a researched contact with a LinkedIn profile first');
  a.engagement={contactName:c.name,startedAt:now,connected:false,events:[]};return 'Started coordinated task plan; nothing sent';
 }
 if(body.action==='engagement-stop'){
  if(!['reply','opt_out','meeting','client','human_owned'].includes(body.reason))throw Error('Choose a valid stop reason');
  const note=String(body.notes||'').trim().slice(0,3000);if(!note)throw Error('Add context for the handoff');
  a.engagementStop=body.reason;a.status='human_conversation';a.events.push({at:now,actor,kind:'engagement_stop',text:body.reason+': '+note});return 'Stopped enterprise outreach tasks for this account';
 }
 if(!a.engagement)throw Error('Start an account plan first');
 if(body.action==='engagement-connected'){
  if(a.engagementStop)throw Error('Account is on hold');
  a.engagement.connected=true;a.engagement.events.push({at:now,actor,kind:'connection_reported',text:'Connection acceptance reported by operator'});return 'Recorded connection acceptance';
 }
 if(body.action==='engagement-log'){
  if(!['reported_complete','skipped'].includes(body.kind))throw Error('Invalid completion type');
  const plan=engagementPlan(a,Date.parse(now)),step=plan.steps.find(s=>s.id===body.stepId);
  if(!step?.current)throw Error('Only the next open task can be recorded; the account may be on hold');
  if(body.kind==='reported_complete'&&['scheduled','needs_connection'].includes(step.state))throw Error('Task is not due or connection is not confirmed');
  const note=String(body.notes||'').trim().slice(0,3000);if(!note)throw Error('Paste the message or explain why this step was skipped');
  const date=body.kind==='skipped'?Date.parse(now):Date.parse(body.occurredAt);
  if(!Number.isFinite(date)||date>Date.parse(now)||date<Date.parse(a.engagement.startedAt))throw Error('Use an actual completion time within this plan, not a future date');
  a.engagement.events.push({at:now,actor,stepId:step.id,channel:step.channel,kind:body.kind,occurredAt:new Date(date).toISOString(),text:note,verification:'operator_reported'});
  return body.kind==='skipped'?'Skipped task with reason':'Recorded operator-reported completion, not provider-verified delivery';
 }
 throw Error('Unsupported engagement action');
}
export function linkedinCopy(a){return {
 invitation:a.lane==='enterprise-direct'?'Hi [first name], I run Staffify and am learning how your team brings in recruiting and staffing partners. Your work in [verified area] caught my attention. Open to connecting?':'Hi [first name], I run Staffify. I’m interested in how your team works with specialist recruiting and delivery partners. It would be good to connect.',
 followup:a.lane==='enterprise-direct'?'Thanks for connecting, [first name]. I’m trying to understand the right supplier route for recruiting and staffing support at [company]. Does that sit with your team or an MSP? Happy to follow the proper process.':'Thanks for connecting, [first name]. Where does your team tend to need extra recruiting or delivery capacity? If there’s a specific gap, I’d be happy to compare notes before sending a capability profile.'
};}
