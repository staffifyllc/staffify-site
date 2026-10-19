import {withCallPhones} from './_outreach-call-phones.js';
import {hubspotRequest} from './_outreach-hubspot.js';
import { redis, requireAccess, adminAuthorized, SITE, readBody } from './_auth.js';
import {config,access,gmail,compactMessage} from './_outreach-gmail.js';
import {KEY,ownerFor,visibleState,mergeSnapshot,controlState,canUseCallQueue,sharedCallState} from './_outreach-queue.js';
const CAS = `local raw=redis.call('GET',KEYS[1]); local rev=0; if raw then rev=cjson.decode(raw).revision or 0 end; if rev~=tonumber(ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1`;
export default async function handler(req,res) {
  res.setHeader('Cache-Control','private, no-store');
  try {
    const rep=await requireAccess(req);const calls=req.query?.view==='calls';const owner=calls&&canUseCallQueue(rep)?'all':ownerFor(rep);
    const view=s=>calls?sharedCallState(s):visibleState(s,owner);
    if(!owner)return res.status(401).json({error:'Sign in with your Staffify account'});
    const state=await redis.get(KEY);
    if(req.method==='GET'){
      const crm=async(path,body)=>{const response=await hubspotRequest('https://api.hubapi.com'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+process.env.HUBSPOT_TOKEN,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined},{redis});if(!response.ok)throw Error('CRM unavailable');return response.json();};
      return res.status(200).json(await withCallPhones(view(state),{redis,crm}));
    }
    if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
    const machine=adminAuthorized(req);
    if(!machine&&req.headers.origin!==SITE)return res.status(403).json({error:'Invalid origin'});
    const body=readBody(req);
    if(calls&&!['call-outcome','suppress'].includes(body.action))return res.status(403).json({error:'Caller access is limited to call outcomes and exclusions'});
    if(calls&&!sharedCallState(state).records.some(r=>body.action==='suppress'?r.recipient===String(body.email||'').toLowerCase():r.id===body.id))return res.status(409).json({error:'This prospect is no longer in the call queue'});
    if(body.expectedRevision!==(state?.revision||0))return res.status(409).json({error:'Queue changed; reload before retrying'});
    let next;
    if(body.action==='refresh-history') {
      if(!machine)return res.status(403).json({error:'Worker authorization required'});
      const row=state.records.find(r=>r.id===body.id);
      const cfg=await config();
      if(!row?.threadId||!cfg.accounts.some(a=>a.email===row.sender&&a.brand==='Staffify'&&a.draftEnabled))return res.status(400).json({error:'Connected Staffify conversation required'});
      const thread=await gmail(await access(row.sender),'threads/'+encodeURIComponent(row.threadId)+'?format=full');
      const messages=new Map((thread.messages||[]).map(m=>[m.id,m]));
      const evidence=m=>{const types=[];const walk=p=>{if(!p||p.filename)return;if(p.body?.data)types.push(p.mimeType);for(const c of p.parts||[])walk(c);};walk(m.payload);return {rootType:m.payload?.mimeType,bodyTypes:types,readerVersion:2};};
      next={...state,revision:state.revision+1,queueUpdatedAt:new Date().toISOString(),records:state.records.map(r=>r.id!==row.id?r:{...r,events:(r.events||[]).map(e=>{const m=messages.get(e.id);return m?{...e,body:compactMessage(m,row.sender).text,bodyMimeEvidence:evidence(m)}:e;})})};
    } else if(body.action==='sync') {
      if(!machine)return res.status(403).json({error:'Worker authorization required'});
      if((await config()).enabled)return res.status(409).json({error:'Hosted worker owns the queue; local snapshot writes are disabled'});
      next=mergeSnapshot(state,body);
    } else next=controlState(state,body,owner,rep.email);
    const saved=await redis.eval(CAS,[KEY],[String(state?.revision||0),JSON.stringify(next)]);
    if(Number(saved)!==1)return res.status(409).json({error:'Queue changed; reload before retrying'});
    return res.status(200).json(view(next));
  } catch(e) {return res.status(503).json({error:'Queue unavailable; no action completed'});}
}
