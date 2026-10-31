import {emailCompose} from './dialer-email.js';
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
import {orderCallQueue,queueMix,searchRecords} from './call-queue-order.js';
import {OUTCOMES,NEEDS_TIME,outcome as outcomeOf,quickPicks,defaultNext,toLocalInput,fmtWhen,localTime,followUps,followUpCount,timeline,lastTouch,shortcut,SHORTCUTS,numberTrust,dripLine,nurtureNote} from './dialer-model.js';

const app=document.getElementById('app');
const params=new URLSearchParams(location.search);
const PIN=app.dataset.campaign||null;                      // /spearhead/ pins its campaign in the shell
let selectedCampaign=PIN||params.get('campaign')||'all';
let selectedOwner=params.get('owner')||'all', selectedIndustry=params.get('industry')||'all', research=false, search='';
let state=null, current=null, brief=null, requestId=0, busy=false, drawerOpen=false, quoToday=null, whoPane=null;
let searchText='';                                         // the search bar's text, kept across bar redraws
// Paul, 2026-10-27: "its still showing me like 780 people to call, but thats not true, it should be followed
// if my guys are already doing it I shouldn't be". An owner's dialer holds their own follow-ups; the shared
// pool the reps work is the Team pool, opened on purpose. A caller's queue is unchanged.
let teamPool=params.get('pool')==='team';
// The Paused area: owned callbacks on a paused campaign (real estate media), kept for review, never default work.
let pausedView=params.get('pool')==='paused';
const pausedCount=()=>(state&&state.records||[]).filter(r=>r.pausedFollowUp).length;
const ownerView=()=>!!(state&&state.viewerOwner);
let names={};                                              // record id -> contact name from HubSpot, for search
const skipped=new Set(), dialled=new Set();
// The number the rep last tapped on each card, so an outcome (a stop above all) is recorded on the line they spoke on.
const tapped=new Map();
const session={started:Date.now(),saved:{},texts:0,tasks:0};

// ---- small helpers ------------------------------------------------------------------------
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
const button=(label,fn,cls='btn')=>{const b=el('button',label,cls);b.type='button';b.onclick=fn;return b;};
const link=(label,url,cls)=>{const a=el('a',label,cls);a.href=url;if(!/^(tel|openphone):/.test(url)){a.target='_blank';a.rel='noopener';}return a;};
// Paul, 2026-10-28: "we need to be able to click the number and go right to openphone to dial, with all reps!" On a
// phone, Quo's own link opens Quo and dials. On a computer Quo answers tel: links once it is the default calling app
// (Quo's desktop and web apps do not take its own links), so the card says how to set that up, once per rep.
const PHONE_UA=/iPhone|iPad|iPod|Android/i.test((typeof navigator!=='undefined'&&navigator.userAgent)||'');
const dialHref=n=>{const d=String(n||'').replace(/[^+\d]/g,'');return PHONE_UA?'openphone://dial?number='+encodeURIComponent(d)+'&action=call':'tel:'+d;};
const QUO_KEY='staffify-dialer-quo-setup';
const heading=t=>el('h3',t,'dw-h');
// Hear a name said aloud by the browser's own voice. Rendered only where speech is available.
// Paul, 2026-10-28: "madisons Ai voice "hear it" is totally fucked, it sounds demonic". Left to itself the browser
// can pick one of the Mac's novelty voices (Bad News, Zarvox, Whisper...) or an old robotic one, and it was slowed to
// 0.85. Now a natural voice is chosen by name, novelty and robotic voices never are, and it speaks at normal speed.
const NOVELTY_VOICE=/^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|princess|grandma|grandpa|rocko|eddy|flo|reed|sandy|shelley)\b/i;
const GOOD_VOICES=[/google us english/i,/microsoft (aria|jenny|ava|andrew|emma|brian|guy|michelle).*(natural|online)/i,/\b(ava|samantha|allison|susan|zoe|evan|nathan|joelle|noelle|tom)\b.*\((premium|enhanced)\)/i,/^(samantha|ava|allison|susan|alex|tom|nicky)\b/i,/microsoft (zira|david|mark)/i,/google uk english/i];
function bestVoice(){
 const all=(window.speechSynthesis.getVoices&&window.speechSynthesis.getVoices())||[];
 const ok=all.filter(v=>/^en([-_]|$)/i.test(v.lang||'')&&!NOVELTY_VOICE.test(v.name||''));
 for(const re of GOOD_VOICES){const v=ok.find(x=>re.test(x.name)&&/en[-_]US/i.test(x.lang))||ok.find(x=>re.test(x.name));if(v)return v;}
 return null;}
