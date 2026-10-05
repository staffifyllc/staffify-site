import {ACCOUNTS,SOURCES} from './_enterprise-seed.js';
export const ENTERPRISE_KEY='staffify:enterprise-accounts:v1';
export const LANES=[{id:'enterprise-direct',name:'Enterprise Direct',sequenceId:'enterprise-direct-v1'},{id:'tier-two',name:'Tier 2 / Prime Staffing Partners',sequenceId:'enterprise-partner-v1'}];
export const SEQUENCES={
 'enterprise-direct-v1':[
  {day:0,purpose:'Confirm procurement route',copy:'Use the account-specific routing question below. Do not suggest that registration is supplier approval.'},
  {day:7,purpose:'Offer a capability brief',copy:'Would a short capability outline help your category team assess fit? We can keep it to delivery locations, role coverage, screening and the scope of a small pilot, with evidence behind each claim.'},
  {day:14,purpose:'Qualify the entry path',copy:'If new suppliers enter through an MSP or an existing prime, I am happy to follow that route. Which intake process should we use, and is there a capability gap worth considering?'},
  {day:21,purpose:'Close the loop',copy:'I will close the loop here. If your team reviews additional recruiting or delivery partners later, we would be glad to share a focused capability profile. No need to reply if this is not relevant.'}
 ],
 'enterprise-partner-v1':[
  {day:0,purpose:'Find the supplier partnership owner',copy:'Use the account-specific partner inquiry below, referring to the documented supplier route.'},
  {day:7,purpose:'Identify a delivery gap',copy:'Is there a role family or delivery region where additional recruiting capacity would be useful? We would rather evaluate one specific gap with your team than send a broad staffing pitch.'},
  {day:14,purpose:'Scope a small pilot',copy:'If there is a fit, a useful next step could be a small pilot with agreed screening, turnaround and candidate-quality measures. What evidence would your supplier team need before considering that?'},
  {day:21,purpose:'Close without pressure',copy:'I will leave this with you and stop following up. If a specialist recruiting or delivery partner becomes useful, we can revisit the right supplier process then.'}
 ]
};
export const POLICY={mode:'research_and_planning',sendingEnabled:false,maxAccounts:10,maxStakeholders:6,maxConcurrentContactsPerAccount:1,minimumDaysBetweenTouches:7,maxAccountTouches:4,stopOn:['human reply','opt-out','current client','booking','existing owned conversation'],notes:'Sequence drafts only. No Gmail enrollment or automatic enterprise sending is connected. Daily cloud review tracks research gaps, ownership and next steps. One account owner coordinates all stakeholders.'};
export function initialState(){return {revision:0,accounts:structuredClone(ACCOUNTS),capabilities:{deliveryCountries:'',capacity:'',specialties:'',proof:'',security:'',commercial:'',updatedAt:null},lastReview:null,events:[]};}
const str=(v,max=3000)=>String(v||'').trim().slice(0,max);
export function score(a){return Object.values(a.scoreInputs).reduce((n,v)=>n+v,0);}
export function review(state,now=new Date().toISOString()){
 return state.accounts.map(a=>({accountId:a.id,score:score(a),due:!!a.nextActionAt&&Date.parse(a.nextActionAt)<=Date.parse(now),evidenceStale:Date.parse(now)-Date.parse(a.researchedAt)>30*86400000,namedStakeholders:a.stakeholders.filter(s=>s.name).length,verifiedEmails:a.contacts.filter(c=>c.emailVerification==='valid').length,blockers:[...a.gaps,...(!state.capabilities.proof?['Staffify capability evidence is incomplete']:[]),'Enterprise sending integration is not enabled'],nextAction:a.nextAction,status:a.status}));
}
export function view(state,now=new Date().toISOString()){return {...state,lanes:LANES,sequences:SEQUENCES,sources:SOURCES,policy:POLICY,review:review(state,now),scoreRubric:{demand:'0–25: documented workforce/program demand',route:'0–25: specific supplier entry route',stakeholders:'0–20: relevant named stakeholders',fit:'0–15: supported service-fit hypothesis',readiness:'0–15: proven capability/readiness'},scoreNote:'Research-priority assessment, not a win probability. Unverified readiness receives zero.'};}
export function update(state,body,actor,now=new Date().toISOString()){
 const next=structuredClone(state);let summary;
 if(body.action==='capabilities'){
  for(const k of ['deliveryCountries','capacity','specialties','proof','security','commercial'])next.capabilities[k]=str(body[k]);
  next.capabilities.updatedAt=now;summary='Updated capability evidence';
 }else{
  const a=next.accounts.find(a=>a.id===body.id);if(!a)throw Error('Unknown account');
  if(body.action==='account'){
   if(!['Paul','Madison'].includes(body.owner))throw Error('Invalid owner');
   if(!['research','qualifying','human_conversation','paused'].includes(body.status))throw Error('Invalid account state');
   if(body.nextActionAt&&!Number.isFinite(Date.parse(body.nextActionAt)))throw Error('Invalid next action date');
   a.owner=body.owner;a.status=body.status;a.nextAction=str(body.nextAction);a.nextActionAt=body.nextActionAt?new Date(body.nextActionAt).toISOString():null;
   const note=str(body.notes);if(note)a.events.push({at:now,actor,kind:'note',text:note});
   summary='Updated account owner and next step';
  }else if(body.action==='contact'){
   const name=str(body.name,120),role=str(body.role,200),email=str(body.email,254).toLowerCase(),source=str(body.source,2000);
   if(!name||!role)throw Error('Name and role required');
   if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Invalid email');
   let u;try{u=new URL(source);}catch{throw Error('Public source URL required');}if(u.protocol!=='https:')throw Error('HTTPS source required');
   if(a.contacts.length>=6)throw Error('Six contacts maximum per account');
   if(a.contacts.some(c=>(email&&c.email===email)||c.name.toLowerCase()===name.toLowerCase()))throw Error('Contact already recorded');
   a.contacts.push({name,role,email,source,emailVerification:'not_verified',addedAt:now,addedBy:actor});summary='Added research contact; verification still required';
  }else throw Error('Unsupported action');
 }
 next.revision++;next.events.push({at:now,actor,accountId:body.id||null,summary});return next;
}
