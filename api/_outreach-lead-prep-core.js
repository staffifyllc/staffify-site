import {INVENTORY,emailKey,mergeInventory,inventorySummary,localBlock,dueInventory,location} from './_outreach-inventory.js';
import {randomUUID} from 'node:crypto';
const LOCK='staffify:lead-prep:lock',STATUS='staffify:lead-prep:last-run';
export function makeLeadPrep(deps){
 const {redis,readBody,config,draftBlockReason,site,verifyEmail,isOptedOut,clientCheck,hs,KEY}=deps;
async function find(email){const d=await hs('/crm/v3/objects/contacts/search',{filterGroups:[{filters:[{propertyName:'email',operator:'EQ',value:email}]}],properties:['email','company','website','firstname','lastname','city','state','country','rep_lifecycle_state'],limit:2});if(d.results.length>1)throw Error('Ambiguous CRM contact');return d.results[0]||null;}
return async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');if(!process.env.CRON_SECRET||req.headers.authorization!=='Bearer '+process.env.CRON_SECRET)return res.status(401).json({error:'Unauthorized'});
 if(req.query?.action==='inventory'&&req.method==='GET')return res.status(200).json(inventorySummary(await redis.get(INVENTORY)));
 const nonce=randomUUID();if(!await redis.set(LOCK,nonce,{nx:true,ex:300}))return res.status(200).json({status:'already_running'});
 const started=Date.now(),report={startedAt:new Date().toISOString(),scanned:0,checked:0,verified:0,held:0,imported:0,reasons:{},status:'complete'};
 let inventory;
 try{
  inventory=await redis.get(INVENTORY)||{records:[]};
  if(req.query?.action==='import'&&req.method==='POST'){const body=readBody(req);if(!Array.isArray(body.records)||body.records.length>250)throw Error('Import requires at most 250 records');inventory=mergeInventory(inventory,body.records);await redis.set(INVENTORY,inventory);return res.status(200).json(inventorySummary(inventory));}
  const cfg=await config();if(!cfg.enabled||cfg.draftingEnabled===false)return res.status(200).json({status:'paused'});
  const portal=await hs('/account-info/v3/details',null,'GET');if(String(portal.portalId)!=='51666712')throw Error('Wrong CRM portal');
  let state=await redis.get(KEY);if(!state)throw Error('Queue unavailable');
  const cursor=await redis.get('staffify:lead-prep:list-cursor:v3');
  const query=new URLSearchParams({limit:'30',properties:'email,website,company',archived:'false'});if(cursor)query.set('after',String(cursor));
  const page=await hs('/crm/v3/objects/contacts?'+query.toString(),null,'GET');
  const recovered=dueInventory(inventory),emails=new Set(recovered.map(r=>r.email)),inventoryEmails=new Set(inventory.records.map(r=>r.email));
  const candidates=[...recovered,...(page.results||[]).filter(c=>c.properties?.email&&!inventoryEmails.has(String(c.properties.email).toLowerCase())).map(c=>({email:String(c.properties.email).toLowerCase(),company:c.properties.company,domain:c.properties.website,crmId:c.id}))];
  let crmPageComplete=true;
  for(const item of candidates){
   if(Date.now()-started>210000){report.status='yielded';crmPageComplete=false;break;}
   const cache='staffify:lead-prep:v2:'+emailKey(item.email),isRecovered=emails.has(item.email);report.scanned++;
   if(!isRecovered&&await redis.get(cache)){report.reasons['Recently reviewed']=(report.reasons['Recently reviewed']||0)+1;continue;}
   const finish=async(reason,days=1)=>{report.reasons[reason]=(report.reasons[reason]||0)+1;if(reason!=='Verified and available to supply')report.held++;const result={reason,at:new Date().toISOString()};if(isRecovered){item.result=result;item.nextAt=new Date(Date.now()+days*86400000).toISOString();inventory.updatedAt=result.at;await redis.set(INVENTORY,inventory);}else await redis.set(cache,result,{ex:Math.max(60,Math.ceil(days*86400))});};
   try{
    state=await redis.get(KEY);let blocked=localBlock(item,state);if(blocked){await finish(blocked,1);continue;}
    if(await isOptedOut({email:item.email})){await finish('Global opt-out',30);continue;}
    let c=await find(item.email),p=c?.properties||{};
    if(c&&p.rep_lifecycle_state&&p.rep_lifecycle_state!=='ACTIVE_OUTREACH'){await finish('CRM lifecycle requires review',1);continue;}
    const company=p.company||item.company,website=p.website||item.domain;if(!company||!website){await finish('Missing company or website',7);continue;}
    const row={recipient:item.email,company};
    if(c){blocked=await draftBlockReason(row,{requireVerified:false});if(blocked){await finish(blocked,1);continue;}}
    else{if(['trey tatro','mike haymes','blake watkins'].includes((item.first+' '+item.last).trim().toLowerCase())){await finish('Explicit exclusion',30);continue;}const client=await clientCheck({email:item.email,company});if(client.status!=='clear'){await finish('Client check: '+client.status,1);continue;}}
    report.checked++;const evidence=await site(website);
    if(!/real[ -]estate.{0,50}(photograph|videograph|media)|(?:property|architectural) photography/i.test(evidence.text)){await finish('Website does not establish real estate media services',30);continue;}
    const agencyKey=new URL(evidence.url).hostname.replace(/^www\./,'');
    if(state.records.some(r=>r.recipient!==item.email&&(r.agencyKey===agencyKey||r.company?.toLowerCase()===company.toLowerCase()))||state.assignments.some(a=>a.email!==item.email&&a.agencyKey===agencyKey)){await finish('Company already assigned or enrolled',7);continue;}
    const day=new Date().toISOString().slice(0,10),spent=Number(await redis.eval("local n=tonumber(redis.call('GET',KEYS[1]) or '0');if n>=350 then return -1 end;n=redis.call('INCR',KEYS[1]);redis.call('EXPIRE',KEYS[1],172800);return n",['staffify:lead-prep:budget:'+day],[]));
    if(spent<0){report.status='daily_prep_limit';crmPageComplete=false;break;}
    const result=await verifyEmail(item.email,{redis});if(result.status==='unavailable'){report.status='provider_unavailable';report.reason=result.reason;crmPageComplete=false;break;}
    if(result.status!=='verified'){await finish('Verification: '+result.status,30);continue;}
    state=await redis.get(KEY);blocked=localBlock(item,state);if(blocked||await isOptedOut({email:item.email})){await finish(blocked||'Global opt-out',1);continue;}
    const loc=location(item);
    if(!c){
     // Exact-email uniqueness makes retries safe after an uncertain create response.
     c=await find(item.email);
     if(!c){const client=await clientCheck({email:item.email,company});if(client.status!=='clear'){await finish('Client check: '+client.status,1);continue;}
      c=await hs('/crm/v3/objects/contacts',{properties:{email:item.email,company,website:evidence.url,firstname:item.first||'',lastname:item.last||'',...Object.fromEntries(Object.entries(loc).filter(([,v])=>v)),rep_lifecycle_state:'ACTIVE_OUTREACH'}});report.imported++;
     }
    }
    const freshBlock=await draftBlockReason(row,{requireVerified:false});if(freshBlock){await finish(freshBlock,1);continue;}
    // Never overwrite ownership, a nonempty lifecycle, or an existing location.
    const live=await find(item.email);if(live.properties.rep_lifecycle_state&&live.properties.rep_lifecycle_state!=='ACTIVE_OUTREACH'){await finish('CRM lifecycle changed',1);continue;}
    const sameCountry=!live.properties.country||live.properties.country.toLowerCase()===String(loc.country||'').toLowerCase();
    const fill=sameCountry?Object.fromEntries(Object.entries(loc).filter(([k,v])=>v&&!live.properties[k])):{};
    await hs('/crm/v3/objects/contacts/'+c.id,{properties:{...fill,...(!live.properties.rep_lifecycle_state?{rep_lifecycle_state:'ACTIVE_OUTREACH'}:{}),rep_email_verified:'verified'}},'PATCH');report.verified++;
    await redis.sadd('staffify:lead-prep:ready',item.email);
    await finish('Verified and available to supply',7);
   }catch(e){await finish('Retry: '+e.message,1/24);report.lastRetryReason=e.message;report.retries=(report.retries||0)+1;if(/CRM unavailable|Wrong CRM/.test(e.message)){report.status='error';report.reason=e.message;crmPageComplete=false;break;}}
  }
  if(crmPageComplete)await redis.set('staffify:lead-prep:list-cursor:v3',page.paging?.next?.after||null);
  if(report.status==='complete'&&report.retries&&report.retries===report.checked)report.status='retrying';
  report.crmInventory={scope:'All existing Staffify CRM contacts with an email',matchingContacts:page.total??null,pageSize:(page.results||[]).length,nextCursor:crmPageComplete?(page.paging?.next?.after||null):(cursor||null),cycleComplete:crmPageComplete&&!page.paging?.next?.after};
  report.inventory=inventorySummary(inventory);report.finishedAt=new Date().toISOString();await redis.set(STATUS,report);return res.status(200).json(report);
 }catch(e){report.status='error';report.reason=e.message;await redis.set(STATUS,report);return res.status(503).json(report);}
 finally{await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",[LOCK],[nonce]);}
}

}
