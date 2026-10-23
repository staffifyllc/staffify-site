import {orderCallQueue} from './call-queue-order.js';
let selectedCampaign=new URLSearchParams(location.search).get('campaign')||'all';
const app=document.getElementById('app');
let state, current, selectedOwner=new URLSearchParams(location.search).get('owner')||'all', research=false, search='', requestId=0, busy=false;
const drafts=new Map(), skipped=new Set();
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
const button=(label,fn,cls='btn')=>{const b=el('button',label,cls);b.onclick=fn;return b;};
const link=(label,url,cls='btn btn-ghost')=>{const a=el('a',label,cls);a.href=url;if(!url.startsWith('tel:')){a.target='_blank';a.rel='noopener';}return a;};
async function api(url,body){const r=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});const j=await r.json();if(!r.ok){const err=Error(j.error||'Could not load current data');err.payload=j;err.status=r.status;throw err;}return j;}
const rows=()=>orderCallQueue(state.records,{campaign:selectedCampaign,owner:selectedOwner,search,research});
const positionKey=()=>`staffify-call-position:${selectedCampaign}:${selectedOwner}:${research}`;
function remember(id){try{sessionStorage.setItem(positionKey(),id);}catch{}}
function remembered(){try{return sessionStorage.getItem(positionKey());}catch{return null;}}
function move(offset){if(busy)return;const list=rows(),index=list.findIndex(r=>r.id===current?.id);const row=list[index+offset];if(row)show(row);}

