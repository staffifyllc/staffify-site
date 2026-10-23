// The call workspace: who you are calling, what you say, what you log. One prospect at a time.
// ------------------------------------------------------------------
// Paul, 2026-10-23: "I want the rep to be able to see everything and have it run and work to its
// highest level ... schedule follow ups (those followups have visibility etc) setting tasks etc."
//
// Layout follows the dialers reps already know (Close, Nooks, Salesloft, HubSpot calling): a
// session bar with position and live counts, the person and their number on the left, the talk
// track in the middle, the disposition / notes / next step on the right, the merged history
// underneath. Every decision about time, grouping and keys lives in dialer-model.js and is tested
// there; this file only draws and talks to the API.
//
// The API contracts are unchanged: /api/outreach-queue/?view=calls for the queue (now carrying the
// caller's tasks), /api/outreach-call-brief/ for one card, POST call-outcome / suppress / task-add /
// task-done to save. Nothing here invents a number, a date or a claim.
import {orderCallQueue} from './call-queue-order.js';
import {OUTCOMES,NEEDS_TIME,outcome as outcomeOf,quickPicks,defaultNext,toLocalInput,fmtWhen,localTime,followUps,followUpCount,timeline,lastTouch,shortcut,SHORTCUTS,numberTrust} from './dialer-model.js';

const app=document.getElementById('app');
const params=new URLSearchParams(location.search);
const PIN=app.dataset.campaign||null;                      // /spearhead/ pins its campaign in the shell
let selectedCampaign=PIN||params.get('campaign')||'all';
let selectedOwner=params.get('owner')||'all', selectedIndustry=params.get('industry')||'all', research=false, search='';
let state=null, current=null, brief=null, requestId=0, busy=false, drawerOpen=false, quoToday=null;
const skipped=new Set(), dialled=new Set();
const session={started:Date.now(),saved:{},texts:0,tasks:0};

// ---- small helpers ------------------------------------------------------------------------
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
const button=(label,fn,cls='btn')=>{const b=el('button',label,cls);b.type='button';b.onclick=fn;return b;};
const link=(label,url,cls)=>{const a=el('a',label,cls);a.href=url;if(!/^tel:/.test(url)){a.target='_blank';a.rel='noopener';}return a;};
const heading=t=>el('h3',t,'dw-h');
// Hear a name said aloud by the browser's own voice. Rendered only where speech is available.
function hearButton(text){if(!text||typeof window==='undefined'||!('speechSynthesis' in window)||typeof SpeechSynthesisUtterance==='undefined')return null;
 const b=button(null,()=>{try{window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(String(text));u.lang='en-US';u.rate=0.85;window.speechSynthesis.speak(u);}catch{toast('This browser cannot read names aloud.',true);}},'btn btn-ghost dw-hear');
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','2');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');
 const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M11 5L6 9H2v6h4l5 4V5z M15.5 8.5a5 5 0 010 7 M19 6a9 9 0 010 12');svg.append(path);
 b.append(svg,el('span','Hear it'));b.title='Hear "'+text+'" said by your browser\u2019s voice. A rare name can still be said wrong.';b.setAttribute('aria-label','Hear '+text+' pronounced');return b;}
