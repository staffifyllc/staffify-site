import {redis,requireAccess,currentRep,newToken,SITE,readBody,adminAuthorized} from './_auth.js';
import {ownerFor} from './_outreach-queue.js';
import {CONFIG,SCOPES,config,clientId,clientSecret,seal,gmail} from './_outreach-gmail.js';
const callback=SITE+'/api/outreach-connect/?action=callback';
export default async function handler(req,res){res.setHeader('Cache-Control','private, no-store');try{
 const who=await requireAccess(req),owner=ownerFor(who);if(!owner)return res.status(401).json({error:'Sign in to the Sales Hub'});
 const cfg=await config();const action=req.query?.action||'status';
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
  }else if(body.action==='enable'){
   if(process.env.OUTREACH_WORKER_VERIFIED!=='true')return res.status(409).json({error:'Hosted worker validation is not complete; existing local automation remains active'});
   if(cfg.accounts.length!==cfg.expectedAccounts)return res.status(409).json({error:'Every outreach account must be registered'});
   for(const a of cfg.accounts)if(!await redis.get('outreach:oauth:'+a.email))return res.status(409).json({error:'Connect every mailbox before enabling'});
   cfg.enabled=true;
  }else if(body.action==='disable')cfg.enabled=false;else return res.status(400).json({error:'Unknown action'});
  cfg.updatedAt=new Date().toISOString();await redis.set(CONFIG,cfg);
 }
 const accounts=[];for(const a of cfg.accounts)if(owner==='all'||a.owner===owner)accounts.push({...a,connected:!!await redis.get('outreach:oauth:'+a.email)});
 return res.status(200).json({enabled:cfg.enabled,expectedAccounts:cfg.expectedAccounts,registeredAccounts:cfg.accounts.length,oauthConfigured:!!(clientId()&&clientSecret()),redirectUri:callback,accounts,lastRun:await redis.get('outreach:cloud:last-run')});
 }catch(e){return res.status(503).json({error:'Mailbox connection service unavailable'});}}