function stash(){if(!current)return;const notes=document.getElementById('call-notes'),due=document.getElementById('callback-at');if(notes)drafts.set(current.id,{notes:notes.value,due:due?.value||'',outcome:document.querySelector('[data-outcome].sel')?.dataset.outcome||''});}
function errorBox(e){const box=el('div',e.message,'brief');box.setAttribute('role','alert');return box;}
// A prospect we will not call is not a prospect with nothing to show. The queue already holds the
// research, the website and the full email trail from the last worker sync, so render it read only
// with the date it was gathered. Stale evidence is labelled as stale; it is never passed off as a
// live check, and no outcome buttons appear because the call is still refused.
function renderBlocked(panel,row,p,message){
 panel.replaceChildren();
 const bhead=el('div',null,'headrow');
 bhead.append(el('h2',p.company||row.company||row.recipient,'company'));
 const btag=industryTag(p.industry);if(btag)bhead.append(btag);
 panel.append(bhead);
 const warn=el('div',message,'brief');warn.setAttribute('role','alert');panel.append(warn);
 panel.append(el('p','Reply, opt-out and client exclusions could NOT be re-checked just now, so this prospect is not callable yet. Everything below is from the last queue sync'+(p.syncedAt?' at '+new Date(p.syncedAt).toLocaleString():'')+'.','sub'));
 const grid=el('div',null,'cardgrid'),main=el('div',null,'cardmain'),tools=el('div',null,'cardtools');grid.append(main,tools);panel.append(grid);
 section(main,'Prospect details',[p.name,p.recipient,p.crmPhone,p.location,(p.sentTouches||0)+' emails sent',p.lastSentAt?'Last sent '+new Date(p.lastSentAt).toLocaleString():''].filter(Boolean).join('\n')).style.whiteSpace='pre-wrap';
 if(p.website)main.append(link('Their website',/^https?:\/\//.test(p.website)?p.website:'https://'+p.website));
 if(p.crmUrl)main.append(link('Open CRM contact',p.crmUrl));
 if(p.source?.url&&/^https?:\/\//.test(p.source.url))main.append(link('Research source',p.source.url));
 if(p.source?.excerpt)section(main,'Business context',p.source.excerpt);
 const trail=details(tools,'Past emails · '+(p.events||[]).length+' messages',true);
 for(const e of p.events||[]){const m=details(trail,e.kind+' · '+new Date(e.at).toLocaleString()+' · '+(e.subject||'')); m.append(el('p',e.mailbox||'','sub'));const b=el('pre',e.body||'');b.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;font:inherit';m.append(b);}
 const hist=details(tools,'Previous calls · '+(p.callHistory||[]).length,true);
 for(const c of p.callHistory||[])hist.append(el('p',new Date(c.at).toLocaleString()+' · '+(c.caller||'')+' · '+c.outcome),el('p',c.notes||'No notes'));
 panel.append(button('Retry this prospect',()=>show(row)),button('Skip to next',()=>{skipped.add(row.id);showNext();},'btn btn-ghost'));
}
// The same workspace serves /dialer/ and /spearhead/, so the heading has to say which list is on
// screen. "Team calls" over a pinned cohort of 21 CEOs tells a caller nothing about where they are.
const PINNED={'staffify-tobit-outreach':{eyebrow:'SPEARHEAD ACCOUNTS',h1:'CEO outreach',sub:'Worked one at a time, by name. Four emails sent to each and no reply.'}};
function toolbar(){const bar=el('div',null,'toprow');const title=el('div');const pin=PINNED[selectedCampaign];
 title.append(el('div',pin?pin.eyebrow:'SHARED CALL WORKSPACE','eyebrow'),el('h1',pin?pin.h1:'Team calls'),el('p',pin?pin.sub:'One shared queue · All sales owners · One prospect at a time.','sub'));
 // Nobody without a number reaches a caller, so the ones being worked on are counted here rather
 // than silently missing from the queue. Paul should see progress without managing lookups.
 const w=state&&state.numberWork;
 if(w&&(w.findingNumber||w.noNumberPossible)){
  const bits=[];
  if(w.findingNumber)bits.push(w.findingNumber+' having a number found automatically');
  if(w.noNumberPossible)bits.push(w.noNumberPossible+' where no number could be found');
  title.append(el('p','Held out of this queue: '+bits.join(' · ')+'. They are not lost, and no number is ever invented for them.','sub'));
 }
 bar.append(title);const tools=el('div',null,'chip-row');const campaign=el('select');campaign.setAttribute('aria-label','Campaign');const names={'all':'All campaigns','staffify-agency-outreach':'Staffify agency outreach','staffify-tobit-outreach':'CEO b2b outreach','staffify-talent-network-outreach':'Talent network outreach'};for(const id of new Set(['all',selectedCampaign,...(state?.records||[]).map(r=>r.campaignId)])){const o=el('option',names[id]||id);o.value=id;campaign.append(o);}campaign.value=selectedCampaign;campaign.onchange=()=>{stash();selectedCampaign=campaign.value;syncUrl();skipped.clear();current=null;showNext();};const ownerSel=el('select');ownerSel.setAttribute('aria-label','Sales owner');for(const [label,value] of [['All sales owners','all'],['Paul','Paul'],['Madison','Madison']]){const o=el('option',label);o.value=value;ownerSel.append(o);}ownerSel.value=selectedOwner;ownerSel.onchange=()=>{stash();selectedOwner=ownerSel.value;syncUrl();skipped.clear();current=null;showNext();};const find=el('input');find.placeholder='Find company, email or number';find.setAttribute('aria-label','Find prospect');find.value=search;find.onchange=()=>{stash();search=find.value;showNext();};tools.append(link('Campaign overview','/campaigns/'),campaign,ownerSel,find,button('Refresh queue',()=>refresh().catch(fail),'btn btn-ghost'));const filters=el('details',null,'queue-options');filters.append(el('summary','Queue options'),tools);bar.append(filters);return bar;}

function fail(e){app.replaceChildren(toolbar(),errorBox(e),button('Retry',()=>refresh().catch(fail)));}
function shell(){app.classList.add('call-workspace');app.replaceChildren(toolbar());
 const tabs=el('div',null,'call-tabs');for(const [label,value] of [['Ready to call',false],['Number research',true]]){const btn=button(label,()=>{stash();research=value;skipped.clear();current=null;showNext();},'btn'+(research===value?' active':''));btn.setAttribute('aria-pressed',String(research===value));tabs.append(btn);}app.append(tabs);
 const list=rows(),index=list.findIndex(r=>r.id===current?.id),bar=el('div',null,'queue-nav');
 const label=el('div',list.length?`Prospect ${Math.max(1,index+1)} of ${list.length}`:'Queue complete','queue-position');label.append(el('small',research?'These numbers need confirmation before a call.':'Business-listed numbers first, then due callbacks and oldest fourth email. Numbers and eligibility are checked on open.'));
 const controls=el('div',null,'queue-buttons'),prev=button('← Previous',()=>move(-1),'btn btn-ghost'),next=button('Next →',()=>move(1),'btn btn-ghost');prev.disabled=index<=0||busy;next.disabled=index<0||index>=list.length-1||busy;controls.append(prev,next);bar.append(label,controls);app.append(bar);
}
async function refresh(){stash();state=await api('/api/outreach-queue/?view=calls');skipped.clear();const row=rows().find(r=>r.id===(current?.id||remembered()));if(row)return show(row);await showNext();}
async function showNext(){const list=rows(),row=list.find(r=>!skipped.has(r.id));if(row)return show(row);current=null;shell();const empty=el('section',null,'card');empty.append(el('h2',list.length?'You’ve reached the end':'You’re caught up'),el('p',list.length?'Your skipped prospects are still in this queue. No call outcomes were changed.':research?'No prospects need number research in this view.':'No eligible prospects with a phone number are waiting in this view.'));if(list.length)empty.append(button('Review skipped prospects',()=>{skipped.clear();showNext();}));app.append(empty);}

async function show(row){stash();current=row;remember(row.id);const version=++requestId;shell();const panel=el('section',null,'card');app.append(panel);panel.append(el('h2',row.company||row.recipient,'company'),el('p','Checking live mailboxes, CRM, exclusions and business number…','brief'),button('Skip for now',()=>{if(busy)return;skipped.add(row.id);showNext();},'btn btn-ghost'));
 try{const brief=await api('/api/outreach-call-brief/?id='+encodeURIComponent(row.id));if(version!==requestId)return;renderCard(panel,row,brief);}catch(e){if(version!==requestId)return;if(e.payload&&e.payload.callable===false&&e.payload.recipient)return renderBlocked(panel,row,e.payload,e.message);panel.append(errorBox(e),button('Retry this prospect',()=>show(row)));}}
function section(parent,title,text,cls='brief'){parent.append(el('h2',title,'lbl'));const content=el('div',text,cls);parent.append(content);return content;}
// A filtered queue is a shareable link again: ?campaign= and ?owner= survive a reload and a paste.
function syncUrl(){const u=new URL(location.href);selectedCampaign==='all'?u.searchParams.delete('campaign'):u.searchParams.set('campaign',selectedCampaign);selectedOwner==='all'?u.searchParams.delete('owner'):u.searchParams.set('owner',selectedOwner);history.replaceState(null,'',u);}
function details(parent,title,open=false){const d=el('details');if(open)d.open=true;d.append(el('summary',title));parent.append(d);return d;}
const objections=[
 ['Busy','Of course. Is there a better time for a quick call, or would you rather leave it here?'],
 ['Already have help','That is great. What do they take care of, and is there anything that still ends up back on your plate?'],
 ['Not hiring','Understood. I was more curious about the work that still lands on you. If everything is covered, no problem.'],
 ['Send information','Happy to. Which part would actually be useful: customer support, account coordination, or something else? Confirm what they want and create a human follow-up.'],
 ['How much?','It depends on the role, hours and scope. Let us work out what you need first so I can give you an accurate quote. Use current approved pricing, not an old script.'],
 ['Wrong person / gatekeeper','Who handles the day-to-day operations for the business? Is there a better time to reach them?'],
 ['Not interested / stop','Understood. Thanks for letting me know. Use Not interested / stop below to exclude them from outreach.']
];
function scripts(parent,b){
 section(parent,'Say this',b.opener,'say');
 // The beat between the opener and the first question. Its own section so a caller sees it
 // before they start asking, rather than finding it buried in the branching guide.
 if(b.reason)section(parent,'Then say this',b.reason,'say');
 section(parent,'The conversation','Ask one question, then listen. Do not assume they read the emails or need a remote team member.','sub');
 // The brief picks these per campaign, so QC and revisions language only reaches media agency
 // owners. Falls back to the generic questions if an older brief is still cached.
 const stages=(b.stages&&b.stages.length)?b.stages.map(s=>[s.label,s.say]):[['Understand the work',b.questions[0]],['Find the bottleneck',b.questions[1]],['Make it useful',b.questions[2]],['Agree a next step',b.questions[3]||b.questions[2]]];
 const guide=el('div',null,'guide');
 // A call branches, it does not step. Each node is what to SAY; the buttons are what THEY just
 // said. The caller always has the next move in front of them instead of improvising, and a
 // terminal node names the disposition to log. Older cached briefs with no tree fall back to the
 // linear stepper so nothing breaks mid-shift.
 const LOGLABEL={connected:'Connected / interested',callback:'Callback / gatekeeper',suppress:'Not interested / stop'};
 if(b.tree&&b.tree.open){
  const path=['open'];
  const draw=()=>{
   const node=b.tree[path[path.length-1]]||{},parts=[];
   parts.push(el('div',path.length===1?'They have just heard the opener. What did they say?':'What did they say?','gstep'));
   if(node.say)parts.push(el('p',node.say,'say'));
   if(node.note)parts.push(el('div',node.note,'sub'));
   if(node.log)parts.push(el('div','Log this call as: '+(LOGLABEL[node.log]||node.log),'lbl'));
   const nav=el('div',null,'chip-row');
   for(const [label,to] of node.choices||[])nav.append(button(label,()=>{path.push(to);draw();},'objchip'));
   if(path.length>1)nav.append(button('Back',()=>{path.pop();draw();},'btn btn-ghost'));
   if(path.length>1&&!(node.choices||[]).length)nav.append(button('Start over',()=>{path.length=1;draw();},'btn btn-ghost'));
   parts.push(nav);
   guide.replaceChildren(...parts);
  };
  draw();
 } else {
  let step=0;
  const draw=()=>{guide.replaceChildren(el('div',`${step+1} / ${stages.length} · ${stages[step][0]}`,'gstep'),el('p',stages[step][1],'say'));const nav=el('div',null,'chip-row');if(step)nav.append(button('Previous',()=>{step--;draw();},'btn btn-ghost'));if(step<stages.length-1)nav.append(button('Next question',()=>{step++;draw();}));guide.append(nav);};
  draw();
 }
 parent.append(guide);
 const track=details(parent,'Full conversation script');for(const [title,say] of stages){track.append(el('h3',title,'lbl'),el('p',say,'say'));}
 const help=details(parent,'Objections & voicemail',true);
 const chips=el('div',null,'objrow'),answer=el('div','','objsay'),hint=el('div','','sub');
 const bank=(b.objections&&b.objections.length)?b.objections:objections.map(([label,say])=>({label,say,note:''}));
 // say is read aloud, note is for the caller only. They are separate so nobody reads an
 // instruction down the phone, which the old single-string bank invited.
 for(const o of bank)chips.append(button(o.label,()=>{answer.textContent=o.say;answer.classList.add('show');hint.textContent=o.note||'';},'objchip'));
 help.append(chips,answer,hint);
 section(help,'Voicemail',b.voicemail||`Hi, this is ${b.callerName} with Staffify. We sent you over a few notes about the day-to-day work at ${b.company||'your business'}. Just wanted to introduce myself. You can reply to our email if a conversation would be useful. Thanks.`,'say');
}
// Industry tag. A caller glancing at a card should know in one beat whether this is a real estate
// photographer or the CEO of a security company, because the opener changes completely.
const ICON={
 're-media':'M3 5h18v14H3z M8 5v14 M3 10h5 M3 15h5',
 'construction':'M3 21h18 M5 21V9l7-5 7 5v12 M10 21v-6h4v6',
 'property':'M3 21h18 M6 21V8l6-4 6 4v13 M10 13h4v8h-4z',
 'health':'M12 4v16 M4 12h16',
 'finance':'M3 21h18 M5 21V9 M9 21V6 M13 21v-9 M17 21V4',
 'software':'M8 6l-5 6 5 6 M16 6l5 6-5 6',
 'education':'M3 9l9-5 9 5-9 5z M7 12v5c0 1 2 2 5 2s5-1 5-2v-5',
 'marketing':'M4 10v4h3l5 4V6L7 10z M16 9a4 4 0 010 6',
 'nonprofit':'M12 20s-7-4.5-7-9a4 4 0 017-2.5A4 4 0 0119 11c0 4.5-7 9-7 9z',
 'legal':'M12 3v18 M5 7h14 M5 7l-2 6h4z M19 7l2 6h-4z',
 'logistics':'M3 7h11v9H3z M14 10h4l3 3v3h-7z M7 19a2 2 0 100-4 2 2 0 000 4 M18 19a2 2 0 100-4 2 2 0 000 4',
 'hospitality':'M7 3v8a3 3 0 006 0V3 M10 11v10 M17 3c-1.5 2-2 4-2 6s.5 3 2 3v9',
 'home-services':'M14 7a4 4 0 00-5.5 5.5L4 17l3 3 4.5-4.5A4 4 0 0017 10',
 'other':'M12 3a9 9 0 100 18 9 9 0 000-18 M12 8v5 M12 16h.01'
};
function industryTag(ind){
 if(!ind||!ind.label)return null;
 const wrap=el('span',null,'indtag');
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','15');svg.setAttribute('height','15');
 svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.7');
 svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');
 const path=document.createElementNS('http://www.w3.org/2000/svg','path');
 path.setAttribute('d',ICON[ind.key]||ICON.other);svg.append(path);
 wrap.append(svg,el('span',ind.label));
 // Where the tag came from, so a wrong one is traceable rather than mysterious.
 wrap.title=ind.source==='CRM'?'Industry from the CRM record'
   :ind.source==='campaign'?'This campaign is the real estate media list'
   :'Inferred from their own website';
 return wrap;
}
function renderCard(panel,row,b){panel.replaceChildren();const head=el('div',null,'headrow');head.append(el('h2',b.company||row.company,'company'),industryTag(b.industry)||el('span'),button('Skip for now',()=>{if(busy)return;skipped.add(row.id);showNext();},'btn btn-ghost'));panel.append(head,el('p',[b.name,b.location,'Shared caller queue', 'Sales owner: '+b.owner, row.callOwner?('Call owner: '+row.callOwner+(row.mine?' (you)':'')):'Unclaimed · first outcome claims it', 'Campaign: '+row.campaignId].filter(Boolean).join(' · '),'sub'));
 const grid=el('div',null,'cardgrid'),main=el('div',null,'cardmain'),side=el('div',null,'cardside'),toolsArea=el('div',null,'cardtools');grid.append(main,side,toolsArea);panel.append(grid);const tools=details(toolsArea,'Research, email history & booking links',true);
 section(main,'Prospect details',`${b.name}\n${row.recipient}\n${b.location||'Location not recorded'}\n${row.sentTouches} emails sent · Last sent ${new Date(row.lastSentAt).toLocaleString()}`).style.whiteSpace='pre-wrap';
 const phone=section(main,'Call from your business line',null,'phone');if(b.phone){phone.append(link(b.phone,'tel:'+b.phone),link('Call now','tel:'+b.phone,'call'),button('Copy number',async()=>{try{await navigator.clipboard.writeText(b.phone);}catch{phone.append(el('p','Select and copy the number above.'));}},'btn btn-ghost'));}else phone.append(el('p','No number on file. We are sourcing one. Skip to the next prospect, finding numbers is not your job.'));
 // Where the number came from, in one line, so a caller knows whether to expect the person or a
 // front desk. This replaces the research instruction that used to sit here.
 if(b.phone&&b.dial){const d=el('p',b.dial.label+(b.dial.detail?' · '+b.dial.detail:''),'sub');phone.append(d);
  if(b.dial.sourceUrl)phone.append(link('Where this number is published',b.dial.sourceUrl));
  for(const alt of b.dial.alternates||[])phone.append(link(alt,'tel:'+alt));}main.append(el('p','On iPhone, tap Call now and use your business line. The Hub does not detect or record iPhone calls automatically.','sub'));
 if(!b.dial)main.append(el('p',b.phoneEvidence?.detail||'No phone evidence available.','sub'));if(b.phoneEvidence?.sourceUrl)main.append(link('Business website / phone source',b.phoneEvidence.sourceUrl));main.append(link('Open CRM contact',b.crmUrl),link('Email conversation','https://mail.google.com/mail/u/?authuser='+encodeURIComponent(row.sender)+(row.threadId?'#all/'+encodeURIComponent(row.threadId):'#search/'+encodeURIComponent(row.recipient))));
 // The Instagram datapoint, shown as research with its proof rather than as a line to read out.
 // Paul: "I want our sales people to be armed." Armed means seeing the profile, the post, the date
 // and when we looked, so a caller can judge it before they say it.
 if(b.instagram){
  const ig=b.instagram, box=section(main,'Their Instagram',null);
  const tone=ig.status==='verified_stale_posting'?'#0f766e':ig.status==='unknown'||ig.status==='flagged'?'#8a5a10':'#46505e';
  const head=el('p',ig.label);head.style.cssText='font-weight:700;color:'+tone;box.append(head);
  box.append(el('p',ig.detail,'sub'));
  if(ig.warning)box.append(el('p',ig.warning,'hold'));
  if(ig.handle||ig.profileUrl)box.append(link(ig.handle?('@'+ig.handle):'Their profile',ig.profileUrl));
  if(ig.postUrl)box.append(link('The post we are quoting',ig.postUrl));
  if(ig.postSummary)box.append(el('p',ig.postSummary,'sub'));
  const prov=[ig.postedAt?('Last post '+new Date(ig.postedAt).toLocaleDateString()):null,
   ig.ageDays!=null?(ig.ageDays+' days ago'):null,
   ig.checkedAt?('checked '+new Date(ig.checkedAt).toLocaleString()):null,
   ig.profileConfirmedBy||null].filter(Boolean).join(' \u00b7 ');
  if(prov)box.append(el('p',prov,'sub'));
  for(const c of ig.candidates||[])box.append(link(c,c));
  if(ig.branch){
   box.append(el('p','Say this only if you are comfortable with the proof above.','sub'));
   const claim=el('p',ig.branch.claim);claim.style.cssText='font-size:12.5px;color:#8a5a10';box.append(claim);
   box.append(el('p',ig.branch.variant.label+': '+ig.branch.variant.say,'sub'));
   box.append(el('p',ig.branch.variant.delivery,'sub'));
   box.append(el('p',ig.branch.ifCorrected.label+': '+ig.branch.ifCorrected.say,'sub'));
  }
  if(ig.status!=='flagged'){
   box.append(button('Wrong profile or date',async()=>{
    const note=window.prompt('What is wrong with it? This suppresses the question for everyone.','');
    if(note==null)return;
    try{await api('/api/instagram-flag/',{email:row.recipient,note});box.append(el('p','Flagged. The question is suppressed for this prospect.','sub'));}
    catch(e){box.append(el('p','Could not save the flag: '+e.message,'hold'));}
   },'btn btn-ghost'));
  }
 }
 scripts(side,b);
 // Says plainly what was proven live and what was not. A caller should never have to guess
 // which half of the verification is fresh.
 section(main,'Why we are calling',b.staleVerification
  ?(b.staleVerification.sentTouches||4)+' sent emails and no reply were verified when the queue last synced'+(b.staleVerification.syncedAt?' at '+new Date(b.staleVerification.syncedAt).toLocaleString():'')+'. At least 48 hours have passed since email four. '+b.staleVerification.mailbox+' could not be re-read just now, so a reply sent to THAT mailbox since the sync would not be visible. Every other mailbox was checked live at '+new Date(b.checkedAt).toLocaleString()+'.'
  :'Four sent emails and no reply were verified. At least 48 hours have passed since email four. Checked '+new Date(b.checkedAt).toLocaleString());section(main,'Business context',b.fact||'No sourced business fact is recorded. Ask about their business rather than inventing a personal connection.');if(/^https?:\/\//.test(b.source?.url||''))main.append(link('Research source',b.source.url));
 const trail=details(tools,'Email history · '+b.events.length+' messages');for(const e of b.events){const message=details(trail,e.kind+' · '+new Date(e.at).toLocaleString()+' · '+e.subject);message.append(el('p',e.mailbox,'sub'));const body=el('pre',e.body);body.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;font:inherit';message.append(body);}
 const history=details(tools,'Previous calls · '+(row.callHistory||[]).length);for(const c of row.callHistory||[])history.append(el('p',new Date(c.at).toLocaleString()+' · '+c.caller+' · '+c.outcome),el('p',c.notes||'No notes'),el('p',c.nextCallAt?'Next call '+new Date(c.nextCallAt).toLocaleString():''));
 const booking=section(tools,'Book a discovery call','');
 // The known-good link goes in immediately. Whatever Calendly reports is added alongside it,
 // so a slow or empty API never leaves a caller with nothing to offer mid-conversation.
 if(b.bookingUrl)booking.append(link('Book the discovery call',b.bookingUrl,'btn'));api('/api/calendly-link/').then(j=>{const events=j.events?.filter(e=>/discovery|intro|prospect|lead/i.test(e.name))||[];for(const e of events)if(/^https:\/\//.test(e.url)&&e.url!==b.bookingUrl)booking.append(link(e.name,e.url));}).catch(()=>{/* the link above still works */});tools.append(link('Sales training and pricing reference','/training/sales/'),link('15 tasks agency owners can hand off','/blog/real-estate-photography-tasks-to-delegate/'));
 section(main,'How did it go?',null,'sub');const options=el('div',null,'outcomes');const saved=drafts.get(row.id)||{};let choice=saved.outcome||'';const labels=[['connected','Connected / interested'],['callback','Callback / gatekeeper'],['timing','Not interested: timing'],['no_answer','No answer'],['voicemail','Left voicemail'],['wrong_number','Wrong number'],['suppress','Not interested / stop']];for(const [value,label] of labels){const o=button(label,()=>{choice=value;if(value==='timing'&&Date.parse(due.value)-Date.now()<14*864e5){const d=new Date(Date.now()+90*864e5);d.setHours(10,0,0,0);due.value=new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}for(const child of options.children)child.classList.toggle('sel',child.dataset.outcome===value);},'oc'+(choice===value?' sel':''));o.dataset.outcome=value;options.append(o);}main.append(options);
 const notes=el('textarea');notes.id='call-notes';notes.value=saved.notes||'';notes.placeholder='Who answered, what they need, objections, and agreed next step';notes.setAttribute('aria-label','Call notes');notes.rows=6;const notesbox=el('div',null,'notesbox');notesbox.append(notes);main.append(notesbox);
 const due=el('input');due.id='callback-at';due.type='datetime-local';due.setAttribute('aria-label','Next call date and time');const tomorrow=new Date(Date.now()+86400000);tomorrow.setHours(10,0,0,0);due.value=saved.due||new Date(tomorrow-tomorrow.getTimezoneOffset()*60000).toISOString().slice(0,16);main.append(el('p','Next call time for no answer, voicemail or callback:','sub'),due);
 const status=el('p','','err');status.setAttribute('role','status');const save=button('Save outcome & next',async()=>{if(busy)return;if(!choice){status.textContent='Choose an outcome first.';return;}if(['callback','no_answer','voicemail','timing'].includes(choice)&&!(Date.parse(due.value)>Date.now())){status.textContent='Choose a future callback time.';return;}busy=true;save.disabled=true;for(const control of app.querySelectorAll('.queue-buttons button,.toprow button,.call-tabs button,.headrow button,.toprow select,.toprow input'))control.disabled=true;status.textContent='Saving…';stash();try{const latest=await api('/api/outreach-queue/?view=calls');const body=choice==='suppress'?{action:'suppress',email:row.recipient}:{action:'call-outcome',id:row.id,outcome:choice,notes:notes.value,nextCallAt:['callback','no_answer','voicemail','timing'].includes(choice)?new Date(due.value).toISOString():null};state=await api('/api/outreach-queue/?view=calls',{...body,expectedRevision:latest.revision});if(state&&state.nurture&&state.nurture.enrolled)status.textContent='Saved. Added to the email nurture.';const phones=new Map(latest.records.map(r=>[r.id,r.callContact]));state.records=state.records.map(r=>({...r,callContact:phones.get(r.id)}));drafts.delete(row.id);skipped.add(row.id);current=null;await showNext();}catch(e){status.textContent='Not saved: '+e.message+'. Your notes are still here.';}finally{busy=false;save.disabled=false;for(const control of app.querySelectorAll('.toprow button,.call-tabs button,.headrow button,.toprow select,.toprow input'))control.disabled=false;const list=rows(),i=list.findIndex(r=>r.id===current?.id),nav=app.querySelectorAll('.queue-buttons button');if(nav[0])nav[0].disabled=i<=0;if(nav[1])nav[1].disabled=i<0||i>=list.length-1;}},'confirmbtn');main.append(status,save);app.querySelector('.queue-nav')?.scrollIntoView({behavior:'smooth',block:'start'});}
refresh().catch(fail);
