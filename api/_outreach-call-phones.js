export async function withCallPhones(state,{redis,crm,now=Date.now()}){
 const due=state.records.filter(r=>r.callReady);if(!due.length)return state;
 const phones=new Map(),missing=[];
 for(const row of due){const key='staffify:call-phone:'+row.recipient.toLowerCase();const cached=await redis.get(key);if(cached&&now-Date.parse(cached.checkedAt)<5*60000)phones.set(row.recipient,cached);else missing.push(row.recipient);}
 try{
  if(missing.length){const account=await crm('/account-info/v3/details');if(String(account.portalId)!=='51666712')throw Error('Wrong CRM');}
  for(let i=0;i<missing.length;i+=100){const emails=missing.slice(i,i+100);const page=await crm('/crm/v3/objects/contacts/batch/read',{idProperty:'email',inputs:emails.map(id=>({id})),properties:['email','phone','mobilephone']});
   for(const c of page.results||[]){const p=c.properties,email=String(p.email||'').toLowerCase(),phone=String(p.phone||'').trim()||String(p.mobilephone||'').trim()||null;if(!emails.includes(email))continue;const value={phone,phoneStatus:phone?'available':'missing',phoneSource:p.phone?.trim()?'HubSpot phone':'HubSpot mobile',crmContactId:c.id,checkedAt:new Date(now).toISOString()};phones.set(email,value);await redis.set('staffify:call-phone:'+email,value,{ex:300});}
  }
 }catch{for(const email of missing)if(!phones.has(email))phones.set(email,{phone:null,phoneStatus:'unavailable'});}
 const evidence=new Map();for(const row of due){const v=await redis.get('staffify:call-phone-evidence:'+row.recipient);if(v)evidence.set(row.recipient,v);}
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
 // A vendor direct dial, for contacts whose number is published nowhere: enterprise CEOs mostly.
 // Applied ONLY where nothing else produced a number, and never under the business_listed label,
 // which means "we found this on their own website" and must keep meaning exactly that. The
 // provenance travels with it so the card can say where it came from.
 for(const row of due){
  const current=phones.get(row.recipient);
  if(current&&current.phone)continue;
  const v=await redis.get('staffify:call-phone-vendor:'+row.recipient.toLowerCase());
  if(!v||!v.phone)continue;
  phones.set(row.recipient,{...(current||{}),phone:v.phone,phoneStatus:'vendor_direct',
   phoneSource:v.source||'vendor',phoneType:v.type||null,phoneCheckedAt:v.checkedAt||null,
   phoneDetail:'Direct dial supplied by '+(v.source||'a data vendor')+'. Not published on the business website and not carrier-verified, so treat it as a direct line rather than a confirmed mobile.'});
 }
 // Last resort before giving a caller nothing: the number the business publishes on its own site,
 // collected ahead of time by /api/outreach-site-phone. It is a main line rather than a direct
 // dial, which is why it sits below the vendor dial and says so on the card.
 for(const row of due){
  const current=phones.get(row.recipient);
  if(current&&current.phone)continue;
  const v=await redis.get('staffify:call-site-phone:'+row.recipient.toLowerCase());
  if(!v||!v.phone)continue;
  phones.set(row.recipient,{...(current||{}),phone:v.phone,phoneStatus:'site_main',phoneSource:'Published on their website',
   phoneSourceUrl:v.sourceUrl||null,phoneAlternates:Array.isArray(v.alternates)?v.alternates:[],phoneCheckedAt:v.checkedAt||null,
   phoneDetail:'Main line published on their own site. Ask for them by name. '+(v.sourceUrl?'Source: '+v.sourceUrl:'')});
 }
 const blocked=new Map();for(const row of due){const v=await redis.get('staffify:call-block:'+row.id);if(v&&v.lastSentAt===row.lastSentAt)blocked.set(row.id,v);}
 return {...state,records:state.records.map(r=>r.callReady?{...r,callReady:!blocked.has(r.id),callBlock:blocked.get(r.id)||null,callContact:phones.get(r.recipient)||{phone:null,phoneStatus:'missing'}}:r)};
}