async function api(url,body){const r=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});const j=await r.json();if(!r.ok){const err=Error(j.error||'Could not load current data');err.payload=j;err.status=r.status;throw err;}return j;}
function toast(text,warn){let t=document.getElementById('toast');if(!t){t=el('div',null);t.id='toast';document.body.append(t);}t.className='dw-toast show'+(warn?' warn':'');t.textContent=text;clearTimeout(toast.t);toast.t=setTimeout(()=>{t.className='dw-toast';},9000);}
const firstName=s=>String(s||'').trim().split(/\s+/)[0]||'';
// Stored excerpts carry HTML entities from the page they were lifted from. Decoded for display only,
// and still set with textContent, so nothing here is ever interpreted as markup.
const ENT={nbsp:' ',amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',hellip:'…',mdash:'-',ndash:'-',rsquo:'\u2019',lsquo:'\u2018',rdquo:'\u201d',ldquo:'\u201c'};
const plain=s=>String(s||'').replace(/&#x([0-9a-f]+);/gi,(m,h)=>String.fromCodePoint(parseInt(h,16))).replace(/&#(\d+);/g,(m,n)=>String.fromCodePoint(Number(n))).replace(/&([a-z]+);/gi,(m,k)=>k.toLowerCase() in ENT?ENT[k.toLowerCase()]:m).replace(/\s+/g,' ').trim();
const rows=()=>orderCallQueue(state.records,{campaign:selectedCampaign,owner:selectedOwner,search,research,industry:selectedIndustry});
// A skip holds for the day. Paul, 2026-10-23: the queue "is starting every single time on the same
// prospect": a skip lived in memory, so every reload put the same card back on top. Now a skipped
// prospect stays out of this rep's queue for 24 hours and the options say how many are out.
const skipKey=()=>'staffify-dialer-skipped:'+String(state&&state.viewer||'me');
function loadSkips(){try{const m=JSON.parse(localStorage.getItem(skipKey())||'{}');const cut=Date.now()-24*3600000;skipped.clear();for(const [id,at] of Object.entries(m))if(at>cut)skipped.add(id);}catch{}}
function saveSkips(){try{const m={};for(const id of skipped)m[id]=Date.now();localStorage.setItem(skipKey(),JSON.stringify(m));}catch{}}
function skipNow(id){skipped.add(id);saveSkips();}
const positionKey=()=>`staffify-call-position:${selectedCampaign}:${selectedOwner}:${selectedIndustry}:${research}`;
function remember(id){try{sessionStorage.setItem(positionKey(),id);}catch{}}
function remembered(){try{return sessionStorage.getItem(positionKey());}catch{return null;}}
function syncUrl(){const u=new URL(location.href);if(!PIN){selectedCampaign==='all'?u.searchParams.delete('campaign'):u.searchParams.set('campaign',selectedCampaign);}selectedOwner==='all'?u.searchParams.delete('owner'):u.searchParams.set('owner',selectedOwner);selectedIndustry==='all'?u.searchParams.delete('industry'):u.searchParams.set('industry',selectedIndustry);history.replaceState(null,'',u);}

// Drafts survive a reload. Notes typed during a call are the one thing a rep cannot retype.
const draftKey=id=>'staffify-dialer-draft:'+id;
function loadDraft(id){try{return JSON.parse(localStorage.getItem(draftKey(id))||'null')||{};}catch{return {};}}
function saveDraft(id,d){try{localStorage.setItem(draftKey(id),JSON.stringify({...d,at:Date.now()}));}catch{}}
function dropDraft(id){try{localStorage.removeItem(draftKey(id));}catch{}}
function stash(){if(!current)return;const notes=document.getElementById('call-notes'),due=document.getElementById('callback-at');if(notes)saveDraft(current.id,{notes:notes.value,due:due?.value||'',outcome:document.querySelector('.dw-oc.sel')?.dataset.outcome||''});}

// ---- session bar --------------------------------------------------------------------------
const PINNED={'staffify-tobit-outreach':{eyebrow:'Spearhead accounts',h1:'CEO outreach'}};
const NAMES={'all':'All campaigns','staffify-agency-outreach':'Staffify agency outreach','staffify-tobit-outreach':'CEO b2b outreach','staffify-talent-network-outreach':'Talent network outreach'};
function myFollowUps(){return followUps({records:state?.records||[],tasks:state?.tasks||[],me:state?.viewer||'',now:Date.now()});}
function bar(){
 const list=rows(),index=list.findIndex(r=>r.id===current?.id),pin=PINNED[selectedCampaign];
 const b=el('div',null,'dw-bar');
 const title=el('div',null,'dw-title');
 title.append(el('div',pin?pin.eyebrow:'Shared call queue','dw-eyebrow'));
 const pos=el('div',null,'dw-pos');
 pos.append(document.createTextNode(list.length?`${Math.max(1,index+1)} of ${list.length}`:'Queue complete'));
 const indLabel=selectedIndustry!=='all'?((state?.records||[]).find(r=>r.industry&&r.industry.key===selectedIndustry)||{}).industry?.label||selectedIndustry:null;
 pos.append(el('small',research?'Numbers that need confirming':[(pin?pin.h1:NAMES[selectedCampaign]||selectedCampaign),indLabel].filter(Boolean).join(' · ')));
 title.append(pos);
 b.append(title);
 // Options: campaign, owner, search, the research tab, refresh. Behind one control so the bar
 // stays a bar.
 const opt=el('details',null,'dw-options');opt.append(el('summary','Queue options'));
 const body=el('div',null,'dw-optbody');
 if(!PIN){const campaign=el('select');campaign.setAttribute('aria-label','Campaign');for(const id of new Set(['all',selectedCampaign,...(state?.records||[]).map(r=>r.campaignId)])){const o=el('option',NAMES[id]||id);o.value=id;campaign.append(o);}campaign.value=selectedCampaign;campaign.onchange=()=>{stash();selectedCampaign=campaign.value;syncUrl();skipped.clear();current=null;showNext();};body.append(campaign);}
 const ownerSel=el('select');ownerSel.setAttribute('aria-label','Sales owner');for(const [label,value] of [['All sales owners','all'],['Paul','Paul'],['Madison','Madison']]){const o=el('option',label);o.value=value;ownerSel.append(o);}ownerSel.value=selectedOwner;ownerSel.onchange=()=>{stash();selectedOwner=ownerSel.value;syncUrl();skipped.clear();current=null;showNext();};
 // Industries present in this view, from the same classifier the Campaigns page uses.
 const inds=new Map();for(const r of state?.records||[])if(r.industry&&r.industry.key&&(selectedCampaign==='all'||r.campaignId===selectedCampaign))inds.set(r.industry.key,r.industry.label||r.industry.key);
 const indSel=el('select');indSel.setAttribute('aria-label','Industry');const allInd=el('option','All industries');allInd.value='all';indSel.append(allInd);for(const [k,l] of [...inds.entries()].sort((a,b)=>a[1].localeCompare(b[1]))){const o=el('option',l);o.value=k;indSel.append(o);}if(selectedIndustry!=='all'&&!inds.has(selectedIndustry)){const o=el('option',selectedIndustry);o.value=selectedIndustry;indSel.append(o);}indSel.value=selectedIndustry;indSel.onchange=()=>{stash();selectedIndustry=indSel.value;syncUrl();current=null;showNext();};
 const find=el('input');find.placeholder='Find company, email or number';find.setAttribute('aria-label','Find prospect');find.value=search;find.onchange=()=>{stash();search=find.value;showNext();};
 const tabs=el('div',null,'dw-nav');for(const [label,value] of [['Ready to call',false],['Number research',true]]){const t=button(label,()=>{stash();research=value;skipped.clear();current=null;showNext();},'btn'+(research===value?' active':''));t.setAttribute('aria-pressed',String(research===value));tabs.append(t);}
 const w=state&&state.numberWork;const held=[];if(w?.findingNumber)held.push(w.findingNumber+' having a number found automatically');if(w?.noNumberPossible)held.push(w.noNumberPossible+' where no number could be found');
 body.append(ownerSel,indSel,find,tabs,button('Refresh queue',()=>refresh().catch(fail),'btn btn-ghost'));
 if(skipped.size)body.append(button(skipped.size+' skipped today · show them again',()=>{skipped.clear();saveSkips();showNext();},'btn btn-ghost'));
 if(held.length)body.append(el('p','Held out of this queue: '+held.join(' · ')+'. Nobody is handed a card without a number.','dw-held'));
 body.append(el('p','Order: callbacks that are due, then numbers listed on the business website, then the oldest fourth email.','dw-held'));
 opt.append(body);b.append(opt);
 // Live counts. Quo is the truth for dials; the session counts what was logged here since open.
 const stats=el('div',null,'dw-stats');
 if(quoToday&&quoToday.ok){stats.append(stat(quoToday.dials,'dials today'),stat(quoToday.connected,'picked up'));}
 else if(quoToday&&quoToday.error)stats.append(el('span',quoToday.error==='no seat'?'No Quo seat for this login':'Quo unavailable'));
 const logged=Object.values(session.saved).reduce((a,n)=>a+n,0);
 stats.append(stat(logged,'logged this session'));
 if(needsOutcome()){const need=el('span','Needs an outcome','dw-badge hot');need.style.marginLeft='0';stats.append(need);}
 if(session.saved.callback)stats.append(stat(session.saved.callback,'callbacks set'));
 if(session.saved.connected)stats.append(stat(session.saved.connected,'connected'));
 b.append(stats);
 // Navigation and the follow-ups drawer.
 const nav=el('div',null,'dw-nav');
 const fu=myFollowUps(),n=followUpCount(fu);
 const fuBtn=button('Follow-ups',()=>openDrawer(),'btn btn-ghost');
 if(n){const badge=el('span',String(fu.dueNow.length||n),'dw-badge'+(fu.dueNow.length?' hot':''));badge.setAttribute('aria-label',fu.dueNow.length?fu.dueNow.length+' due now':n+' upcoming');fuBtn.append(badge);}
 fuBtn.title='F';
 const prev=button('← Previous',()=>move(-1),'btn btn-ghost'),skip=button('Skip',()=>{if(busy||!current||!leaveOk())return;skipNow(current.id);showNext();},'btn btn-ghost'),next=button('Next →',()=>move(1),'btn btn-ghost');
 prev.disabled=index<=0||busy;next.disabled=index<0||index>=list.length-1||busy;skip.disabled=!current||busy;
 prev.title='P';next.title='N';skip.title='S';
 nav.append(fuBtn,prev,skip,next);b.append(nav);
 return b;
}
function stat(n,label){const s=el('span');s.append(el('b',String(n)),document.createTextNode(label));return s;}
function needsOutcome(){return !!current&&dialled.has(current.id)&&!choice;}
function leaveOk(){if(!needsOutcome())return true;return window.confirm('You called this number and have not logged an outcome. Leave anyway?');}
function move(offset){if(busy)return;if(!leaveOk())return;const list=rows(),index=list.findIndex(r=>r.id===current?.id);const row=list[index+offset];if(row)show(row);}

// ---- loading and the empty state ----------------------------------------------------------
function fail(e){app.replaceChildren(bar(),el('div',e.message,'dw-pane dw-loading'),button('Retry',()=>refresh().catch(fail)));}
const OPEN=params.get('open')||null;let opened=false;
async function refresh(){stash();state=await api('/api/outreach-queue/?view=calls');loadSkips();
 // A deep link from My Day or the follow-ups list opens that card first, filters or not.
 if(OPEN&&!opened){opened=true;const want=(state.records||[]).find(r=>r.id===OPEN);if(want){skipped.delete(want.id);saveSkips();return show(want);}toast('That prospect is not in the call view right now.',true);}
 const row=rows().find(r=>r.id===(current?.id||remembered()));if(row)return show(row);await showNext();}
async function showNext(){const list=rows(),row=list.find(r=>!skipped.has(r.id));if(row)return show(row);current=null;brief=null;app.replaceChildren(bar());const empty=el('section',null,'dw-pane dw-empty');empty.append(el('h2',list.length?'You have reached the end':'You are caught up'),el('p',list.length?'Your skipped prospects stay out for the day. No call outcomes were changed.':research?'No prospects need number research in this view.':'No eligible prospects with a phone number are waiting in this view.'));if(list.length)empty.append(button('Show the '+list.filter(r=>skipped.has(r.id)).length+' skipped',()=>{skipped.clear();saveSkips();showNext();}));const fu=myFollowUps();if(followUpCount(fu))empty.append(button('Open your follow-ups ('+followUpCount(fu)+')',()=>openDrawer(),'btn btn-ghost'));app.append(empty);}

// ---- one prospect -------------------------------------------------------------------------
async function show(row){
 stash();current=row;brief=null;remember(row.id);const version=++requestId;
 app.classList.add('dw-wrap');app.classList.remove('call-workspace');
 const grid=el('div',null,'dw-grid');
 const who=el('section',null,'dw-pane dw-who'),talk=el('section',null,'dw-pane dw-talk'),log=el('section',null,'dw-pane dw-log'),hist=el('section',null,'dw-pane dw-hist');
 who.setAttribute('aria-label','Prospect');talk.setAttribute('aria-label','Talk track');log.setAttribute('aria-label','Log the call');hist.setAttribute('aria-label','History');
 grid.append(who,talk,log,hist);
 app.replaceChildren(bar(),grid);
 // The parts that need only the queue record draw now, so a rep can read and type while the
 // live checks run. The brief fills in the number, the script and the proof when it lands.
 renderWho(who,row,null);
 talk.append(heading('Talk track'),el('p','Checking mailboxes, the CRM, exclusions and the number…','dw-loading'));
 renderLog(log,row,null);
 renderHistory(hist,row,null);
 try{
  const b=await api('/api/outreach-call-brief/?id='+encodeURIComponent(row.id));
  if(version!==requestId)return;
  brief=b;stash();renderWho(who,row,b);renderTalk(talk,row,b);renderLog(log,row,b);renderHistory(hist,row,b);
 }catch(e){
  if(version!==requestId)return;
  if(e.payload&&e.payload.callable===false&&e.payload.recipient){renderBlocked(who,talk,log,hist,row,e.payload,e.message);return;}
  talk.replaceChildren(heading('Talk track'),el('div',e.message,'dw-due dw-alert'),button('Retry this prospect',()=>show(row)));
 }
}

// The left pane: who, where, when (their clock), the number and how far to trust it, the links,
// the research. With no brief yet it shows what the queue record knows.
function renderWho(pane,row,b){
 pane.replaceChildren();
 const p=b||{};
 const head=el('div');
 const companyName=p.company||row.company||row.recipient;const h2=el('h2',companyName,'dw-company');const hearCo=hearButton(companyName);if(hearCo)h2.append(hearCo);head.append(h2);
 const name=p.name&&p.name!==row.recipient?p.name:(row.verifiedFirstName||'');
 if(name){const who=el('div',name+(p.title?' · '+p.title:''),'dw-person');const hearWho=hearButton(name);if(hearWho)who.append(hearWho);head.append(who);
  if(p.identity&&p.identity.status==='researched')who.append(el('span','Name from '+p.identity.source+(p.identity.checkedAt?', '+new Date(p.identity.checkedAt).toLocaleDateString():''),'dw-prov'));}
 else if(b&&p.identity&&p.identity.status==='inferred'&&p.identity.askFor){const who=el('div',null,'dw-person');who.append(document.createTextNode('Ask for '+p.identity.askFor+(p.identity.title?', '+p.identity.title:'')));const hearWho=hearButton(p.identity.askFor);if(hearWho)who.append(hearWho);
  const prov=el('span','Shared inbox on file; this person was found by '+p.identity.source+(p.identity.checkedAt?', '+new Date(p.identity.checkedAt).toLocaleDateString():'')+'. ','dw-prov');if(p.identity.linkedin){prov.append(link('LinkedIn',p.identity.linkedin));}who.append(prov);head.append(who);}
 else if(b){const who=el('div',p.identity&&p.identity.status==='unknown'&&p.identity.reason?'No name on file. '+p.identity.reason:'No name on file. A lookup is queued.','dw-person dw-noname');head.append(who);}
 const meta=el('div',null,'dw-meta');
 const tag=industryTag(p.industry);if(tag)meta.append(tag);
 if(p.location)meta.append(el('span',p.location));
 meta.append(el('span',row.sentTouches+' emails · last '+new Date(row.lastSentAt).toLocaleDateString()));
 head.append(meta);
 pane.append(head);
 // Their clock, from a zone the CRM gave us. Nothing is guessed from a city name.
 const lt=localTime(p.prospectTimezone&&p.prospectTimezone.timeZone);
 if(lt){const c=el('div',null,'dw-clock');c.append(el('i',null,'dw-dot'+(lt.inHours?'':' off')),document.createTextNode(lt.time+' their time'),el('span','· '+lt.note));pane.append(c);}
 // A callback that has come due is the reason this card is on top. Say so.
 if(row.callOutcome==='callback'&&row.nextCallAt&&Date.parse(row.nextCallAt)<=Date.now()){const last=(row.callHistory||[]).slice(-1)[0]||{};const d=el('div',null,'dw-due');d.append(el('b','Callback due.'),document.createTextNode(' You agreed to call at '+new Date(row.nextCallAt).toLocaleString()+(last.notes?'. Notes: '+last.notes:'.')));pane.append(d);}
 else if(row.callOwner&&!row.mine){const d=el('div',null,'dw-due dw-info');d.append(el('b',row.callOwner),document.createTextNode(' owns this follow-up. You can still work it; the first outcome keeps its owner.'));pane.append(d);}
 // The number.
 const num=el('div',null,'dw-numblock');
 if(!b){num.append(el('div','Checking the number…','dw-numdetail'));}
 else if(p.phone){
  const trust=numberTrust(p.dial);
  num.append(link(p.phone,'tel:'+p.phone,'dw-num'));
  num.append(el('span',trust.word,'dw-trust '+trust.tone));
  if(trust.detail)num.append(el('p',trust.detail,'dw-numdetail'));
  const acts=el('div',null,'dw-actions');
  const call=link('Call now','tel:'+p.phone,'btn dw-primary');call.id='call-now';call.addEventListener('click',()=>{dialled.add(row.id);refreshBar();});
  acts.append(call,button('Copy',async()=>{try{await navigator.clipboard.writeText(p.phone);toast('Number copied.');}catch{toast('Select the number and copy it.',true);}},'btn btn-ghost'),textButton(row,p));
  num.append(acts);
  if(p.dial&&p.dial.alternates&&p.dial.alternates.length){const alts=el('div',null,'dw-alts');alts.append(el('span','Also on file:'));for(const a of p.dial.alternates)alts.append(link(a,'tel:'+a));num.append(alts);}
  if(p.dial&&p.dial.sourceUrl){const w=el('p',null,'dw-small');w.append(link('Where this number is published',p.dial.sourceUrl));num.append(w);}
  num.append(el('p','On iPhone, tap Call now and use your business line. The Hub does not detect iPhone calls; log the outcome on the right.','dw-small'));
 } else {
  num.append(el('div','No number on file','dw-trust'),el('p',(p.phoneEvidence&&p.phoneEvidence.detail)||'A number is being found automatically. Skip ahead; finding numbers is not your job.','dw-numdetail'));
 }
 pane.append(num);
 // Links.
 const links=el('div',null,'dw-links');
 const site=p.website||row.website||(row.source&&row.source.url)||null;
 if(site)links.append(link('Website',/^https?:\/\//.test(site)?site:'https://'+site));
 if(p.crmUrl)links.append(link('CRM contact',p.crmUrl));
 links.append(link('Email thread','https://mail.google.com/mail/u/?authuser='+encodeURIComponent(row.sender)+(row.threadId?'#all/'+encodeURIComponent(row.threadId):'#search/'+encodeURIComponent(row.recipient))));
 links.append(link(row.recipient,'mailto:'+row.recipient));
 pane.append(links);
 if(!b)return;
 // Why this card exists, in one line.
 pane.append(el('p',p.staleVerification
  ?(p.staleVerification.sentTouches||4)+' emails and no reply, verified at the last sync'+(p.staleVerification.syncedAt?' ('+new Date(p.staleVerification.syncedAt).toLocaleDateString()+')':'')+'. '+p.staleVerification.mailbox+' could not be re-read just now; a reply to that mailbox since then would not show here.'
  :'Four emails sent, no reply, at least 48 hours since the fourth. Checked '+new Date(p.checkedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})+'.','dw-why'));
 // Research: the sourced fact, the Instagram datapoint.
 const sec=el('div',null,'dw-sec');sec.append(heading('Research'));
 sec.append(el('p',plain(p.fact)||'No sourced business fact is recorded. Ask about their business rather than inventing a personal connection.','dw-fact'));
 if(/^https?:\/\//.test(p.source?.url||'')){const w=el('p',null,'dw-small');w.append(link('Research source',p.source.url));sec.append(w);}
 if(p.instagram)sec.append(instagramPanel(row,p.instagram));
 pane.append(sec);
}

// The text button. The server drafts the message, checks opt-outs and the never-twice rule, and
// records what consent it found. Here it is one click and a plain confirm.
function textButton(row,p){
 const btn=button('Text',async()=>{
  if(busy)return;
  if(!window.confirm('Text '+(firstName(p.name)||'them')+' at '+p.phone+' from the Staffify line? The message is drafted from the approved template and logged to the CRM.'))return;
  btn.disabled=true;btn.textContent='Sending…';
  try{
   const j=await api('/api/send-text/',{phone:p.phone,first:firstName(p.name),company:p.company||row.company||'',motion:'outreach',emails:row.sentTouches||0,email:row.recipient});
   if(j.sent){session.texts++;btn.textContent='Texted';toast('Text sent: '+(j.content||'').slice(0,140));const n=document.getElementById('call-notes');if(n&&!/Texted/.test(n.value))n.value=(n.value?n.value+'\n':'')+'Texted them after the call.';}
   else{btn.textContent='Text';btn.disabled=false;const why=TEXT_REASON[j.reason||j.error];toast('Not sent: '+(why||j.reason||j.error||'unknown'),true);}
  }catch(e){btn.textContent='Text';btn.disabled=false;toast('Could not reach the server. Nothing was sent.',true);}
 },'btn btn-ghost');
 btn.title='Send the approved text to this number';
 return btn;
}
const TEXT_REASON={opted_out:'this number replied STOP.',already_texted:'this number was already texted once; we never text twice.',no_company:'no company on the record.',no_valid_number:'that is not a textable number.',rate_limited:'the hourly cap is reached.',no_rep_name:'your name is not on your Hub profile.',not_configured:'texting is not configured on the server.',unsupportable_claim:'the message made a claim we cannot back.'};

function instagramPanel(row,ig){
 const box=el('div',null,'dw-ig');
 box.append(el('div','Instagram · '+ig.label,'dw-iglabel'),el('p',ig.detail,'dw-small'));
 if(ig.warning)box.append(el('p',ig.warning,'dw-small'));
 const l=el('div',null,'dw-links');
 if(ig.handle||ig.profileUrl)l.append(link(ig.handle?('@'+ig.handle):'Their profile',ig.profileUrl));
 if(ig.postUrl)l.append(link('The post',ig.postUrl));
 box.append(l);
 const prov=[ig.postedAt?('Last post '+new Date(ig.postedAt).toLocaleDateString()):null,ig.ageDays!=null?(ig.ageDays+' days ago'):null,ig.checkedAt?('checked '+new Date(ig.checkedAt).toLocaleDateString()):null].filter(Boolean).join(' · ');
 if(prov)box.append(el('p',prov,'dw-small'));
 if(ig.branch){box.append(el('p','If the proof above holds, you can say: '+ig.branch.variant.say,'dw-small'));box.append(el('p','If corrected: '+ig.branch.ifCorrected.say,'dw-small'));}
 if(ig.status!=='flagged')box.append(button('Wrong profile or date',async()=>{const note=window.prompt('What is wrong with it? This suppresses the question for everyone.','');if(note==null)return;try{await api('/api/instagram-flag/',{email:row.recipient,note});box.append(el('p','Flagged. The question is suppressed for this prospect.','dw-small'));}catch(e){toast('Could not save the flag: '+e.message,true);}},'btn btn-ghost'));
 return box;
}

// Industry chip, with its provenance in the tooltip so a wrong one is traceable.
const ICON={'re-media':'M3 5h18v14H3z M8 5v14 M3 10h5 M3 15h5','construction':'M3 21h18 M5 21V9l7-5 7 5v12 M10 21v-6h4v6','property':'M3 21h18 M6 21V8l6-4 6 4v13 M10 13h4v8h-4z','health':'M12 4v16 M4 12h16','finance':'M3 21h18 M5 21V9 M9 21V6 M13 21v-9 M17 21V4','software':'M8 6l-5 6 5 6 M16 6l5 6-5 6','education':'M3 9l9-5 9 5-9 5z M7 12v5c0 1 2 2 5 2s5-1 5-2v-5','marketing':'M4 10v4h3l5 4V6L7 10z M16 9a4 4 0 010 6','nonprofit':'M12 20s-7-4.5-7-9a4 4 0 017-2.5A4 4 0 0119 11c0 4.5-7 9-7 9z','legal':'M12 3v18 M5 7h14 M5 7l-2 6h4z M19 7l2 6h-4z','logistics':'M3 7h11v9H3z M14 10h4l3 3v3h-7z M7 19a2 2 0 100-4 2 2 0 000 4 M18 19a2 2 0 100-4 2 2 0 000 4','hospitality':'M7 3v8a3 3 0 006 0V3 M10 11v10 M17 3c-1.5 2-2 4-2 6s.5 3 2 3v9','home-services':'M14 7a4 4 0 00-5.5 5.5L4 17l3 3 4.5-4.5A4 4 0 0017 10','other':'M12 3a9 9 0 100 18 9 9 0 000-18 M12 8v5 M12 16h.01'};
function industryTag(ind){if(!ind||!ind.label)return null;const wrap=el('span',null,'dw-chip');const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.7');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',ICON[ind.key]||ICON.other);svg.append(path);wrap.append(svg,el('span',ind.label));wrap.title=ind.source==='CRM'?'Industry from the CRM record':ind.source==='campaign'?'This campaign is the real estate media list':'Inferred from their own website';return wrap;}

// ---- the middle pane: the talk track -------------------------------------------------------
const OBJECTIONS=[['Busy','Of course. Is there a better time for a quick call, or would you rather leave it here?'],['Already have help','That is great. What do they take care of, and is there anything that still ends up back on your plate?'],['Not hiring','Understood. I was more curious about the work that still lands on you. If everything is covered, no problem.'],['Send information','Happy to. Which part would actually be useful: customer support, account coordination, or something else?'],['How much?','It depends on the role, hours and scope. Let us work out what you need first so I can give you an accurate quote.'],['Wrong person / gatekeeper','Who handles the day-to-day operations for the business? Is there a better time to reach them?'],['Not interested / stop','Understood. Thanks for letting me know.']];
const LOGLABEL=Object.fromEntries(OUTCOMES.map(o=>[o.value,o.label]));
function renderTalk(pane,row,b){
 pane.replaceChildren(heading('Talk track'));
 pane.append(el('div','Open','dw-step'),el('p',b.opener,'dw-say'));
 if(b.reason)pane.append(el('div','Then','dw-step'),el('p',b.reason,'dw-say'));
 // The conversation branches. Each node is what to SAY; the buttons are what THEY said. A
 // terminal node names the outcome to log, and logging it from here selects it on the right.
 const stages=(b.stages&&b.stages.length)?b.stages.map(s=>[s.label,s.say]):[['Understand the work',b.questions?.[0]],['Find the bottleneck',b.questions?.[1]],['Make it useful',b.questions?.[2]],['Agree a next step',b.questions?.[3]||b.questions?.[2]]].filter(x=>x[1]);
 const tree=el('div',null,'dw-tree');
 if(b.tree&&b.tree.open){
  const path=['open'];
  const draw=()=>{
   const node=b.tree[path[path.length-1]]||{},parts=[];
   parts.push(el('div',path.length===1?'They have heard the opener. What did they say?':'What did they say?','dw-step'));
   if(node.say)parts.push(el('p',node.say,'dw-say'));
   if(node.note)parts.push(el('p',node.note,'dw-note'));
   if(node.log){
    const row2=el('div',null,'dw-choices');
    row2.append(button('Log as '+(LOGLABEL[node.log]||node.log)+' →',()=>{selectOutcome(node.log);document.getElementById('call-notes')?.focus();},'btn dw-choice win'));
    parts.push(row2);
    if(node.log==='callback'){
     // Paul, 2026-10-22: "if they select bad time can we make a task time to call them back that
     // reminds the sales person." The agreed time is picked here and the save is one click.
     const cb=el('div',null,'dw-cbk');cb.append(el('div','When should you call back?','dw-step'));
     const lt=localTime(b.prospectTimezone&&b.prospectTimezone.timeZone);if(lt)cb.append(el('p','It is '+lt.time+' their time. Times below are yours.','dw-note'));
     const picks=el('div',null,'dw-picks');for(const q of quickPicks())picks.append(button(q.label,()=>{selectOutcome('callback',q.at);const n=document.getElementById('call-notes');if(n&&!n.value.trim())n.value='Bad time. Agreed to call back '+q.at.toLocaleString()+'.';toast('Callback set for '+fmtWhen(q.at)+'. Save when you are ready, or ⌘↵.');},'btn dw-pick'));
     cb.append(picks);parts.push(cb);
    }
   }
   const nav=el('div',null,'dw-choices');
   for(const [label,to] of node.choices||[])nav.append(button(label,()=>{path.push(to);draw();},'btn dw-choice'));
   if(path.length>1)nav.append(button('Back',()=>{path.pop();draw();},'btn btn-ghost'));
   if(path.length>1&&!(node.choices||[]).length)nav.append(button('Start over',()=>{path.length=1;draw();},'btn btn-ghost'));
   parts.push(nav);
   tree.replaceChildren(...parts);
  };
  draw();
 } else if(stages.length){
  let step=0;const draw=()=>{tree.replaceChildren(el('div',`${step+1} / ${stages.length} · ${stages[step][0]}`,'dw-step'),el('p',stages[step][1],'dw-say'));const nav=el('div',null,'dw-choices');if(step)nav.append(button('Previous',()=>{step--;draw();},'btn btn-ghost'));if(step<stages.length-1)nav.append(button('Next question',()=>{step++;draw();},'btn dw-choice'));tree.append(nav);};draw();
 }
 pane.append(tree);
 // Objections and voicemail, one tap away but not in the way.
 const sec=el('div',null,'dw-sec');sec.append(heading('If they push back'));
 const chips=el('div',null,'dw-objs'),answer=el('p','','dw-say quiet dw-objsay');answer.hidden=true;const hint=el('p','','dw-note');
 const bank=(b.objections&&b.objections.length)?b.objections:OBJECTIONS.map(([label,say])=>({label,say,note:''}));
 for(const o of bank){const c=button(o.label,()=>{for(const x of chips.children)x.classList.toggle('on',x===c);answer.textContent=o.say;answer.hidden=false;hint.textContent=o.note||'';},'btn dw-obj');chips.append(c);}
 sec.append(chips,answer,hint);pane.append(sec);
 const vm=el('details');vm.append(el('summary','Voicemail'),el('p',b.voicemail||`Hi, this is ${b.callerName} with Staffify. We sent you over a few notes about the day-to-day work at ${b.company||'your business'}. Just wanted to introduce myself. You can reply to our email if a conversation would be useful. Thanks.`,'dw-say quiet'));pane.append(vm);
 if(stages.length){const full=el('details',null,'dw-script');full.append(el('summary','Full conversation script'));for(const [title,say] of stages)full.append(el('h4',title),el('p',say,'dw-say quiet'));pane.append(full);}
 // Booking links, so an interested person can be booked without leaving the card.
 const book=el('details');book.append(el('summary','Book the discovery call'));const bl=el('div',null,'dw-links');if(b.bookingUrl)bl.append(link('Book the discovery call',b.bookingUrl));bl.append(link('Sales training and pricing','/training/sales/'),link('15 tasks agency owners can hand off','/blog/real-estate-photography-tasks-to-delegate/'));book.append(bl);pane.append(book);
 api('/api/calendly-link/').then(j=>{for(const e of (j.events||[]).filter(e=>/discovery|intro|prospect|lead/i.test(e.name)))if(/^https:\/\//.test(e.url)&&e.url!==b.bookingUrl)bl.append(link(e.name,e.url));}).catch(()=>{});
}

// ---- the right pane: outcome, notes, next step, tasks ---------------------------------------
let choice='';
function selectOutcome(value,at){
 choice=value;
 for(const o of document.querySelectorAll('.dw-oc'))o.classList.toggle('sel',o.dataset.outcome===value);
 const due=document.getElementById('callback-at');
 if(due){if(at)due.value=toLocalInput(at);else if(NEEDS_TIME.includes(value)){const cur=Date.parse(due.value);const def=defaultNext(value);if(!(cur>Date.now())||value==='timing'&&cur-Date.now()<14*864e5)due.value=toLocalInput(def);}}
 const next=document.getElementById('next-step');if(next)renderNextStep(next,value);
 stash();
}
function renderLog(pane,row,b){
 pane.replaceChildren(heading('How did it go?'));
 const saved=loadDraft(row.id);choice=saved.outcome||'';
 const ocs=el('div',null,'dw-ocs');
 for(const o of OUTCOMES){const btn=button(null,()=>selectOutcome(o.value),'dw-oc'+(o.tone?' '+o.tone:'')+(choice===o.value?' sel':''));btn.dataset.outcome=o.value;btn.append(el('span',o.label));if(o.hint)btn.append(el('span',o.hint,'h'));btn.append(el('span',o.key,'k'));ocs.append(btn);}
 pane.append(ocs);
 // Next step. What it shows depends on the outcome; the time input is shared by all of them.
 const next=el('div',null,'dw-next');next.id='next-step';pane.append(next);
 const due=el('input');due.type='datetime-local';due.id='callback-at';due.className='dw-when';due.setAttribute('aria-label','Next call date and time');
 due.value=saved.due||toLocalInput(defaultNext(choice||'callback'));due.onchange=stash;
 next.append(due);
 renderNextStep(next,choice);
 // Notes, autosaved locally as they are typed.
 const notes=el('textarea');notes.id='call-notes';notes.className='dw-notes';notes.value=saved.notes||'';notes.placeholder='Who answered, what they said, what you agreed.';notes.setAttribute('aria-label','Call notes');notes.rows=4;
 const auto=el('div',saved.notes?'Draft restored':'','dw-autosave');
 notes.oninput=()=>{clearTimeout(notes.t);notes.t=setTimeout(()=>{stash();auto.textContent='Saved on this device';},400);};
 pane.append(notes,auto);
 const status=el('p','','dw-status');status.setAttribute('role','status');status.id='save-status';
 const save=button(null,()=>saveOutcome(row,b,status,save),'btn dw-save');save.id='save-outcome';save.append(document.createTextNode('Save & next'),el('kbd','⌘↵'));
 const saveline=el('div',null,'dw-saveline');saveline.append(save);pane.append(saveline,status);
 // Tasks and sends live below the save, out of the main path but one tap away.
 const more=el('div',null,'dw-more');
 more.append(heading('Add a task'));
 const task=el('div',null,'dw-task');
 const title=el('input');title.placeholder='What needs doing (send pricing, call the office manager)';title.setAttribute('aria-label','Task');
 const when=el('input');when.type='datetime-local';when.value=toLocalInput(defaultNext('callback'));when.setAttribute('aria-label','Task due');
 const tnote=el('input');tnote.placeholder='Note (optional)';tnote.setAttribute('aria-label','Task note');
 const tgo=button('Add task',async()=>{
  const t=title.value.trim();if(!t){toast('Give the task a name.',true);title.focus();return;}
  if(!(Date.parse(when.value)>Date.now()-60000)){toast('Pick a time that has not passed.',true);return;}
  tgo.disabled=true;
  try{
   const r=await api('/api/outreach-queue/?view=calls',{action:'task-add',title:t,dueAt:new Date(when.value).toISOString(),notes:tnote.value,id:row.id,company:(b&&b.company)||row.company||'',recipient:row.recipient,campaignId:row.campaignId||null,contactId:row.hubspotId||row.crmContactId||null});
   if(r.ok){session.tasks++;state.tasks=[...(state.tasks||[]),r.task];title.value='';tnote.value='';toast('Task saved for '+fmtWhen(r.task.dueAt)+(r.task.hubspot&&r.task.hubspot.ok?'. HubSpot will remind you too.':'. It is in your follow-ups; no HubSpot reminder'+(r.task.hubspot&&r.task.hubspot.reason==='no_owner'?' because no HubSpot user matches you.':'.')));refreshBar();}
   else toast('Task not saved: '+(r.reason||'unknown'),true);
  }catch(e){toast('Task not saved: '+e.message,true);}
  finally{tgo.disabled=false;}
 },'btn');
 const tr=el('div',null,'dw-taskrow');tr.append(when,tgo);
 task.append(title,tnote,tr);more.append(task);
 // "Just send me something."
 const sendSec=el('div',null,'dw-sec');sendSec.append(heading('Send'));more.append(sendSec);
 const send=el('div',null,'dw-send');
 const ov=button('Send the one-page overview',async()=>{
  if(!window.confirm('Email the Staffify overview to '+row.recipient+' now? It goes from hello@gostaffify.com with replies to '+(row.sender||'hello@gostaffify.com')+'.'))return;
  ov.disabled=true;ov.textContent='Sending…';
  try{const j=await api('/api/send-overview/',{email:row.recipient});if(j.sent){ov.textContent='Overview sent';toast('Overview sent '+new Date(j.at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})+'. Log the outcome so the follow-up is set.');const n=document.getElementById('call-notes');if(n&&!/overview/i.test(n.value))n.value=(n.value?n.value+'\n':'')+'Sent the overview.';}
   else{ov.textContent='Not sent';ov.disabled=!!j.already;toast(j.reason||'Not sent.',true);}}
  catch(e){ov.textContent='Send the one-page overview';ov.disabled=false;toast('Could not reach the server. Nothing was sent.',true);}
 },'btn');
 send.append(ov,link('Preview the overview','/assets/docs/staffify-overview.pdf','btn btn-ghost'));
 sendSec.append(send);
 const kbd=el('div',null,'dw-kbd');for(const [k,what] of SHORTCUTS){const s=el('span');s.append(el('kbd',k),document.createTextNode(what));kbd.append(s);}more.append(kbd);
 pane.append(more);
 if(b===null&&!row.callReady){/* read-only until the brief says otherwise */}
}
function renderNextStep(box,value){
 const due=box.querySelector('#callback-at');
 for(const n of [...box.children])if(n!==due)n.remove();
 const o=outcomeOf(value);
 const h=heading(o?({book:'Next step',time:'When will you call back?',retry:'Try again',later:'Ask again'})[o.next]||'Next step':'Pick an outcome');
 box.prepend(h);
 if(!o){due.hidden=true;box.append(el('p','Choose what happened and the next step appears here.','dw-nexthint'));return;}
 if(NEEDS_TIME.includes(value)){
  due.hidden=false;
  const picks=el('div',null,'dw-picks');
  for(const q of quickPicks())picks.append(button(q.label,()=>{due.value=toLocalInput(q.at);for(const x of picks.children)x.classList.toggle('on',x.textContent===q.label);stash();},'btn dw-pick'));
  box.insertBefore(picks,due);
  box.append(el('p',value==='callback'?'Saved as a callback: it returns to the top of your queue at this time and a HubSpot task reminds you if you have a HubSpot user.':value==='timing'?'A warm later. They join the email nurture and come back to you on this date.':'Retried on this date. Leave a voicemail once, then text once; three quiet attempts and the lead rests.','dw-nexthint'));
 } else {
  due.hidden=true;
  if(value==='connected'){const sent=el('div',null,'dw-picks');for(const tag of ['Meeting booked','Interested','Referred me on','Not a fit']){sent.append(button(tag,()=>{const n=document.getElementById('call-notes');if(!n)return;n.value=n.value.replace(/^\[(Meeting booked|Interested|Referred me on|Not a fit)\]\s*/,'');n.value='['+tag+'] '+n.value;for(const x of sent.children)x.classList.toggle('on',x.textContent===tag);stash();},'btn dw-pick'));}box.append(sent);}
  box.append(el('p',value==='connected'?'Book the discovery call while you have them (link in the talk track), or send the overview below. Saving hands the thread to a human for the reply.':value==='wrong_number'?'That number is retired for this person and a different one is looked for. The lead is not lost.':'They are excluded from every Staffify campaign. Use this for a clear no or a request to stop.','dw-nexthint'));
 }
}
function refreshBar(){const old=app.querySelector('.dw-bar');if(old)old.replaceWith(bar());}

// Saving. Same contract as before: re-read the queue for the revision and the latest numbers,
// post the outcome, say what the server did about the callback task, the nurture and the number.
async function saveOutcome(row,b,status,save){
 if(busy)return;
 if(!choice){status.textContent='Choose an outcome first.';status.className='dw-status';return;}
 const due=document.getElementById('callback-at'),notes=document.getElementById('call-notes');
 if(NEEDS_TIME.includes(choice)&&!(Date.parse(due.value)>Date.now())){status.textContent='Choose a time in the future.';status.className='dw-status';due.focus();return;}
 if(!b&&choice!=='suppress'){status.textContent='The live check has not finished. Wait a moment, or skip.';status.className='dw-status';return;}
 busy=true;save.disabled=true;status.textContent='Saving…';status.className='dw-status ok';stash();refreshBar();
 try{
  const latest=await api('/api/outreach-queue/?view=calls');
  const body=choice==='suppress'?{action:'suppress',email:row.recipient}:{action:'call-outcome',id:row.id,outcome:choice,notes:notes.value,nextCallAt:NEEDS_TIME.includes(choice)?new Date(due.value).toISOString():null,...(choice==='wrong_number'&&b&&b.phone?{dialled:b.phone}:{})};
  const next=await api('/api/outreach-queue/?view=calls',{...body,expectedRevision:latest.revision});
  const tasks=state.tasks;state=next;state.tasks=next.tasks||tasks||[];
  session.saved[choice]=(session.saved[choice]||0)+1;
  if(state.nurture&&state.nurture.enrolled)toast('Saved. Added to the email nurture.');
  if(state.callbackTask){const t=state.callbackTask;if(t.ok)toast('Callback saved. A HubSpot task will remind you at '+new Date(due.value).toLocaleString()+'.');else toast('Callback saved; it returns to the top of your queue at that time. No HubSpot reminder: '+(t.detail||t.reason)+'.',true);}
  if(state.wrongNumber){if(state.wrongNumber.ok)toast('Logged. That number will not be offered again for them; we are looking for another.');else toast('Logged as a wrong number, but the number could not be marked: '+state.wrongNumber.reason+'.',true);}
  if(!state.nurture&&!state.callbackTask&&!state.wrongNumber)toast('Saved: '+(LOGLABEL[choice]||choice)+'.');
  const phones=new Map(latest.records.map(r=>[r.id,r.callContact]));state.records=state.records.map(r=>({...r,callContact:phones.get(r.id)||r.callContact}));
  // A logged card leaves the queue because its state changed (callReady recomputed on the server), not because it was skipped.
  dropDraft(row.id);current=null;choice='';await showNext();
 }catch(e){status.textContent='Not saved: '+e.message+'. Your notes are still here.';status.className='dw-status';}
 finally{busy=false;save.disabled=false;refreshBar();}
}

// ---- history --------------------------------------------------------------------------------
function renderHistory(pane,row,b){
 pane.replaceChildren(heading('History'));
 const items=timeline({brief:b,row});
 pane.append(el('p',lastTouch(items),'dw-last'));
 if(!items.length){pane.append(el('p','Nothing recorded yet.','dw-small'));return;}
 const list=el('ul',null,'dw-tl');
 const draw=(n)=>{list.replaceChildren();for(const it of items.slice(0,n)){const li=el('li');li.append(el('span',({email_out:'E',email_in:'R',call:'C',text:'T'})[it.kind]||'·','dw-ic '+it.kind));const body=el('div');body.append(el('div',it.title,'t'),el('div',new Date(it.at).toLocaleString()+(it.detail?' · '+it.detail:''),'d'));if(it.body&&it.kind==='call')body.append(el('div',it.body,'n'));else if(it.body){const d=el('details');d.append(el('summary','Read the message'),el('pre',it.body));body.append(d);}li.append(body);list.append(li);}};
 draw(6);pane.append(list);
 if(items.length>6){const more=button('Show all '+items.length,()=>{draw(items.length);more.remove();},'btn btn-ghost dw-tlmore');pane.append(more);}
}

// ---- a prospect we will not call -----------------------------------------------------------
function renderBlocked(who,talk,log,hist,row,p,message){
 renderWho(who,row,{...p,phone:null,dial:null,phoneEvidence:{detail:p.crmPhone?'CRM number '+p.crmPhone+' is shown for reference only; this prospect is not callable right now.':'No number on file.'},checkedAt:new Date().toISOString(),fact:p.source&&p.source.excerpt||null,website:p.website,instagram:null});
 const alert=el('div',null,'dw-due dw-alert');alert.append(el('b','Not callable right now. '),document.createTextNode(message+' Everything on this card is from the last queue sync'+(p.syncedAt?' at '+new Date(p.syncedAt).toLocaleString():'')+'.'));
 who.prepend(alert);
 talk.replaceChildren(heading('Talk track'),el('p','No script until the live check passes. Reply, opt-out and client exclusions could not be re-checked.','dw-small'),button('Retry this prospect',()=>show(row)),button('Skip to next',()=>{skipNow(row.id);showNext();},'btn btn-ghost'));
 log.replaceChildren(heading('How did it go?'),el('p','Outcomes are off for a prospect we are not calling.','dw-small'));
 renderHistory(hist,row,{events:p.events||[]});
}

// ---- the follow-ups drawer ---------------------------------------------------------------
function openDrawer(){
 if(drawerOpen)return closeDrawer();
 drawerOpen=true;
 const scrim=el('div',null,'dw-scrim');scrim.id='dw-scrim';scrim.onclick=closeDrawer;
 const d=el('aside',null,'dw-drawer');d.id='dw-drawer';d.setAttribute('aria-label','Your follow-ups');
 const head=el('div',null,'dw-dhead');const t=el('div');t.append(el('h2','Your follow-ups'),el('p','Callbacks you promised and tasks you set. Due ones go to the top of your queue on their own.','dw-dsub'));head.append(t,button('Close',closeDrawer,'btn btn-ghost'));d.append(head);
 const fu=myFollowUps();
 const groups=[['Due now',fu.dueNow,true],['Later today',fu.today],['This week',fu.upcoming],['Later',fu.later]];
 let any=false;
 for(const [label,items,hot] of groups){if(!items.length)continue;any=true;const g=el('div',null,'dw-group');const h=el('h3',label);h.append(el('b',String(items.length)));g.append(h);for(const it of items)g.append(followUpRow(it,hot));d.append(g);}
 if(!any)d.append(el('p','Nothing scheduled. A callback or a task you set from a card shows up here.','dw-fuempty'));
 document.body.append(scrim,d);
}
function closeDrawer(){drawerOpen=false;document.getElementById('dw-scrim')?.remove();document.getElementById('dw-drawer')?.remove();}
function followUpRow(it,hot){
 const r=el('div',null,'dw-fu'+(hot?' hot':''));r.setAttribute('role','button');r.tabIndex=0;
 r.append(el('div',it.company||it.recipient||'Task','c'));
 const at=el('div',fmtWhen(it.at),'at'+(Date.parse(it.at)<=Date.now()?' over':''));r.append(at);
 r.append(el('div',(it.kind==='task'?it.title+(it.notes?' · '+it.notes:''):(LOGLABEL[it.outcome]||it.outcome)+(it.note?' · '+it.note:'')).slice(0,220),'w'));
 r.append(el('span',it.kind==='task'?'Task'+(it.hubspot&&it.hubspot.ok?' · in HubSpot':''):'Callback','tag'+(it.kind==='task'?' task':'')));
 const open=()=>{if(!it.recordId)return;const row=(state.records||[]).find(x=>x.id===it.recordId);if(!row){toast('That prospect is not in the call view right now.',true);return;}closeDrawer();if(row.campaignId&&!PIN&&selectedCampaign!=='all'&&selectedCampaign!==row.campaignId){selectedCampaign='all';syncUrl();}search='';show(row);};
 r.onclick=open;r.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}};
 if(it.kind==='task'){const done=el('div',null,'done');const btn=button('Done',async e=>{e.stopPropagation();btn.disabled=true;try{const res=await api('/api/outreach-queue/?view=calls',{action:'task-done',taskId:it.taskId});if(res.ok){state.tasks=(state.tasks||[]).map(t=>t.id===it.taskId?res.task:t);r.remove();refreshBar();toast('Done.');}else toast('Could not update the task: '+res.reason,true);}catch(err){toast('Could not update the task: '+err.message,true);}finally{btn.disabled=false;}},'btn btn-ghost');done.append(btn);r.append(done);}
 return r;
}

// ---- keyboard -------------------------------------------------------------------------------
document.addEventListener('keydown',e=>{
 const s=shortcut(e);if(!s)return;
 if(s.type==='escape'){if(drawerOpen){closeDrawer();e.preventDefault();}return;}
 if(busy)return;
 if(s.type==='save'){const b=document.getElementById('save-outcome');if(b){e.preventDefault();b.click();}return;}
 if(drawerOpen&&s.type!=='followups')return;
 e.preventDefault();
 if(s.type==='outcome'&&current&&document.querySelector('.dw-oc'))selectOutcome(s.value);
 else if(s.type==='next')move(1);
 else if(s.type==='prev')move(-1);
 else if(s.type==='skip'&&current){if(leaveOk()){skipNow(current.id);showNext();}}
 else if(s.type==='followups')openDrawer();
 else if(s.type==='call'){const c=document.getElementById('call-now');if(c)c.click();}
});

// ---- today's dials, from Quo, for the bar ---------------------------------------------------
async function loadQuo(){
 try{const j=await api('/api/quo-activity/?days=1');const r=(j.reps||[])[0];quoToday=r?{ok:true,dials:r.dials||0,connected:r.connected||0}:{error:'no calls read'};}
 catch(e){quoToday={error:e.status===404?'no seat':'unavailable'};}
 refreshBar();
}

app.classList.add('dw-wrap');
app.textContent='';app.append(el('div','Loading your call queue…','dw-pane dw-loading'));
refresh().catch(fail);
loadQuo();setInterval(loadQuo,120000);
