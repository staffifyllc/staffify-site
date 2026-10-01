import {slackHealth} from './_slack.js';
import {redis,requireAccess,currentRep,newToken,SITE,readBody,adminAuthorized} from './_auth.js';
import {ownerFor} from './_outreach-queue.js';
import {CONFIG,SCOPES,config,clientId,clientSecret,seal,gmail,access} from './_outreach-gmail.js';
const callback=SITE+'/api/outreach-connect/?action=callback';
export default async function handler(req,res){res.setHeader('Cache-Control','private, no-store');try{
 const who=await requireAccess(req),owner=ownerFor(who);if(!owner)return res.status(401).json({error:'Sign in to the Sales Hub'});
 const cfg=await config();const action=req.query?.action||'status';
 if(action==='health'){
  if(owner!=='all')return res.status(403).json({error:'Administrator required'});
  const selected=cfg.accounts.filter(a=>a.brand==='Staffify'&&a.draftEnabled);
  const results=await Promise.all(selected.map(async a=>{try{const t=await access(a.email);const p=await gmail(t,'profile');const m=await gmail(t,'messages?maxResults=1');if(m.messages?.length)await gmail(t,'messages/'+m.messages[0].id+'?format=full');return {email:a.email,ok:p.emailAddress?.toLowerCase()===a.email,readVerified:true};}catch(e){return {email:a.email,ok:false,error:e.message};}}));
  const health={checkedAt:new Date().toISOString(),accounts:results,ok:results.every(a=>a.ok),slack:await slackHealth()};
  await redis.set('outreach:cloud:health',health);return res.status(200).json(health);
 }
 if(action==='callback'){
  const state=await redis.getdel('outreach:oauth-state:'+String(req.query.state||''));if(!state||state.rep!==who.email)return res.status(400).json({error:'Expired authorization; start again'});
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({code:String(req.query.code||''),client_id:clientId(),client_secret:clientSecret(),redirect_uri:callback,grant_type:'authorization_code'}),signal:AbortSignal.timeout(15000)});if(!r.ok)return res.status(400).json({error:'Google authorization failed'});
  const tok=await r.json();const profile=await gmail(tok.access_token,'profile');if(profile.emailAddress.toLowerCase()!==state.email)return res.status(400).json({error:'Wrong Google account selected'});
  if(!tok.refresh_token||!SCOPES.every(s=>(tok.scope||'').split(' ').includes(s)))return res.status(400).json({error:'Both requested Gmail permissions and offline access are required'});
  await redis.set('outreach:oauth:'+state.email,seal({refresh_token:tok.refresh_token,connectedAt:new Date().toISOString()}));res.writeHead(302,{Location:'/outreach-review/'});return res.end();
 }
 if(action==='start'){
  const rep=await currentRep(req);if(!rep)return res.status(401).json({error:'Browser sign-in required'});
  const email=String(req.query.email||'').toLowerCase();const account=cfg.accounts.find(a=>a.email===email);if(!account||(owner!=='all'&&owner!==account.owner))return res.status(403).json({error:'Mailbox not assigned to you'});
  if(!clientId()||!clientSecret())return res.status(503).json({error:'Google OAuth client configuration required',redirectUri:callback});
  const state=newToken();await redis.set('outreach:oauth-state:'+state,{email,rep:who.email},{ex:600});const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');Object.entries({client_id:clientId(),redirect_uri:callback,response_type:'code',scope:SCOPES.join(' '),access_type:'offline',prompt:'consent',login_hint:email,state}).forEach(([k,v])=>url.searchParams.set(k,v));res.writeHead(302,{Location:url.toString()});return res.end();
 }
 if(req.method==='POST'){
  if(owner!=='all')return res.status(403).json({error:'Administrator required'});
  if(!adminAuthorized(req)&&req.headers.origin!==SITE)return res.status(403).json({error:'Invalid origin'});
  const body=readBody(req);if(body.action==='register'){
   const email=String(body.email||'').trim().toLowerCase();if(!/^[a-z0-9._+-]+@[a-z0-9.-]*(?:staffify|foundry)[a-z0-9.-]*\.[a-z]{2,}$/.test(email)||!['Paul','Madison'].includes(body.owner))return res.status(400).json({error:'Valid Staffify address and owner required'});
   if(cfg.enabled)return res.status(409).json({error:'Pause hosted worker before changing its mailbox inventory'});
   if(!cfg.accounts.some(a=>a.email===email)){if(cfg.accounts.length>=cfg.expectedAccounts)return res.status(400).json({error:'Expected accounts already registered'});cfg.accounts.push({email,owner:body.owner,dailyLimit:50,brand:email.includes('foundry')?'Foundry':'Staffify',draftEnabled:!email.includes('foundry')});}
  }else if(body.action==='set-send-window'){
   if(body.start!==9||body.end!==21||body.timeZone!=='America/New_York')return res.status(400).json({error:'Supported shared window is 9 AM to 9 PM Eastern'});
   cfg.sendWindow={start:9,end:21,timeZone:'America/New_York',weekdays:[1,2,3,4,5]};
  }else if(body.action==='reconcile'){cfg.enabled=true;cfg.draftingEnabled=false;
  }else if(body.action==='enable'){
   if(process.env.OUTREACH_WORKER_VERIFIED!=='true')return res.status(409).json({error:'Draft creation is paused until hosted validation is complete; cloud reconciliation remains available'});
   if(cfg.accounts.length!==cfg.expectedAccounts)return res.status(409).json({error:'Every outreach account must be registered'});
   const health=await redis.get('outreach:cloud:health');if(!health?.ok||Date.now()-Date.parse(health.checkedAt)>10*60000)return res.status(409).json({error:'Every Staffify mailbox must pass a live health check before enabling drafts'});
   cfg.enabled=true;cfg.draftingEnabled=true;
  }else if(body.action==='enable-sending'){
   if(process.env.OUTREACH_SEND_VERIFIED!=='true'||process.env.OUTREACH_WORKER_VERIFIED!=='true')return res.status(409).json({error:'Automatic sending validation is incomplete'});
   const health=await redis.get('outreach:cloud:health');if(!health?.ok||Date.now()-Date.parse(health.checkedAt)>600000)return res.status(409).json({error:'Run live mailbox checks before enabling sending'});
   cfg.enabled=true;cfg.draftingEnabled=true;cfg.sendingEnabled=true;cfg.sendingAuthorizedAt=new Date().toISOString();
  }else if(body.action==='disable-sending')cfg.sendingEnabled=false;else if(body.action==='disable')cfg.enabled=false;else return res.status(400).json({error:'Unknown action'});
  cfg.updatedAt=new Date().toISOString();await redis.set(CONFIG,cfg);
 }
 const accounts=[];for(const a of cfg.accounts)if(owner==='all'||a.owner===owner)accounts.push({...a,connected:!!await redis.get('outreach:oauth:'+a.email)});
 return res.status(200).json({enabled:cfg.enabled,sendingEnabled:cfg.sendingEnabled===true,sendingValidationComplete:process.env.OUTREACH_SEND_VERIFIED==='true',draftingEnabled:cfg.draftingEnabled!==false,expectedAccounts:cfg.expectedAccounts,registeredAccounts:cfg.accounts.length,sendWindow:cfg.sendWindow||{start:9,end:17,weekdays:[1,2,3,4,5]},alertMonitor:await redis.get('staffify:alerts:last-run'),alertDeliveryTest:await redis.get('staffify:alerts:delivery-test'),leadPreparation:await redis.get('staffify:lead-prep:last-run'),validationComplete:process.env.OUTREACH_WORKER_VERIFIED==='true',workerLockSeconds:await redis.ttl('outreach:cloud:lock'),health:await redis.get('outreach:cloud:health'),oauthConfigured:!!(clientId()&&clientSecret()),redirectUri:callback,accounts,lastRun:await redis.get('outreach:cloud:last-run')});
 }catch(e){return res.status(503).json({error:'Mailbox connection service unavailable'});}}
