import {BAD_KEY,badSetFrom,isBad} from './_bad-numbers.js';
import {callReady} from './_outreach-policy.js';
import {ATTEMPTS,researchStatus} from './_number-research.js';

// One round-trip per stage, not one per record.
// ------------------------------------------------------------------
// Live, the Campaigns tab took 9.4 seconds cold and the dialer paid the same bill on every load.
// This ladder read seven keys per due record, one GET at a time, across ~790 records: thousands of
// sequential round-trips to Upstash. Each stage now asks for all of its keys in one MGET.
//
// The fallback matters: a store without mget (the test fakes, or a client that cannot pipeline)
// gets the same answers by sequential GET, so the behaviour is identical and only the speed
// differs. A failed chunk returns nulls for that chunk rather than throwing, which keeps the
// isolation the ladder had before: a bad read degrades those rows to "finding a number" and the
// rest of the queue carries on.
const CHUNK=400;
export async function batchGet(redis,keys){
 const out=new Map();
 if(!keys.length)return out;
 if(typeof redis.mget!=='function'){
  for(const k of keys){let v=null;try{v=await redis.get(k);}catch{v=null;}out.set(k,v??null);}
  return out;
 }
 for(let i=0;i<keys.length;i+=CHUNK){
  const chunk=keys.slice(i,i+CHUNK);
  let vals=null;
  try{vals=await redis.mget(chunk);}catch{vals=null;}
  chunk.forEach((k,j)=>out.set(k,vals&&Array.isArray(vals)?(vals[j]??null):null));
 }
 return out;
}