// Voices load after the page in Chrome: ask early, and wait briefly for them on the first click.
const voicesReady=()=>new Promise(res=>{try{if((window.speechSynthesis.getVoices()||[]).length)return res();const t=setTimeout(res,1200);window.speechSynthesis.addEventListener?.('voiceschanged',()=>{clearTimeout(t);res();},{once:true});}catch{res();}});
try{if(typeof window!=='undefined'&&window.speechSynthesis&&window.speechSynthesis.getVoices)window.speechSynthesis.getVoices();}catch{}
function hearButton(text){if(!text||typeof window==='undefined'||!('speechSynthesis' in window)||typeof SpeechSynthesisUtterance==='undefined')return null;
 const b=button(null,async()=>{try{await voicesReady();const v=bestVoice();if(!v){toast('This browser has no natural voice installed, so the name is not read out. Chrome or Edge have one.',true);return;}window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(String(text));u.voice=v;u.lang=v.lang||'en-US';u.rate=1;u.pitch=1;window.speechSynthesis.speak(u);}catch{toast('This browser cannot read names aloud.',true);}},'btn btn-ghost dw-hear');
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
// A card another rep has open, is calling or just called is out of everyone else's queue (live holds below).
// A card this rep owns (their callback or retry) is always theirs to see, whatever a teammate logged on it.
// A queue that failed to load has no rows: the error page draws the bar too, and must not throw on it.
const rows=()=>!state?[]:orderCallQueue(pausedView?state.records.filter(r=>r.pausedFollowUp).map(r=>({...r,dueForMe:true})):state.records.filter(r=>!r.pausedFollowUp&&(ownerView()&&!teamPool?r.mine:true)&&(!heldByOther(r.id)||r.mine||(current&&current.id===r.id&&!refused.has(r.id)))),{campaign:selectedCampaign,owner:selectedOwner,search,research,industry:selectedIndustry});

// ---- live holds: who has which card -------------------------------------------------------
// Paul, 2026-10-27: "after that person's called, it should be removed from the database. Otherwise,
// it's going to be impossible to have multiple sales reps in here working at the same time ... my
// numbers are also changing and going down too." A called card already left everyone else's pile
// once its outcome was saved, but only at their next reload, and two reps could open the same first
// card and both dial it. Now opening a card holds it, Call now holds it longer, a saved outcome marks
// it called, and every dialer reads the holds every 30 seconds (api/_call-holds.js). Coordination,
// not a gate: if holds cannot be read, the queue works as before.
let holds={},holdId=null,holdKind='open',shownAt=0;
const refused=new Set();   // cards a teammate had when this dialer tried to hold them, until the next poll
const meEmail=()=>String(state&&state.viewer||'').toLowerCase();
function heldByOther(id){const h=holds[id];return !!h&&String(h.by||'').toLowerCase()!==meEmail()&&(h.untilLocal||Date.parse(h.until))>Date.now();}
async function loadHolds(){try{const j=await api('/api/call-hold/');const now=Date.now();holds={};for(const [id,h] of Object.entries(j.holds||{}))holds[id]={...h,untilLocal:typeof h.ms==='number'?now+h.ms:Date.parse(h.until)};refused.clear();}catch{/* the queue still works without them */}}
function holdPost(body){try{return fetch('/api/call-hold/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'same-origin',keepalive:true}).then(r=>r.json()).catch(()=>null);}catch{return Promise.resolve(null);}}
async function holdCard(id,kind){const r=await holdPost({action:'hold',id,kind});if(r&&r.ok&&r.hold)holds[id]=r.hold;else if(r&&r.ok===false&&r.heldBy){holds[id]={by:'someone-else',...r.heldBy};refused.add(id);}return r;}
function releaseCard(id){if(!id||refused.has(id))return;const h=holds[id];if(h&&String(h.by||'').toLowerCase()===meEmail()&&h.kind==='open')delete holds[id];holdPost({action:'release',id});}
function othersWorking(){const now=Date.now(),names=new Set();for(const h of Object.values(holds))if(h&&String(h.by||'').toLowerCase()!==meEmail()&&h.kind!=='called'&&Date.parse(h.until)>now)names.add(h.name||'Someone');return [...names];}

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
const NAMES={'all':'All campaigns','staffify-hiring-intent':'Hiring now','staffify-agency-outreach':'Staffify agency outreach','staffify-tobit-outreach':'CEO b2b outreach','staffify-talent-network-outreach':'Talent network outreach'};
function myFollowUps(){return followUps({records:state?.records||[],tasks:state?.tasks||[],me:state?.viewer||'',now:Date.now()});}
// ---- search ---------------------------------------------------------------------------------
// Milton, 2026-10-27: "I dont have a search bar to find that lead", and Paul: "it also needs a
// searchbar". Always on the bar, results as you type, across every prospect this rep can see
// (callbacks not yet due, people already called, any campaign). Picking one opens their card.
const fmtPhone=p=>{const d=String(p||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');return d.length===10?'('+d.slice(0,3)+') '+d.slice(3,6)+'-'+d.slice(6):'';};
function hitStatus(r){
 const last=(r.callHistory||[]).slice(-1)[0];
 if(!last)return 'Not called yet';
 const next=['callback','gatekeeper','timing'].includes(r.callOutcome)&&r.nextCallAt?' · next call '+fmtWhen(r.nextCallAt):'';
 return (LOGLABEL[last.outcome]||last.outcome)+' '+new Date(last.at).toLocaleDateString([],{month:'short',day:'numeric'})+next+(r.callOwner&&!r.mine?' · '+String(r.callOwner).split('@')[0]:'');
}
function openFound(row){
 if(current&&current.id!==row.id&&!leaveOk())return;
 if(row.campaignId&&!PIN&&selectedCampaign!=='all'&&selectedCampaign!==row.campaignId){selectedCampaign='all';syncUrl();}
 searchText='';skipped.delete(row.id);saveSkips();show(row);
}
// Paul, 2026-10-27, searching (404) 550-5181: "search bars not working, who is this person??" It was
// Nick at Realkit calling Milton back from his own phone. No card carries a number like that, so the
// server looks in Quo and HubSpot and names the likely prospect (api/number-lookup.js).
let lookupSeq=0,lookupTimer=null;
const whenShort=iso=>{const d=new Date(iso);return isNaN(d)?'':d.toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});};
function callLine(c){
 const mins=c.seconds>=60?Math.round(c.seconds/60)+' min':c.seconds+' sec';
 const who=c.by?(c.direction==='incoming'?(c.answered?' · answered by '+c.by:' · missed'):' · by '+c.by):(c.direction==='incoming'&&!c.answered?' · missed':'');
 return (c.direction==='incoming'?'Called in':'Called out')+' '+whenShort(c.at)+' · '+mins+who+(c.line?' · '+c.line:'');
}
function lookupNumber(d,out,text){
 const seq=++lookupSeq;
 const wait=el('p','Checking Quo calls and HubSpot for this number…','dw-noresult');out.append(wait);
 clearTimeout(lookupTimer);
 lookupTimer=setTimeout(async()=>{
  let j;try{j=await api('/api/number-lookup/?phone='+d);}catch(e){j={error:e.message};}
  if(seq!==lookupSeq||searchText.trim()!==text||!out.isConnected)return;
  wait.remove();
  const box=el('div',null,'dw-lookup');
  if(j.error){box.append(el('p','Quo and HubSpot could not be checked just now ('+j.error+').','dw-noresult'));out.append(box);return;}
  const open=(id,label,sub,note)=>{const row=(state.records||[]).find(r=>r.id===id);const b=button(null,()=>{if(row)openFound(row);},'dw-hit');b.append(el('b',label));if(sub)b.append(el('span',sub,'dw-hit-sub'));if(note)b.append(el('span',note,'dw-hit-note'));if(!row){b.disabled=true;b.title='Not in your call view';}return b;};
  for(const c of j.onCard||[])box.append(open(c.recordId,c.company,'This number is on their card or in their notes'));
  for(const l of j.likely||[])box.append(open(l.recordId,'Likely '+l.company,l.reason,l.note?'Their last note: '+l.note:null));
  if(j.hubspot&&j.hubspot.status==='found'){const h=j.hubspot;const label='HubSpot: '+[h.name,h.company].filter(Boolean).join(', ');if(h.recordId)box.append(open(h.recordId,label,h.email));else box.append(el('p',label+(h.email?' · '+h.email:''),'dw-lookup-line'));}
  else if(j.hubspot&&j.hubspot.status==='failed')box.append(el('p','HubSpot could not be checked'+(j.hubspot.why?' ('+j.hubspot.why+')':'')+'.','dw-lookup-line'));
  else box.append(el('p','No HubSpot contact found with this number (exact match only; a number stored in another format may not show).','dw-lookup-line'));
  if((j.calls||[]).length){box.append(el('p','In Quo','dw-lookup-head'));for(const c of j.calls.slice(0,4))box.append(el('p',callLine(c),'dw-lookup-line'));}
  else box.append(el('p',j.quo&&j.quo.ok===false?'Quo could not be read'+(j.quo.why?' ('+j.quo.why+')':'')+'.':'No calls with this number in Quo.','dw-lookup-line'));
  if(j.quo&&j.quo.ok===false&&(j.calls||[]).length)box.append(el('p',j.quo.why,'dw-lookup-line'));
  out.append(box);
 },350);
}
// Contact names live in HubSpot, not on the cards (89 of 870 carry one). Read once per load, quietly:
// search works without them, and gets names the moment they arrive.
async function loadNames(){try{const j=await api('/api/prospect-names/');names=j.names||{};const q=document.getElementById('dw-search');if(q&&searchText.trim().length>=2&&typeof q.oninput==='function')q.oninput();}catch{}}
function searchBox(){
 const box=el('div',null,'dw-search');
 const q=el('input');q.id='dw-search';q.type='search';q.autocomplete='off';q.spellcheck=false;q.value=searchText;
 q.placeholder='Search a name, company or number, in any mix';q.setAttribute('aria-label','Search all prospects');q.title='Press / to search';
 const out=el('div',null,'dw-results');out.setAttribute('role','listbox');out.setAttribute('aria-label','Search results');
 const draw=()=>{
  out.replaceChildren();const text=searchText.trim();if(text.length<2){out.hidden=true;return;}
  const hits=searchRecords(state&&state.records||[],text,{names});out.hidden=false;
  const numberish=/^[\d\s()+.-]+$/.test(text);
  if(!hits.length&&numberish&&text.replace(/\D/g,'').length<3){out.append(el('p','Type at least three digits to search numbers.','dw-noresult'));return;}
  // Off shift the numbers are not in the browser at all (the shift gate), so say so instead of "no match".
  if(!hits.length&&numberish&&(state&&state.records||[]).some(r=>r.callContact&&r.callContact.phone==='withheld')){out.append(el('p','Numbers are hidden until your shift is running. Start your shift to search by number.','dw-noresult'));return;}
  if(!hits.length){
   out.append(el('p','No prospect card has "'+text+'".','dw-noresult'));
   // A whole phone number on no card: someone who called in, or a direct line. Ask who it is.
   const d=text.replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
   if(/^[\d\s()+.-]+$/.test(text)&&d.length===10)lookupNumber(d,out,text);
   return;}
  for(const h of hits){const r=h.record;
   const hit=button(null,()=>openFound(r),'dw-hit');hit.setAttribute('role','option');
   hit.append(el('b',r.company||r.recipient),el('span',[h.name,r.recipient,fmtPhone((r.callContact&&r.callContact.phone)||r.phone)].filter(Boolean).join(' · '),'dw-hit-sub'),el('span',hitStatus(r),'dw-hit-sub'));
   if(h.note)hit.append(el('span','Note: '+h.note.slice(0,120),'dw-hit-note'));
   out.append(hit);}
  if(hits.total>hits.length)out.append(el('p','Showing '+hits.length+' of '+hits.total+'. Add a name, company or more digits to narrow it.','dw-noresult'));
 };
 q.oninput=()=>{searchText=q.value;draw();};
 q.onkeydown=e=>{if(e.key==='Enter'){const first=out.querySelector('.dw-hit');if(first){e.preventDefault();first.click();}}else if(e.key==='Escape'){e.preventDefault();searchText='';q.value='';draw();q.blur();}};
 box.append(q,out);draw();
 return box;
}

function bar(){
 const list=rows(),index=list.findIndex(r=>r.id===current?.id),pin=PINNED[selectedCampaign];
 const b=el('div',null,'dw-bar');
 const title=el('div',null,'dw-title');
 title.append(el('div',pin?pin.eyebrow:pausedView?'Paused: real estate media':ownerView()?(teamPool?'Team pool':'Your follow-ups'):'Shared call queue','dw-eyebrow'));
 const pos=el('div',null,'dw-pos');
 pos.append(document.createTextNode(list.length?`${Math.max(1,index+1)} of ${list.length}`:'Queue complete'));
 const indLabel=selectedIndustry!=='all'?((state?.records||[]).find(r=>r.industry&&r.industry.key===selectedIndustry)||{}).industry?.label||selectedIndustry:null;
 pos.append(el('small',research?'Numbers that need confirming':[(pin?pin.h1:NAMES[selectedCampaign]||selectedCampaign),indLabel].filter(Boolean).join(' · ')));
 // What the queue holds, so it is plain that it remembers who was called: callbacks due, leads
 // nobody has called, and people who did not pick up, who wait at the back.
 if(!research&&list.length){const m=queueMix(list),parts=[];if(m.callback)parts.push(m.callback+(m.callback===1?' callback due':' callbacks due'));if(m.later)parts.push(m.later+' "not now" due');parts.push(m.new+' new from the team pool');if(m.retry)parts.push(m.retry+' of your own to try again');const dn=state&&state.dailyNew;if(dn&&dn.used>=dn.cap)parts.push(`your ${dn.cap} new for today are done; the rest stay with the team`);else if(dn)parts.push(`${dn.used} of your ${dn.cap} new today`);pos.append(el('small',parts.join(' · '),'dw-mix'));}
 title.append(pos);
 b.append(title,searchBox());
 // The Paused area, for whoever owns paused callbacks: kept, labelled, opened only on purpose.
 if(!PIN&&(pausedCount()||pausedView)){const pz=button(pausedView?'Back to the queue':'Paused · '+pausedCount(),()=>{pausedView=!pausedView;const u=new URL(location.href);pausedView?u.searchParams.set('pool','paused'):u.searchParams.delete('pool');history.replaceState(null,'',u);current=null;showNext();},'btn btn-ghost dw-poolbtn');pz.id='dw-paused';pz.title='Callbacks on real estate media, which Paul paused on Oct 27. Kept for reference, not your work.';b.append(pz);}
 if(ownerView()&&!PIN){const pool=(state.records||[]).filter(r=>r.unclaimed&&!heldByOther(r.id)).length;const sw=button(teamPool?'Back to your follow-ups':'Team pool · '+pool+' unclaimed',()=>{teamPool=!teamPool;const u=new URL(location.href);teamPool?u.searchParams.set('pool','team'):u.searchParams.delete('pool');history.replaceState(null,'',u);current=null;showNext();},'btn btn-ghost dw-poolbtn');sw.id='dw-pool';b.append(sw);}
 // Options: campaign, owner, search, the research tab, refresh. Behind one control so the bar
 // stays a bar.
 const opt=el('details',null,'dw-options');opt.append(el('summary','Queue options'));
 const body=el('div',null,'dw-optbody');
 if(!PIN){const campaign=el('select');campaign.setAttribute('aria-label','Campaign');for(const id of new Set(['all',selectedCampaign,...(state?.records||[]).map(r=>r.campaignId)])){const o=el('option',NAMES[id]||id);o.value=id;campaign.append(o);}campaign.value=selectedCampaign;campaign.onchange=()=>{stash();selectedCampaign=campaign.value;syncUrl();skipped.clear();current=null;showNext();};body.append(campaign);}
 const ownerSel=el('select');ownerSel.setAttribute('aria-label','Sales owner');for(const [label,value] of [['All sales owners','all'],['Paul','Paul'],['Madison','Madison']]){const o=el('option',label);o.value=value;ownerSel.append(o);}ownerSel.value=selectedOwner;ownerSel.onchange=()=>{stash();selectedOwner=ownerSel.value;syncUrl();skipped.clear();current=null;showNext();};
 // Industries present in this view, from the same classifier the Campaigns page uses.
 const inds=new Map();for(const r of state?.records||[])if(r.industry&&r.industry.key&&(selectedCampaign==='all'||r.campaignId===selectedCampaign))inds.set(r.industry.key,r.industry.label||r.industry.key);
 const indSel=el('select');indSel.setAttribute('aria-label','Industry');const allInd=el('option','All industries');allInd.value='all';indSel.append(allInd);for(const [k,l] of [...inds.entries()].sort((a,b)=>a[1].localeCompare(b[1]))){const o=el('option',l);o.value=k;indSel.append(o);}if(selectedIndustry!=='all'&&!inds.has(selectedIndustry)){const o=el('option',selectedIndustry);o.value=selectedIndustry;indSel.append(o);}indSel.value=selectedIndustry;indSel.onchange=()=>{stash();selectedIndustry=indSel.value;syncUrl();current=null;showNext();};
 const tabs=el('div',null,'dw-nav');for(const [label,value] of [['Ready to call',false],['Number research',true]]){const t=button(label,()=>{stash();research=value;skipped.clear();current=null;showNext();},'btn'+(research===value?' active':''));t.setAttribute('aria-pressed',String(research===value));tabs.append(t);}
 const w=state&&state.numberWork;const held=[];if(w?.findingNumber)held.push(w.findingNumber+' having a number found automatically');if(w?.noNumberPossible)held.push(w.noNumberPossible+' where no number could be found');
 body.append(ownerSel,indSel,tabs,button('Refresh queue',()=>refresh().catch(fail),'btn btn-ghost'));
 if(skipped.size)body.append(button(skipped.size+' skipped today · show them again',()=>{skipped.clear();saveSkips();showNext();},'btn btn-ghost'));
 if(held.length)body.append(el('p','Held out of this queue: '+held.join(' · ')+'. Nobody is handed a card without a number.','dw-held'));
 body.append(el('p','Order: callbacks that are due, then "not now" that has come due, then leads nobody has called (numbers from their own website first), then people who did not pick up, fewest tries first.','dw-held'));
 opt.append(body);b.append(opt);
 // Live counts. Quo is the truth for dials; the session counts what was logged here since open.
 const stats=el('div',null,'dw-stats');
 // Quo's "answered" includes voicemail and phone menus, so it is not shown as picked up.
 if(quoToday&&quoToday.ok){stats.append(stat(quoToday.dials,'dials today'));}
 else if(quoToday&&quoToday.error)stats.append(el('span',quoToday.error==='no seat'?'No Quo seat for this login':'Quo unavailable'));
 // Who else is on THIS lead, and only this lead (Paul, 2026-10-28: Madison's name showed on every card because the line
 // listed anyone with the dialer open). Who is in the dialer at all is on the owner's own screen.
 const onCard=current&&holds[current.id];if(onCard&&heldByOther(current.id)&&onCard.kind!=='called'){const w=el('span',null,'dw-live');w.append(el('i',null,'dw-dot'),document.createTextNode((onCard.name||'Someone')+(onCard.kind==='calling'?' is calling them now':' has this card open')));stats.append(w);}
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
// Back from connecting Gmail (api/outreach-connect.js adds ?gmail=connected, or the reason it failed).
const GMAIL=params.get('gmail')||null;
function backFromGoogle(row){try{const u=new URL(location.href);u.searchParams.delete('gmail');history.replaceState(null,'',u);}catch{}
 toast(GMAIL==='connected'?'Gmail connected. Your email is ready to send.':'Gmail was not connected: '+GMAIL,GMAIL!=='connected');
 if(current&&current.id===row.id)openMail(row,brief||{});}
async function refresh(){stash();state=await api('/api/outreach-queue/?view=calls');loadSkips();await loadHolds();
 // A deep link from My Day or the follow-ups list opens that card first, filters or not.
 if(OPEN&&!opened){opened=true;const want=(state.records||[]).find(r=>r.id===OPEN);if(want){skipped.delete(want.id);saveSkips();await show(want);if(GMAIL)backFromGoogle(want);return;}toast('That prospect is not in the call view right now.',true);}
 const row=rows().find(r=>r.id===(current?.id||remembered()));if(row)return show(row,{auto:!current});await showNext();}
// Paul, 2026-10-28: "madison and I are cross polinating meaning she is seeing leads that I am seeing". A card picked for
// you is held on the server BEFORE it is shown, so two reps never both have the same next card on screen: whoever
// loses the hold goes straight to the next one. Your own follow-ups need no hold to be yours.
async function showNext(){const list=rows();for(const row of list.filter(r=>!skipped.has(r.id)&&!refused.has(r.id))){if(row.mine)return show(row,{auto:true});const r=await holdCard(row.id,'open');if(r&&r.ok===false)continue;return show(row,{auto:true,held:!!(r&&r.ok)});}
 if(holdId&&holdKind==='open')releaseCard(holdId);holdId=null;
 if(pausedView){current=null;brief=null;app.replaceChildren(bar());const e=el('section',null,'dw-pane dw-empty');e.append(el('h2','No paused callbacks'),el('p','Nothing of yours is on a paused campaign.'));app.append(e);return;}
 if(ownerView()&&!teamPool&&!PIN){current=null;brief=null;app.replaceChildren(bar());const pool=(state.records||[]).filter(r=>r.unclaimed&&!heldByOther(r.id)).length,others=othersWorking();const e=el('section',null,'dw-pane dw-empty');e.append(el('h2','No follow-ups of yours'),el('p',pool+' unclaimed in the team pool'+(others.length?'. In the dialer now: '+others.join(', ')+'.':'.')+' Your reps work those; nothing here is waiting on you. A caller\'s own list also has their follow-ups, so it reads higher.'),button('Open the team pool',()=>{teamPool=true;const u=new URL(location.href);u.searchParams.set('pool','team');history.replaceState(null,'',u);showNext();},'btn'));app.append(e);return;}current=null;brief=null;app.replaceChildren(bar());const empty=el('section',null,'dw-pane dw-empty');empty.append(el('h2',list.length?'You have reached the end':'You are caught up'),el('p',list.length?'Your skipped prospects stay out for the day. No call outcomes were changed.':research?'No prospects need number research in this view.':'No eligible prospects with a phone number are waiting in this view.'));if(list.length)empty.append(button('Show the '+list.filter(r=>skipped.has(r.id)).length+' skipped',()=>{skipped.clear();saveSkips();showNext();}));const fu=myFollowUps();if(followUpCount(fu))empty.append(button('Open your follow-ups ('+followUpCount(fu)+')',()=>openDrawer(),'btn btn-ghost'));app.append(empty);}

// ---- one prospect -------------------------------------------------------------------------
async function show(row,{auto=false,held=false}={}){
 // Let go of the last card if it was only open; hold this one. Picked for you and somebody else got
 // there first: move on. Opened on purpose (search, a follow-up): say who has it, and stay.
 if(holdId&&holdId!==row.id&&holdKind==='open')releaseCard(holdId);
 holdId=row.id;holdKind='open';shownAt=Date.now();
 (held?Promise.resolve(null):holdCard(row.id,'open')).then(r=>{if(!r||r.ok!==false||!r.heldBy||!current||current.id!==row.id)return;
  if(holdId===row.id)holdId=null;
  if(auto){current=null;showNext();return;}
  toast(r.heldBy.kind==='called'?r.heldBy.name+' just called them.':r.heldBy.name+' has this card open right now. Pick another unless you two agreed.',true);});
 closeMail();stash();current=row;
 if(pausedView)setTimeout(()=>toast('Paused campaign: real estate media. Paul stopped this outreach on Oct 27. This callback is kept for reference; check with Paul before calling.',true),0);brief=null;remember(row.id);const version=++requestId;
 app.classList.add('dw-wrap');app.classList.remove('call-workspace');
 const grid=el('div',null,'dw-grid');
 const who=el('section',null,'dw-pane dw-who'),talk=el('section',null,'dw-pane dw-talk'),log=el('section',null,'dw-pane dw-log'),hist=el('section',null,'dw-pane dw-hist');
 who.setAttribute('aria-label','Prospect');talk.setAttribute('aria-label','Talk track');log.setAttribute('aria-label','Log the call');hist.setAttribute('aria-label','History');
 grid.append(who,talk,log,hist);whoPane=who;
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
function renderWho(pane,row,b){quickRow=null;
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
 // A Hiring now card says what the card is; its emails, when the Hiring now drip writes to them, get their own line.
 meta.append(el('span',row.kind==='hiring'?'Hiring: '+((row.hiring&&row.hiring.title)||'open role'):row.sentTouches+' emails · last '+new Date(row.lastSentAt).toLocaleDateString()));
 head.append(meta);
 const drip=row.kind==='hiring'?dripLine(row.drip):null;
 if(drip)head.append(el('div',drip.text,'dw-drip dw-drip-'+drip.tone));
 pane.append(head);
 // Their clock, from a zone the CRM gave us. Nothing is guessed from a city name.
 const lt=localTime(p.prospectTimezone&&p.prospectTimezone.timeZone);
 if(lt){const c=el('div',null,'dw-clock');c.append(el('i',null,'dw-dot'+(lt.inHours?'':' off')),document.createTextNode(lt.time+' their time'),el('span','· '+lt.note));pane.append(c);}
 // A callback that has come due is the reason this card is on top. Say so.
 if((row.callOutcome==='callback'||row.callOutcome==='gatekeeper')&&row.nextCallAt&&Date.parse(row.nextCallAt)<=Date.now()){const last=(row.callHistory||[]).slice(-1)[0]||{};const d=el('div',null,'dw-due');d.append(el('b',row.callOutcome==='gatekeeper'?'Gatekeeper callback due. Ask for the owner.':'Callback due.'),document.createTextNode(' You agreed to call at '+new Date(row.nextCallAt).toLocaleString()+(last.notes?'. Notes: '+last.notes:'.')));pane.append(d);}
 else if(row.callOwner&&!row.mine){const d=el('div',null,'dw-due dw-info');d.append(el('b',row.callOwner),document.createTextNode(' owns this follow-up. You can still work it; the first outcome keeps its owner.'));pane.append(d);}
 // The number.
 const num=el('div',null,'dw-numblock');
 cardGated=null;
 if(!b){num.append(el('div','Checking the number…','dw-numdetail'));}
 else if(p.shiftGate&&p.shiftGate.required&&!p.shiftGate.allowed){cardGated=true;num.append(shiftGateBlock(row,b));}   // the server kept the number back
 else if(p.phone&&shiftBlocked(b)){cardGated=true;num.append(shiftGateBlock(row,b));}                                  // the shift paused or ended after this card loaded
 else if(p.phone){cardGated=false;
  const trust=numberTrust(p.dial);
  const dialing=()=>{dialled.add(row.id);tapped.set(row.id,p.phone);holdKind='calling';holdCard(row.id,'calling');refreshBar();if(quickRow)quickRow.hidden=false;};
  const big=link(p.phone,dialHref(p.phone),'dw-num');big.addEventListener('click',dialing);num.append(big);
  num.append(el('span',trust.word,'dw-trust '+trust.tone));
  if(trust.detail)num.append(el('p',trust.detail,'dw-numdetail'));
  const acts=el('div',null,'dw-actions');
  const call=link('Call now',dialHref(p.phone),'btn dw-primary');call.id='call-now';call.addEventListener('click',dialing);
  acts.append(call,button('Copy',async()=>{holdKind='calling';holdCard(row.id,'calling');try{await navigator.clipboard.writeText(p.phone);toast('Number copied.');}catch{toast('Select the number and copy it.',true);}},'btn btn-ghost'));
  // Text: the rep's one-click follow-up (Paul, 2026-10-22), back on Hiring now cards (2026-10-28). Paused work
  // shows no button, and the server refuses a paused or no-longer-listed card whatever this page sends.
  if(!row.pausedFollowUp&&!row.pausedFromPool)acts.append(textButton(row,p));
  num.append(acts);
  if(p.dial&&p.dial.alternates&&p.dial.alternates.length){const alts=el('div',null,'dw-alts');alts.append(el('span','Also on file:'));for(const a of p.dial.alternates){const t=link(a,dialHref(a));t.addEventListener('click',()=>{dialled.add(row.id);tapped.set(row.id,a);holdKind='calling';holdCard(row.id,'calling');});alts.append(t);}num.append(alts);}
  if(p.dial&&p.dial.sourceUrl){const w=el('p',null,'dw-small');w.append(link('Where this number is published',p.dial.sourceUrl));num.append(w);}
  let quoSet=false;try{quoSet=localStorage.getItem(QUO_KEY)==='1';}catch{}
  if(PHONE_UA)num.append(el('p','Tapping the number opens Quo and dials from your Quo line. Log the outcome here when you hang up.','dw-small'));
  else if(!quoSet){const q=el('div',null,'dw-quo');q.append(el('p','Clicking the number opens Quo once the Quo desktop app is installed and is this computer\'s calling app. The Quo website in a tab cannot take the click. One time on a Mac: install Quo, open FaceTime, then Settings, and set "Default for calls" to Quo. On Windows: Settings, Default apps, "Choose default apps by protocol", and set TEL to Quo. Then restart your browser.','dw-small'),link('Download Quo for Mac','https://download.quo.com/Quo-latest.dmg','btn btn-ghost'),link('Quo for Windows','https://www.quo.com/downloads','btn btn-ghost'));q.append(button('Done, hide this',()=>{try{localStorage.setItem(QUO_KEY,'1');}catch{}q.remove();},'btn btn-ghost'));num.append(q);}
  else num.append(el('p','Clicking the number opens Quo.','dw-small'));
 } else {
  num.append(el('div','No number on file','dw-trust'),el('p',(p.phoneEvidence&&p.phoneEvidence.detail)||'A number is being found automatically. Skip ahead; finding numbers is not your job.','dw-numdetail'));
 }
 pane.append(num);
 // Links.
 const links=el('div',null,'dw-links');
 const site=p.website||row.website||(row.source&&row.source.url)||null;
 if(site)links.append(link('Website',/^https?:\/\//.test(site)?site:'https://'+site));
 if(p.crmUrl)links.append(link('CRM contact',p.crmUrl));
 if(row.kind==='hiring'){const job=(p.job&&p.job.url)||(row.hiring&&row.hiring.url);if(job)links.append(link('Job post',job));}
 else links.append(link('Email thread','https://mail.google.com/mail/u/?authuser='+encodeURIComponent(row.sender)+(row.threadId?'#all/'+encodeURIComponent(row.threadId):'#search/'+encodeURIComponent(row.recipient))));
 // Written and sent here, from the rep's own mailbox with their signature (openMail below).
 // Hiring now is call first: the send path refuses until this rep has called them (api/rep-email.js calledFirst).
 if(row.recipient){
  const email=button('Email them',()=>openMail(row,b||{}),'btn');
  email.id='email-them';email.setAttribute('aria-label','Email '+row.recipient);
  pane.append(email,el('p','To '+row.recipient+' · sent from your own Gmail with your signature','dw-small'));
  // Not on a card that cannot be worked (blocked, paused). A Hiring now card shows them once it has been called.
  if(!(b&&b.callable===false)&&!row.pausedFollowUp&&!row.pausedFromPool){quickRow=quickSend(row,b);pane.append(quickRow);}
 }
 pane.append(links);
 if(!b)return;
 // Why this card exists, in one line.
 pane.append(el('p',p.why?p.why:p.staleVerification
  ?(p.staleVerification.sentTouches||4)+' emails and no reply, verified at the last sync'+(p.staleVerification.syncedAt?' ('+new Date(p.staleVerification.syncedAt).toLocaleDateString()+')':'')+'. '+p.staleVerification.mailbox+' could not be re-read just now; a reply to that mailbox since then would not show here.'
  :'Four emails sent, no reply, at least 48 hours since the fourth. Checked '+new Date(p.checkedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})+'.','dw-why'));
 // Research: the sourced fact, the Instagram datapoint.
 const sec=el('div',null,'dw-sec');sec.append(heading('Research'));
 sec.append(el('p',plain(p.fact)||'No sourced business fact is recorded. Ask about their business rather than inventing a personal connection.','dw-fact'));
 if(/^https?:\/\//.test(p.source?.url||'')){const w=el('p',null,'dw-small');w.append(link(p.hiring?(p.job&&p.job.source==='google_jobs'?'The job listing on '+(p.job.feed?p.job.via||p.job.feed:'Google Jobs'):'The job post, on their own careers page'):'Research source',p.source.url));sec.append(w);}
 if(p.hiring&&p.companyIdentity){const w=el('p',null,'dw-small');w.append(document.createTextNode(p.companyIdentity.how==='google_business_profile'?'Business matched to its Google listing: same name, same state. ':p.companyIdentity.how==='listing_website'?'Website named by the employer on its own job listing. ':p.companyIdentity.how==='board_link'?'Website named by their own job board. ':'Website confirmed: its careers page links to this job board. '));if(/^https?:\/\//.test(p.companyIdentity.evidenceUrl||''))w.append(link('Proof',p.companyIdentity.evidenceUrl));sec.append(w);}
 if(p.hiring&&p.job&&p.job.more&&p.job.more.length){const w=el('p',null,'dw-small');w.append(document.createTextNode('Also hiring: '));p.job.more.forEach((m,i)=>{if(i)w.append(document.createTextNode(', '));w.append(link(m.title,m.url));});sec.append(w);}
 if(p.instagram)sec.append(instagramPanel(row,p.instagram));
 pane.append(sec);
}

// ---- the shift gate --------------------------------------------------------------------------
// A caller places calls only on a running shift. The brief withholds the number when the shift is
// off, on a break or past twelve hours; the header bar (hub-shift.js) owns the shift and tells this
// page when it changes. Owners are never gated. Saving notes and outcomes is never gated: a call
// that was under way when a shift ended still gets logged.
const shiftApi=()=>(typeof window!=='undefined'&&window.__staffifyShift)||null;
function shiftBlocked(b){const s=shiftApi();if(s&&typeof s.blocked==='function')return s.blocked();return !!(b&&b.shiftGate&&b.shiftGate.required&&!b.shiftGate.allowed);}
function shiftState(b){const s=shiftApi();return (s&&typeof s.state==='function'&&s.state())||(b&&b.shiftGate&&b.shiftGate.state)||'off';}
function shiftMessage(b){const s=shiftApi();return (s&&typeof s.message==='function'&&s.message())||(b&&b.shiftGate&&b.shiftGate.message)||'Start your shift to call.';}
function shiftGateBlock(row,b){
 const box=el('div',null,'dw-due dw-shiftgate');box.id='shift-gate-card';
 const st=shiftState(b),action=st==='break'?'resume':st==='stale'?'end':'start';
 box.append(el('b','Calling from the Hub needs a running shift. '),document.createTextNode(shiftMessage(b)+' The number appears once your shift is running. Notes and outcomes still save.'));
 const btn=button({start:'Start shift',resume:'Resume shift',end:'End this shift'}[action],async()=>{const s=shiftApi();if(!s){toast('The shift bar has not loaded yet. Reload the page.',true);return;}btn.disabled=true;const r=await s[action]();if(!r||!r.ok){toast((r&&r.error)||'Could not change your shift.',true);btn.disabled=false;}/* on success the staffify-shift event redraws the card */},'btn dw-primary');
 btn.id='shift-gate-action';box.append(btn);return box;
}
// Fired on every shift read (a minute poll, a focused tab, another tab's press). The card redraws
// only when what it shows disagrees with the shift: gated while the shift runs, or a dial link
// while it does not. A poll that changes nothing never resets the pane under the rep.
// cardGated: true = the card shows the gate, false = it shows the number, null = nothing to switch.
let cardGated=null;
if(typeof window!=='undefined'&&typeof window.addEventListener==='function')window.addEventListener('staffify-shift',()=>{
 if(cardGated===null||busy)return;
 if(shiftBlocked(brief)===cardGated)return;
 if(!current||!whoPane||!whoPane.isConnected)return;
 const withheld=!!(brief&&brief.shiftGate&&brief.shiftGate.required&&!brief.shiftGate.allowed);
 if(withheld&&!shiftBlocked(brief)){refresh().catch(fail);return;}   // the shift started: re-read the queue (its numbers were withheld too) and the card
 else if(brief)renderWho(whoPane,current,brief);           // paused or ended: take the link away, keep the card
});

// The text button. The server drafts the message, checks opt-outs and the never-twice rule, and
// records what consent it found. Here it is one click and a plain confirm.
function textButton(row,p){
 const btn=button('Text',async()=>{
  if(busy)return;
  if(!window.confirm('Text '+(firstName(p.name)||'them')+' at '+p.phone+' from the Staffify line? The message is drafted from the approved template and logged to the CRM.'))return;
  btn.disabled=true;btn.textContent='Sending…';
  try{
   // A Hiring now card is about the role they posted: the approved "the {role} role you posted" text, signed by the caller.
   const body=row.kind==='hiring'?{id:row.id,phone:p.phone,first:firstName(p.name),company:p.company||row.company||'',motion:'staffing',role:(p.job&&p.job.title)||'',rep:p.callerName||'',email:row.recipient||''}:{id:row.id,phone:p.phone,first:firstName(p.name),company:p.company||row.company||'',motion:'outreach',emails:row.sentTouches||0,email:row.recipient};
   const j=await api('/api/send-text/',body);
   if(j.sent){session.texts++;btn.textContent='Texted';toast('Text sent: '+(j.content||'').slice(0,140));const n=document.getElementById('call-notes');if(n&&!/Texted/.test(n.value))n.value=(n.value?n.value+'\n':'')+'Texted them after the call.';}
   else{btn.textContent='Text';btn.disabled=false;const why=TEXT_REASON[j.reason||j.error];toast('Not sent: '+(why||j.reason||j.error||'unknown'),true);}
  }catch(e){btn.textContent='Text';btn.disabled=false;toast('Could not reach the server. Nothing was sent.',true);}
 },'btn btn-ghost');
 btn.title='Send the approved text to this number';
 return btn;
}
const TEXT_REASON={opted_out:'this number replied STOP.',already_texted:'this number was already texted once; we never text twice.',no_company:'no company on the record.',no_valid_number:'that is not a textable number.',rate_limited:'the hourly cap is reached.',no_rep_name:'your name is not on your Hub profile.',not_configured:'texting is not configured on the server.',unsupportable_claim:'the message made a claim we cannot back.',no_role:'the card has no job title to mention.',campaign_paused:'this campaign is paused; nothing is texted for it.',not_callable:'this card is no longer on the call list.',booked:'they booked a call, so nothing else goes out.',not_found:'the card could not be found.',check_unavailable:'the card could not be checked just now.',sign_in:'sign in to the Hub first.',no_card:'the card was not named.'};

// ---- email them -----------------------------------------------------------------------------
// Paul, 2026-10-27: "milton needs to be able to send emails from here, they should be made with
// his signature" and "we should have some premade message templates 1) should be thanks for your
// time -> book a meeting". The server owns the mailbox, the signature, the templates and every
// check (api/rep-email.js); this draws the composer. Nothing is sent without the Send button.
let mailBox=null;
const mailDraftKey=id=>'staffify-mail-draft:'+id;
function readMailDraft(id){try{return JSON.parse(sessionStorage.getItem(mailDraftKey(id))||'null');}catch{return null;}}
function keepMailDraft(id,d){try{sessionStorage.setItem(mailDraftKey(id),JSON.stringify(d));}catch{}}
function dropMailDraft(id){try{sessionStorage.removeItem(mailDraftKey(id));}catch{}}
function newNonce(){try{return crypto.randomUUID();}catch{return Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,12);}}
/** A chosen picture, centre-cropped to a 240px square JPEG data URL. */
function squarePhoto(f){return new Promise((ok,bad)=>{const url=URL.createObjectURL(f);const img=new Image();img.onload=()=>{try{const s=Math.min(img.naturalWidth,img.naturalHeight),c=document.createElement('canvas');c.width=c.height=240;c.getContext('2d').drawImage(img,(img.naturalWidth-s)/2,(img.naturalHeight-s)/2,s,s,0,0,240,240);URL.revokeObjectURL(url);ok(c.toDataURL('image/jpeg',0.86));}catch(e){bad(e);}};img.onerror=()=>{URL.revokeObjectURL(url);bad(Error('That file could not be read as a picture.'));};img.src=url;});}
function closeMail(){if(mailBox){mailBox.remove();mailBox=null;}}
// Paul, 2026-10-28: "a few hot buttons that allows them to send follow-ups that we would typically send ... quick
// responses that we would usually just fire off". One press writes the follow-up in and runs the cleanup; the next sends.
let quickRow=null;
const QUICK={hiring:[['hiring-thanks','Thanks + book a call'],['hiring-missed','Sorry I missed you'],['hiring-info','The info you asked for'],['hiring-follow-up','Following up']],
 other:[['thanks-book','Thanks + book a call'],['missed-book','Sorry I missed you'],['info-requested','The info you asked for'],['follow-up','Following up']]};
function quickSend(row,b){const w=el('div',null,'dw-quick');w.append(el('span','Quick send','dw-mail-label'));
 // Hiring now is call first (the server refuses before a call): the row appears once the card has been called.
 if(row.kind==='hiring'&&!((row.callHistory||[]).length||dialled.has(row.id)))w.hidden=true;
 for(const [id,label] of QUICK[row.kind==='hiring'?'hiring':'other'])w.append(button(label,()=>openMail(row,b||{},{template:id,quick:true}),'btn btn-ghost dw-quick-btn'));
 return w;}
async function openMail(row,p,{reconnect=false,template=null,quick=false}={}){
 closeMail();
 const box=el('div',null,'dw-mail');box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-labelledby','mail-title');
 const card=el('div',null,'dw-mail-card');box.append(card);
 box.addEventListener('click',e=>{if(e.target===box)closeMail();});
 mailBox=box;document.body.append(box);
 card.append(el('p','Loading your mailbox…','dw-small'));
 let info;try{info=await api('/api/rep-email/?email='+encodeURIComponent(row.recipient));}catch(e){info={error:e.message};}
 if(mailBox!==box)return;   // closed, or another card opened, while it loaded
 card.replaceChildren();
 const who=(p.name&&p.name!==row.recipient?firstName(p.name):'')||firstName(row.verifiedFirstName)||firstName(names[row.id])||(p.identity&&p.identity.askFor?firstName(p.identity.askFor):'');
 const company=p.company||row.company||'';
 const head=el('div',null,'dw-mail-head');const h=el('h2','Email '+(who||company||row.recipient));h.id='mail-title';
 head.append(h,button('Close',closeMail,'btn btn-ghost'));card.append(head);
 const gmail=emailCompose(state&&state.viewer,row.recipient);
 const gmailLink=()=>gmail?link('Open in Gmail instead',gmail.url,'dw-mail-alt'):null;
 if(info.error||!info.mailbox){card.append(el('p',info.error?'Your mailbox could not be loaded ('+info.error+'). Nothing was sent.':info.reason,'dw-due dw-alert'));const g=gmailLink();if(g)card.append(g);return;}
 const meta=el('dl',null,'dw-mail-meta');
 // To is editable (Milton, 2026-10-27: a gatekeeper gave him a better address). Same company only; the
 // server checks the domain and runs every do-not-contact check on the address it really goes to.
 const toIn=el('input');toIn.id='mail-to';toIn.type='email';toIn.autocomplete='off';toIn.value=row.recipient;toIn.setAttribute('aria-label','Send to');
 const toDd=el('dd');toDd.append(toIn);
 const alts=(info.alternates||[]).filter(a=>a!==row.recipient);
 if(alts.length||row.recipient){const pick=el('div',null,'dw-mail-alts');for(const a of [row.recipient,...alts])pick.append(button(a,()=>{toIn.value=a;},'btn btn-ghost dw-tpl'));if(alts.length)toDd.append(pick);}
 if((info.domains||[]).length)toDd.append(el('span','Got a better address from the gatekeeper? Type it in. It has to be at '+info.domains.join(' or ')+'.','dw-small'));
 meta.append(el('dt','From'),el('dd',info.name+' <'+info.mailbox+'>'),el('dt','To'),toDd);
 card.append(meta);
 if(info.pending)card.append(el('p','An email to them on '+new Date(info.pending.at).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' was not confirmed by Gmail. Check your Sent folder. Sending again first checks whether it went.','dw-due dw-alert'));
 if(info.history&&info.history.length){const last=info.history[0];card.append(el('p','Already emailed '+new Date(last.at).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' by '+last.by+': “'+last.subject+'”','dw-due dw-info'));}
 // Their first name goes in the subject (Paul, 2026-10-27). Prefilled from what is known; the rep can type it.
 const firstIn=el('input');firstIn.id='mail-first';firstIn.type='text';firstIn.maxLength=30;firstIn.autocomplete='off';firstIn.value=who;firstIn.placeholder='Their first name';
 const subject=el('input');subject.id='mail-subject';subject.type='text';subject.maxLength=150;subject.autocomplete='off';subject.placeholder='Subject';
 const body=el('textarea');body.id='mail-body';body.rows=11;body.maxLength=5000;
 const save=()=>keepMailDraft(row.id,{subject:subject.value,body:body.value});
 subject.oninput=save;body.oninput=save;
 // A template fills the real words in, so what is on screen is exactly what goes.
 const fill=t=>{const f=firstIn.value.trim();const v={first:f||'there',company:company||'your business',me:info.me||'',link:t.link||''};const put=x=>String(x).replace(/\{(first|company|me|link)\}/g,(m,k)=>v[k]);subject.value=put(f?t.subject:(t.subjectNoName||t.subject));body.value=put(t.body);save();};
 const picks=el('div',null,'dw-mail-picks');picks.append(el('span','Start from a template','dw-mail-label'));
 const tpls=el('div',null,'dw-mail-tpls');
 for(const t of info.templates||[])tpls.append(button(t.label,()=>{if((subject.value.trim()||body.value.trim().length>(who.length+5))&&!window.confirm('Replace what you have written with this template?'))return;fill(t);body.focus();},'btn btn-ghost dw-tpl'));
 picks.append(tpls);card.append(picks);
 const lab=(text,input)=>{const l=el('label',text,'dw-mail-label');l.htmlFor=input.id;return l;};
 card.append(lab('First name',firstIn),firstIn,lab('Subject',subject),subject,lab('Message',body),body);
 const draft=readMailDraft(row.id);
 if(draft&&(draft.subject||draft.body)){subject.value=draft.subject||'';body.value=draft.body||'';}
 else body.value='Hi '+(who||'there')+',\n\n';
 // Opened from a step that names its email (the summary after a filled role, the thanks after a good call): it is written in.
 let quickOk=false;
 if(template&&quick){const t=(info.templates||[]).find(x=>x.id===template);
  if(!t)toast('That follow-up is not available for this card. Write your own or pick a template.',true);
  else if(draft&&(draft.subject||draft.body)&&!window.confirm('Replace what you have written with this follow-up?')){}
  else{fill(t);quickOk=true;}}
 else if(template&&!(draft&&(draft.subject||draft.body))){const t=(info.templates||[]).find(x=>x.id===template);if(t)fill(t);}
 // The signature exactly as it is added: the server's HTML, in a sandbox, nothing able to run.
 const sig=el('div',null,'dw-mail-sig');sig.append(el('span','Your signature goes under the message','dw-mail-label'));
 const frame=document.createElement('iframe');frame.title='Your email signature';frame.setAttribute('sandbox','');frame.srcdoc='<!doctype html><meta charset="utf-8"><body style="margin:10px;background:#fff">'+(info.signatureHtml||'')+'</body>';
 sig.append(frame);
 // His own headshot for the signature (Paul, 2026-10-27: "his photo added!"). Cropped square and made
 // small here, so what is uploaded is just the 240px picture the signature shows.
 const photoRow=el('div',null,'dw-mail-photo');
 const file=el('input');file.type='file';file.accept='image/jpeg,image/png';file.id='mail-photo';file.hidden=true;
 const choose=button(info.photo?'Change your photo':'Add your photo',()=>file.click(),'btn btn-ghost');
 file.onchange=async()=>{const f=file.files&&file.files[0];if(!f)return;choose.disabled=true;choose.textContent='Uploading…';
  try{const image=await squarePhoto(f);const r=await api('/api/rep-email/',{action:'photo',image});if(!r.ok)throw Error(r.reason||'not saved');toast('Photo added to your signature.');return openMail(row,p);}
  catch(e){toast('Photo not saved: '+((e.payload&&e.payload.reason)||e.message),true);choose.disabled=false;choose.textContent=info.photo?'Change your photo':'Add your photo';}};
 photoRow.append(choose,file);
 if(info.photo)photoRow.append(button('Remove photo',async()=>{try{await api('/api/rep-email/',{action:'photo-remove'});toast('Photo removed.');openMail(row,p);}catch(e){toast('Could not remove it: '+e.message,true);}},'btn btn-ghost'));
 sig.append(photoRow);card.append(sig);
 const acts=el('div',null,'dw-actions dw-mail-acts');
 const review=el('div',null,'dw-mail-review');review.hidden=true;   // what the cleanup changed
 if(!info.connected||reconnect){
  const back=location.pathname+'?open='+encodeURIComponent(row.id);
  const c=link('Connect Gmail to send',info.connectUrl+'&back='+encodeURIComponent(back),'btn dw-primary');c.target='_self';c.removeAttribute('rel');c.id='mail-connect';
  acts.append(c);
  card.append(el('p','One time only. Google asks you to let the Hub send as '+info.mailbox+'. What you have written here is kept while you connect.','dw-small'));
 }else{
  let nonce=newNonce(),reviewed=null,send=null;
  // Paul, 2026-10-27: "it should always take an ai pass at it and clean up any issues". Send runs
  // the cleanup first. If it changed anything, the cleaned text replaces the draft with a list of
  // what changed, and the next press sends it. If nothing needed changing, it sends straight away.
  // The cleanup on what is on screen. True when it can go exactly as it stands; false when the rep has something to
  // read (a change, a problem) or the check could not run. Send runs it first; a quick send runs it as it opens.
  const prep=async()=>{
   const s=subject.value.trim(),m=body.value.replace(/\r\n/g,'\n').trim();
   if(!s){toast('Add a subject.',true);subject.focus();return false;}
   if(m.replace(/^hi\b[^,\n]*,?/i,'').trim().length<2){toast('Write the message first.',true);body.focus();return false;}
   if(reviewed&&reviewed.subject===s&&reviewed.body===m)return true;
   send.textContent='Checking…';
   let c;try{c=await api('/api/rep-email/',{action:'clean',email:row.recipient,to:toIn.value.trim(),subject:s,body:m,first:firstIn.value.trim()});}catch(e){c=e.payload||{reason:'Could not reach the server. Nothing was sent.'};}
   send.textContent='Send email';
   if(!c||!c.body){toast((c&&c.reason)||'The cleanup could not run. Nothing was sent.',true);return false;}
   subject.value=c.subject;body.value=c.body;save();reviewed={subject:c.subject,body:c.body};
   review.replaceChildren();review.hidden=!(c.changed||c.note||c.problem);
   if(c.changed){review.append(el('b','Cleaned up before sending')); const ul=el('ul');for(const x of c.changes||[])ul.append(el('li',x));review.append(ul);}
   if(c.note)review.append(el('p',c.note,'dw-small'));
   if(c.problem){review.append(el('p',c.problem,'dw-mail-problem'));return false;}
   if(c.changed){review.append(el('p','Read it over, then press Send.','dw-small'));body.focus();return false;}
   return true;
  };
  send=button('Send email',async()=>{
   if(send.disabled)return;
   send.disabled=true;
   if(!await prep()){send.disabled=false;return;}
   send.textContent='Sending…';
   // No answer at all (a dropped connection, a timeout page) is not "nothing was sent": Gmail may have
   // sent it. Held like any unconfirmed send, so it is checked before anything goes again.
   let j;try{j=await api('/api/rep-email/',{email:row.recipient,to:toIn.value.trim(),subject:reviewed.subject,body:reviewed.body,nonce,first:firstIn.value.trim()});}catch(e){j=e.payload||{sent:false,uncertain:true,reason:'The Hub could not confirm whether this was sent. Check your Gmail Sent folder before sending again.'};}
   if(j.review)reviewed=null;
   if(j.sent){dropMailDraft(row.id);closeMail();toast('Sent to '+j.to+' from '+j.from+'. It is in your Gmail Sent folder.');
    const n=document.getElementById('call-notes');const line='Emailed them: '+j.subject;if(n&&!n.value.includes(line))n.value=(n.value?n.value+'\n':'')+line;return;}
   toast(j.reason||'Not sent.',true);
   if(j.already){dropMailDraft(row.id);closeMail();return;}   // the earlier send did go out: nothing more to do
   if(j.connect)return openMail(row,p,{reconnect:true});
   if(j.uncertain){send.textContent='Check your Sent folder';return;}
   send.disabled=false;send.textContent='Send email';
  },'btn dw-primary');
  send.id='mail-send';acts.append(send);
  // A quick send arrives written and checked: one more press and it goes.
  if(quick&&quickOk){const fields=[toIn,firstIn,subject,body];send.disabled=true;fields.forEach(f=>{f.readOnly=true;});
   prep().then(ok=>{send.disabled=false;fields.forEach(f=>{f.readOnly=false;});if(mailBox!==box||!ok)return;review.hidden=false;review.append(el('p','Ready. Press Send to email '+toIn.value.trim()+'.','dw-small'));send.focus();});}
 }
 acts.append(button('Cancel',closeMail,'btn btn-ghost'));const g=gmailLink();if(g)acts.append(g);
 card.append(review);
 card.append(acts,el('p','Sent from your Gmail, so it sits in your Sent folder and replies come straight to you. '+(info.sentToday||0)+' of '+info.perDay+' sent today.','dw-small'));
 (subject.value?body:subject).focus();
}

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
// Paul, 2026-10-28: "make sure that button signifies the rep sending over an email summarizing us and sharing what we do
// too? The call portal should be able to dispurse more emails and right now its not leaving a trail of breadcrumbs".
// A step that ends a good call opens the rep's composer with the email written for this job; with no address on the
// card, the one they give on the call is saved first (api/_hiring-calls.js saveHiringContactEmail).
function emailStep(row,b,tpl){const box=el('div',null,'dw-cbk');const open=()=>openMail(row,b||{},{template:tpl});
 if(row.recipient){box.append(button('Send them the summary email',open,'btn dw-choice win'),el('p','It opens in your Gmail composer, written for this job. Read it, then send.','dw-note'));return box;}
 box.append(el('div','Ask for their email so you can send the summary.','dw-step'));
 const inp=el('input');inp.type='email';inp.id='given-email';inp.placeholder='Their email, from the call';inp.autocomplete='off';inp.setAttribute('aria-label','Their email');
 const go=button('Save it and write the email',async()=>{const v=inp.value.trim().toLowerCase();if(!v){inp.focus();return;}go.disabled=true;
  try{const j=await api('/api/outreach-queue/?view=calls',{action:'contact-email',id:row.id,email:v});if(j&&j.records)state=j;row.recipient=j&&j.contactEmail||v;if(current&&current.id===row.id)current.recipient=row.recipient;toast('Saved. Their email is on the card.');open();}
  catch(e){toast((e.payload&&e.payload.error)||e.message||'Not saved.',true);go.disabled=false;}},'btn dw-choice win');
 box.append(inp,go);return box;}
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
   if(node.email&&row.kind==='hiring')parts.push(emailStep(row,b,node.email));
   if(node.log){
    const row2=el('div',null,'dw-choices');
    row2.append(button('Log as '+(LOGLABEL[node.log]||node.log)+' →',()=>{selectOutcome(node.log);document.getElementById('call-notes')?.focus();},'btn dw-choice win'));
    parts.push(row2);
    if(node.log==='callback'||node.log==='gatekeeper'){
     // Paul, 2026-10-22: "if they select bad time can we make a task time to call them back that
     // reminds the sales person." The agreed time is picked here and the save is one click.
     const cb=el('div',null,'dw-cbk');cb.append(el('div','When should you call back?','dw-step'));
     const lt=localTime(b.prospectTimezone&&b.prospectTimezone.timeZone);if(lt)cb.append(el('p','It is '+lt.time+' their time. Times below are yours.','dw-note'));
     // A node can name its own callback ("a month from now" after a filled role): it is chosen for the rep, first in the list.
     let first=[];if(node.callbackDays){const d=new Date();d.setDate(d.getDate()+node.callbackDays);d.setHours(10,0,0,0);if(d.getDay()===6)d.setDate(d.getDate()+2);if(d.getDay()===0)d.setDate(d.getDate()+1);first=[{label:node.callbackDays>=28?'In a month':'In '+node.callbackDays+' days',at:d}];
      selectOutcome(node.log,d);const n0=document.getElementById('call-notes');if(n0&&!n0.value.trim())n0.value='They filled the role. OK to stay in touch: check back '+d.toLocaleDateString()+' to see if the hire worked out.';}
     const picks=el('div',null,'dw-picks');for(const q of [...first,...quickPicks()])picks.append(button(q.label,()=>{selectOutcome(node.log,q.at);const n=document.getElementById('call-notes');if(n&&!n.value.trim())n.value=(node.log==='gatekeeper'?'Gatekeeper answered. Ask for the owner '+q.at.toLocaleString()+'. Who answered: ':'Bad time. Agreed to call back '+q.at.toLocaleString()+'.');toast('Callback set for '+fmtWhen(q.at)+'. Save when you are ready, or ⌘↵.');},'btn dw-pick'));
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
 const book=el('details');book.append(el('summary','Book the discovery call'));const bl=el('div',null,'dw-links');if(b.bookingUrl)bl.append(link('Book the discovery call',b.bookingUrl));bl.append(link('Sales training and pricing','/training/sales/'));if(!b.hiring)bl.append(link('15 tasks agency owners can hand off','/blog/real-estate-photography-tasks-to-delegate/'));book.append(bl);pane.append(book);
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
 // The overview send reads the email queue only; a Hiring now card emails from Email them, after the call.
 if(row.kind==='hiring')send.append(el('p','Hiring now: after the call, use Email them on the left. It goes from your own Gmail with your signature.','dw-small'));
 else send.append(ov,link('Preview the overview','/assets/docs/staffify-overview.pdf','btn btn-ghost'));
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
  box.append(el('p',value==='gatekeeper'?'Saved as a gatekeeper: it returns to the top of your queue at this time to ask for the owner, with a HubSpot task if you have a HubSpot user. Note who answered and who to ask for.':value==='callback'?'Saved as a callback: it returns to the top of your queue at this time and a HubSpot task reminds you if you have a HubSpot user.':value==='timing'?'A warm later. They join the email nurture and come back to you on this date.':'Retried on this date. Leave a voicemail once, then text once; three quiet attempts and the lead rests.','dw-nexthint'));
 } else {
  due.hidden=true;
  if(value==='connected'){const sent=el('div',null,'dw-picks');for(const tag of ['Meeting booked','Interested','Referred me on','Not a fit']){sent.append(button(tag,()=>{const n=document.getElementById('call-notes');if(!n)return;n.value=n.value.replace(/^\[(Meeting booked|Interested|Referred me on|Not a fit)\]\s*/,'');n.value='['+tag+'] '+n.value;for(const x of sent.children)x.classList.toggle('on',x.textContent===tag);stash();},'btn dw-pick'));}box.append(sent);}
  box.append(el('p',value==='connected'?'Book the discovery call while you have them (link in the talk track), or send the overview below. Saving hands the thread to a human for the reply.':value==='wrong_number'?'That number is retired for this person and a different one is looked for. The lead is not lost.':'They are excluded from every Staffify campaign. Use this for a clear no or a request to stop.','dw-nexthint'));
 }
 breadcrumb(box,value);
}
// After the call: a Hiring now outcome that should leave a trail offers the matching email, written for the job.
function breadcrumb(box,value){const tpl=current&&current.kind==='hiring'&&current.recipient?({connected:'hiring-thanks',voicemail:'hiring-missed',no_answer:'hiring-missed'})[value]:null;
 if(!tpl)return;const w=el('div',null,'dw-picks');w.append(button(value==='connected'?'Email them a summary and the booking link':'Email them: sorry I missed you',()=>openMail(current,brief||{},{template:tpl}),'btn dw-choice win'));box.append(w);}
function refreshBar(){const old=app.querySelector('.dw-bar');if(!old)return;const typing=document.activeElement&&document.activeElement.id==='dw-search';old.replaceWith(bar());
 // A redraw (Quo counts every two minutes) must not throw away a search being typed.
 if(typing){const q=document.getElementById('dw-search');if(q)q.focus();}}

// Saving. Same contract as before: re-read the queue for the revision and the latest numbers,
// post the outcome, say what the server did about the callback task, the nurture and the number.
async function saveOutcome(row,b,status,save,notesEl=null){
 if(busy)return;
 if(!choice){status.textContent='Choose an outcome first.';status.className='dw-status';return;}
 const due=document.getElementById('callback-at'),notes=notesEl||document.getElementById('call-notes');
 if(NEEDS_TIME.includes(choice)&&!(Date.parse(due.value)>Date.now())){status.textContent='Choose a time in the future.';status.className='dw-status';due.focus();return;}
 if(!b&&choice!=='suppress'){status.textContent='The live check has not finished. Wait a moment, or skip.';status.className='dw-status';return;}
 busy=true;save.disabled=true;status.textContent='Saving…';status.className='dw-status ok';stash();refreshBar();
 try{
  const latest=await api('/api/outreach-queue/?view=calls');
  // The number on screen travels with every outcome, so the daily report can pair it with Quo's record of the call.
  // A stop names only a number the rep actually tapped: the on-screen line may be one the person never answered.
  const number=tapped.get(row.id)||(choice==='suppress'?null:(b&&b.phone))||null;
  const dialled=number?{dialled:number}:{};
  const body=choice==='suppress'?{action:'suppress',email:row.recipient,notes:notes.value,...(row.kind==='hiring'?{id:row.id}:{}),...dialled}:{action:'call-outcome',id:row.id,outcome:choice,notes:notes.value,nextCallAt:NEEDS_TIME.includes(choice)?new Date(due.value).toISOString():null,...dialled};
  const next=await api('/api/outreach-queue/?view=calls',{...body,expectedRevision:latest.revision});
  const tasks=state.tasks;state=next;state.tasks=next.tasks||tasks||[];
  session.saved[choice]=(session.saved[choice]||0)+1;
  const nurture=nurtureNote(state.nurture);if(nurture)toast(nurture.text,nurture.warn);
  if(state.callbackTask){const t=state.callbackTask;if(t.ok)toast('Callback saved. A HubSpot task will remind you at '+new Date(due.value).toLocaleString()+'.');else toast('Callback saved; it returns to the top of your queue at that time. No HubSpot reminder: '+(t.detail||t.reason)+'.',true);}
  if(state.wrongNumber){if(state.wrongNumber.ok)toast('Logged. That number will not be offered again for them; we are looking for another.');else toast('Logged as a wrong number, but the number could not be marked: '+state.wrongNumber.reason+'.',true);}
  if(!state.nurture&&!state.callbackTask&&!state.wrongNumber)toast('Saved: '+(LOGLABEL[choice]||choice)+'.');
  const phones=new Map(latest.records.map(r=>[r.id,r.callContact]));state.records=state.records.map(r=>({...r,callContact:phones.get(r.id)||r.callContact}));
  // A logged card leaves the queue because its state changed (callReady recomputed on the server), not because it was skipped.
  holdCard(row.id,'called');holdId=null;
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
 // A no is always taken, callable or not (Paul, 2026-10-30): someone who calls back early, or after Connected, and says
 // "take me off" is taken off every list here.
 const stopNotes=el('textarea',null,'dw-notes');stopNotes.id='stop-notes';stopNotes.placeholder='What they said (optional)';stopNotes.rows=2;
 const stopStatus=el('p','','dw-status');
 const stopBtn=button('Not interested / stop',()=>{choice='suppress';saveOutcome(row,null,stopStatus,stopBtn,stopNotes);},'btn dw-stop');
 log.replaceChildren(heading('How did it go?'),el('p','Outcomes are off for a prospect we are not calling. If they asked to be left alone, record it here: they come off every list and every email.','dw-small'),stopNotes,stopBtn,stopStatus);
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
 if(e.key==='/'&&!mailBox&&!e.metaKey&&!e.ctrlKey&&!/^(INPUT|TEXTAREA|SELECT)$/.test((e.target&&e.target.tagName)||'')){const q=document.getElementById('dw-search');if(q){e.preventDefault();q.focus();return;}}
 const s=shortcut(e);if(!s)return;
 if(mailBox){if(s.type==='escape'){e.preventDefault();closeMail();}return;}
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
refresh().then(loadNames).catch(fail);
loadQuo();setInterval(loadQuo,120000);
// A release while this tab is open: say so, so nobody works from the old page (Paul, 2026-10-28: "the texting
// feature is gone" was a dialer tab opened before the release that brought it back). Never reloads on its own.
let releaseTag=null;
async function checkRelease(){try{const r=await fetch('/assets/js/dialer-workspace.js',{method:'HEAD',cache:'no-store',credentials:'same-origin'});const t=r&&r.headers&&typeof r.headers.get==='function'?r.headers.get('etag'):null;if(!t)return;if(releaseTag===null){releaseTag=t;return;}if(t===releaseTag||document.getElementById('dw-new-version'))return;
 const bar=el('div',null,'dw-new-version');bar.id='dw-new-version';bar.setAttribute('role','status');if(bar.style)bar.style.cssText='position:sticky;top:0;z-index:60;background:#fff4dc;color:#5c3d00;padding:10px 16px;text-align:center;font-size:14px;border-bottom:1px solid #f0d9a6';
 bar.append(document.createTextNode('A new version of the dialer is ready. Save the call you are on, then '),button('Reload',()=>location.reload(),'btn'));document.body.prepend(bar);}catch{}}
checkRelease();setInterval(()=>{if(document.visibilityState!=='hidden')checkRelease();},300000);
if(typeof document.addEventListener==='function')document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')checkRelease();});
// Holds: read every 30 seconds so counts drop as teammates work; this rep's own hold renewed every 2 minutes.
setInterval(async()=>{if(document.visibilityState==='hidden'||!state)return;await loadHolds();refreshBar();},30000);
// Dialling from the phone or Quo puts this tab in the background: the card stays held while it is still on screen
// here, up to 20 minutes from opening it, so a teammate's dialer cannot pick it up mid-call.
setInterval(()=>{if(holdId&&current&&current.id===holdId&&(document.visibilityState!=='hidden'||Date.now()-shownAt<20*60000))holdCard(holdId,holdKind);},120000);
if(typeof document.addEventListener==='function')document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&holdId&&current&&current.id===holdId)holdCard(holdId,holdKind);});
if(typeof window!=='undefined'&&typeof window.addEventListener==='function')window.addEventListener('pagehide',()=>{if(holdId&&holdKind==='open')holdPost({action:'release',id:holdId});});
