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
 for(const [email,v] of evidence){const c=phones.get(email)||{};phones.set(email,{...c,phone:v.status==='business_listed'?v.phone:null,phoneStatus:v.status,phoneSource:v.status==='business_listed'?'Listed on business website':'Number needs confirmation',phoneEvidence:v});}
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
 const blocked=new Map();for(const row of due){const v=await redis.get('staffify:call-block:'+row.id);if(v&&v.lastSentAt===row.lastSentAt)blocked.set(row.id,v);}
 return {...state,records:state.records.map(r=>r.callReady?{...r,callReady:!blocked.has(r.id),callBlock:blocked.get(r.id)||null,callContact:phones.get(r.recipient)||{phone:null,phoneStatus:'missing'}}:r)};
}