export async function withCallPhones(state,{redis,crm,now=Date.now()}){
 // A wrong number is a failed NUMBER, not a failed lead. Codex's brief: wrong-party numbers go to
 // background research, not a dead end. callReady never re-offers a wrong_number outcome, so such a
 // lead is brought back in here only when the SAME policy says it would be ready had the bad call
 // not happened: four sent emails, the 48-hour wait, still in its campaign. Nothing skips a rule.
 const retryable=r=>r.callOutcome==='wrong_number'&&callReady({...r,callOutcome:null,nextCallAt:null});
 for(const r of state.records)if(retryable(r))r.callReady=true,r.wrongNumberRetry=true;
 const due=state.records.filter(r=>r.callReady);if(!due.length)return state;
 const lower=r=>r.recipient.toLowerCase();

 // Stage 1: the CRM number, cached five minutes per address.
 const phones=new Map(),missing=[];
 const cachedPhones=await batchGet(redis,due.map(r=>'staffify:call-phone:'+lower(r)));
 for(const row of due){const cached=cachedPhones.get('staffify:call-phone:'+lower(row));if(cached&&now-Date.parse(cached.checkedAt)<5*60000)phones.set(row.recipient,cached);else missing.push(row.recipient);}
 try{
  if(missing.length){const account=await crm('/account-info/v3/details');if(String(account.portalId)!=='51666712')throw Error('Wrong CRM');}
  for(let i=0;i<missing.length;i+=100){const emails=missing.slice(i,i+100);const page=await crm('/crm/v3/objects/contacts/batch/read',{idProperty:'email',inputs:emails.map(id=>({id})),properties:['email','phone','mobilephone']});
   for(const c of page.results||[]){const p=c.properties,email=String(p.email||'').toLowerCase(),phone=String(p.phone||'').trim()||String(p.mobilephone||'').trim()||null;if(!emails.includes(email))continue;const value={phone,phoneStatus:phone?'available':'missing',phoneSource:p.phone?.trim()?'HubSpot phone':'HubSpot mobile',crmContactId:c.id,checkedAt:new Date(now).toISOString()};phones.set(email,value);await redis.set('staffify:call-phone:'+email,value,{ex:300});}
  }
 }catch{for(const email of missing)if(!phones.has(email))phones.set(email,{phone:null,phoneStatus:'unavailable'});}

 // Stage 2: what the business's own website said about the CRM number.
 const evidenceVals=await batchGet(redis,due.map(r=>'staffify:call-phone-evidence:'+r.recipient));
 const evidence=new Map();for(const row of due){const v=evidenceVals.get('staffify:call-phone-evidence:'+row.recipient);if(v)evidence.set(row.recipient,v);}
 // Paul, 2026-10-22, on a card reading "Number not confirmed. Research before calling.":
 // "our sales people shouldn't have to do this."
 //
 // This line used to set phone:null whenever the website check did not corroborate the CRM number,
 // so a caller was handed NO number and a research task. An uncorroborated main line is a worse
 // call than a direct dial and a far better call than nothing. The number is kept, and what we know
 // about it travels with it so the card can be honest instead of silent.
 for(const [email,v] of evidence){const c=phones.get(email)||{};const corroborated=v.status==='business_listed';
  phones.set(email,{...c,phone:corroborated?v.phone:(c.phone||v.phone||null),phoneStatus:corroborated?v.status:(c.phone||v.phone)?'crm_unconfirmed':v.status,
   phoneSource:corroborated?'Listed on business website':(c.phone||v.phone)?'From the CRM, not found on their website':'No number on file',
   phoneDetail:corroborated?null:(c.phone||v.phone)?'Not published on their website, so expect a main line or a front desk. Ask for them by name.':null,
   phoneEvidence:v});}

 // Stage 3: a vendor direct dial, for contacts whose number is published nowhere: enterprise CEOs
 // mostly. Applied ONLY where nothing else produced a number, and never under the business_listed
 // label, which means "we found this on their own website" and must keep meaning exactly that. The
 // provenance travels with it so the card can say where it came from.
 const needVendor=due.filter(r=>!(phones.get(r.recipient)?.phone));
 const vendorVals=await batchGet(redis,needVendor.map(r=>'staffify:call-phone-vendor:'+lower(r)));
 for(const row of needVendor){
  const current=phones.get(row.recipient);
  const v=vendorVals.get('staffify:call-phone-vendor:'+lower(row));
  if(!v||!v.phone)continue;
  phones.set(row.recipient,{...(current||{}),phone:v.phone,phoneStatus:'vendor_direct',
   phoneSource:v.source||'vendor',phoneType:v.type||null,phoneCheckedAt:v.checkedAt||null,
   phoneDetail:'Direct dial supplied by '+(v.source||'a data vendor')+'. Not published on the business website and not carrier-verified, so treat it as a direct line rather than a confirmed mobile.'});
 }

 // Stage 4: last resort before giving a caller nothing: the number the business publishes on its
 // own site, collected ahead of time by /api/outreach-site-phone. It is a main line rather than a
 // direct dial, which is why it sits below the vendor dial and says so on the card.
 const needSite=due.filter(r=>!(phones.get(r.recipient)?.phone));
 const siteVals=await batchGet(redis,needSite.map(r=>'staffify:call-site-phone:'+lower(r)));
 for(const row of needSite){
  const current=phones.get(row.recipient);
  const v=siteVals.get('staffify:call-site-phone:'+lower(row));
  if(!v||!v.phone)continue;
  phones.set(row.recipient,{...(current||{}),phone:v.phone,phoneStatus:'site_main',phoneSource:'Published on their website',
   phoneSourceUrl:v.sourceUrl||null,phoneAlternates:Array.isArray(v.alternates)?v.alternates:[],phoneCheckedAt:v.checkedAt||null,
   phoneDetail:'Main line published on their own site. Ask for them by name. '+(v.sourceUrl?'Source: '+v.sourceUrl:'')});
 }

 // Stage 5: a number a caller logged as wrong is never offered again for that person, whichever
 // source produced it. The research below then treats the lead as having no number and looks again.
 const badVals=await batchGet(redis,due.map(r=>BAD_KEY(r.recipient)));
 for(const row of due){
  const bad=badSetFrom(badVals.get(BAD_KEY(row.recipient)));
  const c=phones.get(row.recipient);
  if(bad.size&&c&&c.phone&&isBad(bad,c.phone)){phones.set(row.recipient,{...c,phone:null,phoneStatus:'wrong_number',
   phoneDetail:'The number on file was logged as a wrong number. A different one is being looked for.'});continue;}
  // A wrong number logged before we recorded WHICH number it was. We cannot tell the bad one from a
  // good one, so nothing on file is offered: the caller would ring the same wrong line again.
  if(row.wrongNumberRetry&&!bad.size&&c&&c.phone)phones.set(row.recipient,{...c,phone:null,phoneStatus:'wrong_number',
   phoneDetail:'Logged as a wrong number before the dialled number was recorded, so no number on file can be trusted. A fresh one is being looked for.'});
 }

 // Stage 6: a live eligibility failure recorded by the brief, keyed to the send it was checked against.
 const blockVals=await batchGet(redis,due.map(r=>'staffify:call-block:'+r.id));
 const blocked=new Map();for(const row of due){const v=blockVals.get('staffify:call-block:'+row.id);if(v&&v.lastSentAt===row.lastSentAt)blocked.set(row.id,v);}

 // Stage 7. Paul, 2026-10-22: "There needs to never be someone in there without a number... it
 // should just do what it needs to in order to get the number."
 //
 // A record with no usable number LEAVES Ready to call. It is not deleted, no number is invented
 // for it, and it is not handed to a caller as a card they cannot work. It carries a research
 // status instead, and the background pass works the backlog on its own.
 //
 // Each row is still isolated. A null from a failed chunk, or a status that cannot be computed,
 // degrades that one row to "researching" and the queue carries on.
 const needResearch=due.filter(r=>!(phones.get(r.recipient)?.phone));
 const researchVals=await batchGet(redis,needResearch.map(r=>ATTEMPTS(r.recipient)));
 const research=new Map();
 for(const row of needResearch){
  const st=researchVals.get(ATTEMPTS(row.recipient));
  try{research.set(row.id,researchStatus(row,st));}
  catch{research.set(row.id,{state:'researching',label:'Finding a number',detail:'Research status unavailable.',callable:false});}
 }

 const counts={callable:0,findingNumber:0,noNumberPossible:0,blocked:0};
 for(const row of due){
  if(blocked.has(row.id)){counts.blocked++;continue;}
  const r=research.get(row.id);
  if(!r)counts.callable++;
  else if(r.state==='exhausted')counts.noNumberPossible++;
  else counts.findingNumber++;
 }
 return {...state,numberWork:counts,records:state.records.map(r=>{if(!r.callReady)return r;
   // Not callable without a number, whatever else is true of the record.
   const ready=!blocked.has(r.id)&&!research.has(r.id);
   return {...r,
   callReady:ready,
   // The shared view decides what to OFFER from unclaimed / dueForMe, which sharedCallState set
   // before this ladder ran. Left alone, a lead this ladder holds back (blocked, or a wrong number
   // still being replaced) kept being offered, and one that came back with a new number never was.
   // So they follow the final decision. First-work ownership is unchanged: unclaimed still needs
   // nobody to own it, and dueForMe still needs it to be yours.
   ...('unclaimed' in r?{unclaimed:ready&&!r.callOwner}:{}),
   ...('dueForMe' in r?{dueForMe:ready&&!!r.mine}:{}),
   callBlock:blocked.get(r.id)||null,
   numberResearch:research.get(r.id)||null,
   callContact:phones.get(r.recipient)||{phone:null,phoneStatus:'missing'}};})};
}
