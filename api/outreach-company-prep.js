import {randomUUID} from 'node:crypto';
import {redis} from './_auth.js';
import {config} from './_outreach-gmail.js';
import {KEY} from './_outreach-queue.js';
import {INVENTORY,mergeInventory} from './_outreach-inventory.js';
import {clientCheck} from './_client-guard.js';
import {site} from './_outreach-supply.js';
import {repFit,companyHost,publishedEmail,ownerOnSite,knownCompany} from './_company-contact-research.js';
const LOCK='staffify:lead-prep:lock',STATUS='staffify:company-prep:last-run';
async function bridge(path='',body){
 if(!process.env.EXISTING_LEAD_RESEARCH_TOKEN)throw Error('Research connection missing');
 const r=await fetch('https://campaign-dashboard-green.vercel.app/api/existing-company-research'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+process.env.EXISTING_LEAD_RESEARCH_TOKEN,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(75000)});const d=await r.json();if(!r.ok)throw Error(d.error||'Research service unavailable');return d;
}
async function findEmail(name,domain){
 const cache='staffify:company-finder:'+domain,saved=await redis.get(cache);if(saved&&Date.parse(saved.expiresAt)>Date.now())return saved.email;
 if(!process.env.FINDYMAIL_KEY)throw Error('Findymail connection missing');
 const headers={Authorization:'Bearer '+process.env.FINDYMAIL_KEY,'Content-Type':'application/json'};
 const b=await fetch('https://app.findymail.com/api/credits',{headers,signal:AbortSignal.timeout(15000)});const credits=await b.json();if(!b.ok||!Number.isFinite(credits.credits)||credits.credits<1)throw Error('Findymail finder credits unavailable');
 if(!await redis.set(cache+':attempt','1',{nx:true,ex:900}))throw Error('Finder lookup cooling down');
 const r=await fetch('https://app.findymail.com/api/search/name',{method:'POST',headers,body:JSON.stringify({name,domain}),signal:AbortSignal.timeout(25000)});const d=await r.json();if(!r.ok)throw Error('Findymail lookup unavailable');
 const email=String(d.contact?.email||'').toLowerCase();const result=email.split('@')[1]===domain?email:null;
 await redis.set(cache,{email:result,expiresAt:new Date(Date.now()+30*86400000).toISOString()});return result;
}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');if(!process.env.CRON_SECRET||req.headers.authorization!=='Bearer '+process.env.CRON_SECRET)return res.status(401).json({error:'Unauthorized'});
 const nonce=randomUUID();if(!await redis.set(LOCK,nonce,{nx:true,ex:300}))return res.status(200).json({status:'already_running'});
 const start=Date.now(),report={startedAt:new Date().toISOString(),source:'Previously researched company ledger',status:'complete',scanned:0,searched:0,emailsFound:0,staged:0,held:0,reasons:{},records:[]};
 try{
  const cfg=await config();if(!cfg.enabled||cfg.draftingEnabled===false)return res.status(200).json({status:'paused'});
  const cursor=Number(await redis.get('staffify:company-prep:cursor')||0),page=await bridge('?offset='+cursor);report.budget=page.budget;report.totalCompanies=page.total;
  let offset=cursor;
  const retryKey='staffify:company-prep:retries',retries=await redis.get(retryKey)||{};
  const due=Object.values(retries).filter(r=>Date.parse(r.retryAt)<=Date.now()).slice(0,5).map(r=>({...r.company,retryItem:true}));
  for(const company of [...due,...page.records.filter(c=>!due.some(r=>r.domain===c.domain))]){
   if(Date.now()-start>210000||report.searched>=10){report.status='yielded';break;}
   const domain=company.domain,k='staffify:company-prep:result:'+domain;
   const prior=await redis.get(k);
   if(prior&&!company.retryItem){offset++;continue;}
   report.scanned++;
   const advance=()=>{if(!company.retryItem)offset++;};
   const save=async(reason,extra={})=>{const result={domain,company:company.name,reason,at:new Date().toISOString(),...extra};await redis.set(k,result);report.reasons[reason]=(report.reasons[reason]||0)+1;report.records.push(result);if(reason!=='Email staged for verification')report.held++;delete retries[domain];await redis.set(retryKey,retries);advance();};
   try{
    if(company.pool!=='REP'||company.klass!=='REP_OWNER'){await save('Outside real estate media campaign');continue;}
    const state=await redis.get(KEY);if(!state)throw Error('Outreach queue unavailable');
    if(knownCompany(company,state)){await save('Company already assigned or enrolled');continue;}
    const client=await clientCheck({company:company.name});if(client.status==='unknown')throw Error('Client sources unavailable');if(client.status!=='clear'){await save('Client check: '+client.status);continue;}
    let home;try{home=await site(company.website||domain);}catch{home=null;}
    // Paid research is restricted to this saved company; it never invents a new prospect.
    const research=await bridge('',{domain,kind:'contact'});if(!research.cached)report.searched++;report.budget=research.budget||report.budget;
    const candidates=[...(home?[home]:[])];
    for(const r of research.results||[]){
     if(candidates.length>=4)break;
     try{if(companyHost(r.url)!==domain||candidates.some(p=>p.url===r.url))continue;candidates.push(await site(r.url));}catch{}
    }
    if(!candidates.length){await save('Business website unavailable');continue;}
    if(!candidates.some(p=>repFit(p.text))){await save('Website does not establish real estate media services');continue;}
    let email=candidates.map(p=>publishedEmail(p,domain)).find(Boolean),name='';
    if(!email){
     const ownerResearch=await bridge('',{domain,kind:'owner'});if(!ownerResearch.cached)report.searched++;
     for(const r of ownerResearch.results||[]){try{if(companyHost(r.url)===domain&&!candidates.some(p=>p.url===r.url)&&candidates.length<6)candidates.push(await site(r.url));}catch{}}
     email=candidates.map(p=>publishedEmail(p,domain)).find(Boolean);
     if(!email){name=candidates.map(ownerOnSite).find(Boolean)||'';if(name)email=await findEmail(name,domain);}
    }
    if(!email){await save('No evidenced business email or owner found',{sources:candidates.map(p=>p.url)});continue;}
    report.emailsFound++;
    const fresh=await redis.get(KEY);if(knownCompany(company,fresh)||fresh.suppressions.includes(email)){await save('Company assigned or email suppressed during research');continue;}
    const inv=await redis.get(INVENTORY)||{records:[]};
    const previous=inv.records.find(r=>r.email===email);
    if(previous){
     if(!previous.domain||!previous.company){previous.domain=previous.domain||'https://'+domain;previous.company=previous.company||company.name;previous.companyResearch={checkedAt:new Date().toISOString(),sources:candidates.map(p=>p.url)};previous.nextAt=new Date().toISOString();await redis.set(INVENTORY,inv);report.staged++;await save('Existing contact details recovered for verification',{email});}
     else await save('Already in existing-email inventory',{email});continue;
    }
    const record={email,company:company.name,domain:'https://'+domain,first:name.split(' ')[0]||'',last:name.split(' ').slice(1).join(' '),fit_review:'existing_REP',known_history:''};
    const merged=mergeInventory(inv,[record]);const added=merged.records.find(r=>r.email===email);added.companyResearch={source:'existing-research-ledger',discoveredAt:company.discoveredAt,checkedAt:new Date().toISOString(),sources:candidates.map(p=>p.url),searchQuery:research.query,identity:'published_business_email_or_evidenced_owner'};
    await redis.set(INVENTORY,merged);report.staged++;await save('Email staged for verification',{email,sources:candidates.map(p=>p.url)});
   }catch(e){
    if(/timeout|aborted|cooling down|already running|Search provider unavailable/i.test(e.message)){
     const retryAt=new Date(Date.now()+20*60000).toISOString();retries[domain]={company:{...company,retryItem:undefined},retryAt,reason:e.message};await redis.set(retryKey,retries);
     await redis.set(k,{domain,company:company.name,reason:'Temporary research failure; retry scheduled',retryAt,at:new Date().toISOString()});
     report.retries=(report.retries||0)+1;report.records.push({domain,company:company.name,reason:'Temporary research failure; retry scheduled',retryAt});advance();continue;
    }
    report.status=/Daily included-search pace reached/.test(e.message)?'paced_until_next_day':'needs_attention';report.reason=e.message;report.reasons[e.message]=(report.reasons[e.message]||0)+1;break;
   }
  }
  await redis.set('staffify:company-prep:cursor',offset);report.nextOffset=offset;report.existingPoolExhausted=offset>=page.total;
  report.finishedAt=new Date().toISOString();await redis.set(STATUS,report);const runs=await redis.get('staffify:company-prep:runs')||[];await redis.set('staffify:company-prep:runs',[report,...runs].slice(0,288));return res.status(200).json(report);
 }catch(e){report.status='error';report.reason=e.message;await redis.set(STATUS,report);return res.status(503).json(report);}
 finally{await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",[LOCK],[nonce]);}
}
