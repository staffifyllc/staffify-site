import {redis} from './_auth.js';
import {KEY} from './_outreach-queue.js';
import {config} from './_outreach-gmail.js';
import {draftBlockReason} from './_outreach-crm.js';
import {site} from './_outreach-supply.js';
import {verifyEmail} from './_outreach-verification.js';
import {randomUUID,createHash} from 'node:crypto';
const LOCK='staffify:lead-prep:lock',STATUS='staffify:lead-prep:last-run';
async function hs(path,body,method='POST'){const r=await fetch('https://api.hubapi.com'+path,{method,headers:{Authorization:'Bearer '+process.env.HUBSPOT_TOKEN,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('CRM unavailable');return r.json();}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');if(!process.env.CRON_SECRET||req.headers.authorization!=='Bearer '+process.env.CRON_SECRET)return res.status(401).json({error:'Unauthorized'});
 const nonce=randomUUID();if(!await redis.set(LOCK,nonce,{nx:true,ex:300}))return res.status(200).json({status:'already_running'});
 const started=Date.now();const report={startedAt:new Date().toISOString(),checked:0,verified:0,held:0,status:'complete'};
 try{
  const cfg=await config();if(!cfg.enabled||cfg.draftingEnabled===false)return res.status(200).json({status:'paused'});
  const portal=await hs('/account-info/v3/details',null,'GET');if(String(portal.portalId)!=='51666712')throw Error('Wrong CRM portal');
  const state=await redis.get(KEY);if(!state)throw Error('Queue unavailable');
  const cursor=await redis.get('staffify:lead-prep:cursor');
  const page=await hs('/crm/v3/objects/contacts/search',{filterGroups:[{filters:[{propertyName:'rep_lifecycle_state',operator:'EQ',value:'ACTIVE_OUTREACH'},{propertyName:'email',operator:'HAS_PROPERTY'},{propertyName:'website',operator:'HAS_PROPERTY'},{propertyName:'company',operator:'HAS_PROPERTY'}]}],properties:['email','website','company'],limit:10,...(cursor?{after:cursor}:{})});
  for(const c of page.results||[]){
   if(Date.now()-started>210000){report.status='yielded';break;}
   const p=c.properties,email=String(p.email||'').toLowerCase();
   // Existing enrollments, ownership reservations, opt-outs and client checks remain authoritative.
   if(state.records.some(r=>r.recipient===email)||state.suppressions.includes(email))continue;
   const assignment=state.assignments.find(a=>a.email===email);const owner=assignment?.owner||(Number(c.id.slice(-1))%2?'Madison':'Paul');if(state.pausedOwners.includes(owner))continue;
   const hash=createHash('sha256').update(email).digest('hex'),cache='staffify:lead-prep:review:'+hash;
   if(await redis.get(cache))continue;
   const row={recipient:email,company:p.company,owner};report.checked++;
   const blocked=await draftBlockReason(row,{requireVerified:false});if(blocked){report.held++;await redis.set(cache,{reason:blocked,at:Date.now()},{ex:86400});continue;}
   let evidence;try{evidence=await site(p.website);}catch{report.held++;await redis.set(cache,{reason:'Website unavailable',at:Date.now()},{ex:86400});continue;}
   if(!/real[ -]estate.{0,50}(photograph|videograph|media)|(?:property|architectural) photography/i.test(evidence.text)){report.held++;await redis.set(cache,{reason:'Website does not establish real estate media services',at:Date.now()},{ex:7*86400});continue;}
   const now=new Date().toISOString(),day=now.slice(0,10);
   // At most 350 background lookups/day; send-time verification has its own demand path.
   const spent=Number(await redis.eval("local n=tonumber(redis.call('GET',KEYS[1]) or '0');if n>=350 then return -1 end;n=redis.call('INCR',KEYS[1]);redis.call('EXPIRE',KEYS[1],172800);return n",['staffify:lead-prep:budget:'+day],[]));
   if(spent<0){report.status='daily_prep_limit';break;}
   const result=await verifyEmail(email,{redis});if(result.status==='unavailable'){report.status='provider_unavailable';report.reason=result.reason;break;}
   // Re-check before changing verification property. This does not enroll or override outreach controls.
   const freshBlock=await draftBlockReason(row,{requireVerified:false});if(freshBlock){report.held++;continue;}
   if(result.status==='verified'){await hs('/crm/v3/objects/contacts/'+c.id,{properties:{rep_email_verified:'verified'}},'PATCH');report.verified++;}
   else report.held++;
   await redis.set(cache,{result,website:evidence.url,checkedAt:now},{ex:7*86400});
  }
  if(report.status==='complete')await redis.set('staffify:lead-prep:cursor',page.paging?.next?.after||null);
  report.finishedAt=new Date().toISOString();await redis.set(STATUS,report);return res.status(200).json(report);
 }catch(e){report.status='error';report.reason=e.message;await redis.set(STATUS,report);return res.status(503).json(report);}
 finally{await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",[LOCK],[nonce]);}
}
