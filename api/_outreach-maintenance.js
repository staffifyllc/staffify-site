import {createHash} from 'node:crypto';
import {refreshClients,putSnapshot,normCompany} from './_client-guard.js';
import SHIPPED from './_client-snapshot.json' with {type:'json'};
const HASH=v=>createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex').slice(0,32);
const asDoc=v=>typeof v==='string'?JSON.parse(v):v;
export async function maintainClients({redis,fetchImpl=fetch,env=process.env,now=Date.now(),refresh=refreshClients,put=putSnapshot}={}){
 const last=await redis.get('outreach:cloud:client-refresh');
 if(last?.ok&&now-Date.parse(last.at)<24*3600000)return last;
 try {
  if(!env.TALENT_CLIENTS_URL||!env.TALENT_CLIENTS_KEY||!env.HUBSPOT_TOKEN)throw Error('Cloud client-source credentials missing');
  const account=await fetchImpl('https://api.hubapi.com/account-info/v3/details',{headers:{Authorization:'Bearer '+env.HUBSPOT_TOKEN},signal:AbortSignal.timeout(15000)});
  if(!account.ok||String((await account.json()).portalId)!=='51666712')throw Error('Customer CRM portal could not be verified');
  const hs=await refresh({redis,fetch:fetchImpl});if(!hs.ok)throw Error(hs.why);
  const prior=asDoc(await redis.get('clients:snapshot'))||SHIPPED;
  const live=asDoc(await redis.get('clients:hubspot:cache'));if(!live?.emails?.length)throw Error('Live customer cache missing');
  // Keep every previously known customer, including the legacy CSV; add fresh CRM and roster data.
  const emails=new Set((prior?.emails||[]).map(v=>v.includes('@')?HASH(v):v));
  const companies=new Set((prior?.companies||[]).map(v=>/^[a-f0-9]{32}$/.test(v)?v:HASH(v)));
  for(const e of live.emails)emails.add(HASH(e));for(const c of live.companies||[])companies.add(HASH(c));
  let count=0,complete=false;
  for(let offset=0;offset<10000;offset+=500){
   const url=env.TALENT_CLIENTS_URL.replace(/\/$/,'')+'/rest/v1/snapshot_clients?select=business_name,contact_email,stripe_email,stage_label&limit=500&offset='+offset;
   const r=await fetchImpl(url,{headers:{apikey:env.TALENT_CLIENTS_KEY,Authorization:'Bearer '+env.TALENT_CLIENTS_KEY},signal:AbortSignal.timeout(15000)});
   if(!r.ok)throw Error('Talent client roster unavailable: '+r.status);const rows=await r.json();if(!Array.isArray(rows))throw Error('Invalid talent client roster');
   for(const row of rows){if(String(row.stage_label||'').toLowerCase()==='discovery call')continue;count++;for(const e of [row.contact_email,row.stripe_email])if(e)emails.add(HASH(e));const c=normCompany(row.business_name);if(c.length>=4)companies.add(HASH(c));}
   if(rows.length<500){complete=true;break;}
  }
  if(!complete||!count)throw Error('Talent roster incomplete or empty');
  const saved=await put({emails:[...emails],companies:[...companies],sources:[{source:'retained-known-customers',count:prior?.emails?.length||0},{source:'hubspot-live',count:live.emails.length},{source:'talent-console-live',count}]},{redis});if(!saved.ok)throw Error(saved.why);
  const result={ok:true,at:new Date(now).toISOString(),emails:emails.size,companies:companies.size,rosterClients:count};await redis.set('outreach:cloud:client-refresh',result);return result;
 }catch(e){const result={ok:false,at:new Date(now).toISOString(),reason:String(e.message).slice(0,180)};await redis.set('outreach:cloud:client-refresh',result);throw Error('Client refresh failed: '+result.reason);}
}
