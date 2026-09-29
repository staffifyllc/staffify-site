import {redis,requireAccess} from './_auth.js';
import {ownerFor,KEY} from './_outreach-queue.js';
import {financeMachine} from './_finance-access.js';
import {config,access} from './_outreach-gmail.js';
import {DEAL_QUEUE,supplyDealFollowups} from './_deal-followups.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');const who=await requireAccess(req),owner=ownerFor(who);if(!owner)return res.status(401).json({error:'Sign in'});
 if(req.method==='POST'){
  if(!financeMachine(req))return res.status(403).json({error:'Worker authorization required'});
  const nonce=String(Date.now());if(!await redis.set('outreach:cloud:lock',nonce,{nx:true,ex:240}))return res.status(409).json({error:'Worker is already running'});
  try{const cfg=await config();if(!cfg.enabled||cfg.draftingEnabled===false)return res.status(409).json({error:'Outreach is paused'});cfg.accounts=cfg.accounts.filter(a=>a.brand==='Staffify'&&a.draftEnabled);if(!cfg.accounts.length)throw Error('No active Staffify mailboxes');const tokens={};await Promise.all(cfg.accounts.map(async a=>{tokens[a.email]=await access(a.email);}));const state=await redis.get(KEY);if(!state)throw Error('Missing queue');const result=await supplyDealFollowups(state,cfg,tokens);const before=state.revision;state.revision++;state.queueUpdatedAt=new Date().toISOString();const saved=await redis.eval("local s=redis.call('GET',KEYS[1]);if not s or cjson.decode(s).revision~=tonumber(ARGV[1]) then return 0 end;redis.call('SET',KEYS[1],ARGV[2]);return 1",[KEY],[String(before),JSON.stringify(state)]);if(Number(saved)!==1)throw Error('Controls changed; assessment must retry');return res.status(200).json(result);
  }catch(e){return res.status(503).json({error:String(e.message).slice(0,150)});}finally{await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",['outreach:cloud:lock'],[nonce]);}
 }
 if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
 const queue=await redis.get(DEAL_QUEUE);return res.status(200).json({updatedAt:queue?.updatedAt||null,rows:(queue?.rows||[]).filter(r=>owner==='all'||r.owner===owner).map(r=>({id:r.id,name:r.properties.dealname,stage:r.stage,owner:r.owner||'Unassigned',status:r.status||'Awaiting check',reason:r.reason,recordId:r.recordId,checkedAt:r.checkedAt}))});
}
