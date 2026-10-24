import {randomUUID} from 'node:crypto';
import {redis} from './_auth.js';
import {config} from './_outreach-gmail.js';
import {slackNotify} from './_slack.js';
import {checkAlerts,incidents} from './_outreach-alerts.js';
import {requireAccess} from './_auth.js';
import {ownerFor} from './_outreach-queue.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 // ?status=1: the same snapshot the alerts use, read by a signed-in person, no Slack, no lock.
 // Paul, 2026-10-23: the dashboard should run "like a machine, on its own"; the first step is
 // saying, on the dashboard, which lane is running, which is blocked, and what unblocks it.
 if(req.method==='GET'&&req.query?.status){
  const rep=await requireAccess(req);if(!rep)return res.status(401).json({error:'Sign in to your Staffify account'});
  if(!(ownerFor(rep)||rep.role==='admin'))return res.status(403).json({error:'Owners and admins only'});
  try{
   const [cfg,run,health,prep,companyPrep,companyHistory,research,optoutSince,queueStamp]=await Promise.all([config(),redis.get('outreach:cloud:last-run'),redis.get('outreach:cloud:health'),redis.get('staffify:lead-prep:last-run'),redis.get('staffify:company-prep:last-run'),redis.get('staffify:company-prep:runs').catch(()=>null),redis.get('staffify:number-research:last-run').catch(()=>null),redis.get('optout:scan:since').catch(()=>null),redis.get('staffify:alerts:last-run').catch(()=>null)]);
   const now=Date.now();const age=v=>v&&Number.isFinite(Date.parse(v))?Math.round((now-Date.parse(v))/60000):null;
   const failing=(health?.accounts||[]).filter(a=>!a.ok).map(a=>a.email);
   const lanes=[
    {id:'email',label:'Email worker',ok:!!cfg.enabled&&['complete','reconciled'].includes(run?.status||'')&&!failing.length,state:!cfg.enabled?'paused':failing.length?'blocked':run?.status==='reconciled'?'complete':run?.status||'unknown',lastRunMinutesAgo:age(run?.finishedAt),detail:failing.length?'Mailbox authorization expired: '+failing.join(', '):run?.reason||(['complete','reconciled'].includes(run?.status||'')?'Running on schedule':run?.status?'Last run ended: '+run.status:'No run recorded'),unblock:failing.length?'Reconnect the mailbox under Inbox, Mailbox connections.':null,link:'/outreach-review/'},
    {id:'prep',label:'Lead preparation',ok:!!prep&&!['error','provider_unavailable','retrying'].includes(prep.status||''),state:prep?.status==='daily_prep_limit'?'budget spent for today':prep?.status==='yielded'?'complete':prep?.status||'unknown',lastRunMinutesAgo:age(prep?.finishedAt||prep?.startedAt),detail:prep?.reason||prep?.detail||null,unblock:['error','provider_unavailable','retrying'].includes(prep?.status||'')?'Check CRM access and Findymail credits.':null,link:'/outreach-review/'},
    {id:'research',label:'Number and name research',ok:!!research?.ranAt,state:research?.ranAt?'ran':'unknown',lastRunMinutesAgo:age(research?.ranAt),detail:research?(`names checked ${research.identity?.checked||0}, found ${research.identity?.found||0}; numbers found ${(research.website?.found||0)+(research.vendor?.found||0)}; ${research.failureCount??(research.failures||[]).length} failures`):'No run recorded',unblock:null,link:'/dialer/'},
    {id:'stop',label:'STOP sweep (Quo)',ok:!!optoutSince&&age(optoutSince)!=null&&age(optoutSince)<=90,state:optoutSince?'ran':'unknown',lastRunMinutesAgo:age(optoutSince),detail:optoutSince?'Last swept to '+new Date(optoutSince).toLocaleString('en-US',{timeZone:'America/New_York'})+' ET':'No sweep recorded',unblock:null,link:null},
   ];
   return res.status(200).json({checkedAt:new Date(now).toISOString(),sendingEnabled:cfg.sendingEnabled===true,draftingEnabled:cfg.draftingEnabled!==false,lanes,incidents:incidents({cfg,run,health,prep,companyPrep,companyHistory},now).map(i=>({id:i.id,title:i.title,impact:i.impact,action:i.action})),alertsCheckedAt:queueStamp?.checkedAt||null});
  }catch(e){return res.status(503).json({error:'Status unavailable: '+String((e&&e.message)||e).slice(0,120)});}
 }
 if(!process.env.CRON_SECRET||req.headers.authorization!=='Bearer '+process.env.CRON_SECRET)return res.status(401).json({error:'Unauthorized'});
 const lock='staffify:alerts:lock',nonce=randomUUID();if(!await redis.set(lock,nonce,{nx:true,ex:240}))return res.status(200).json({status:'already_running'});
 try{
 if(req.method==='POST'&&req.query?.action==='test'){
 const result=await slackNotify(':white_check_mark: *Staffify alert delivery test*\nThis is a connection test, not a claim that outreach is fully operational.\nCloud checks will report failures and recovery here.\n<https://www.gostaffify.com/outreach-review/|Open Sales Hub>');
 await redis.set('staffify:alerts:delivery-test',{...result,checkedAt:new Date().toISOString()});return res.status(result.ok?200:503).json(result);}
 const [cfg,run,health,prep,companyPrep,companyHistory]=await Promise.all([config(),redis.get('outreach:cloud:last-run'),redis.get('outreach:cloud:health'),redis.get('staffify:lead-prep:last-run'),redis.get('staffify:company-prep:last-run'),redis.get('staffify:company-prep:runs')]);
 return res.status(200).json(await checkAlerts({redis,notify:slackNotify,snapshot:{cfg,run,health,prep,companyPrep,companyHistory}}));
 }catch{return res.status(503).json({error:'Health monitor unavailable'});}
 finally{await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",[lock],[nonce]);}
}
