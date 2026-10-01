import { redis, requireAccess, adminAuthorized, SITE, readBody } from './_auth.js';
import {config,access,gmail,compactMessage} from './_outreach-gmail.js';
import {KEY,ownerFor,visibleState,mergeSnapshot,controlState} from './_outreach-queue.js';
const CAS = `local raw=redis.call('GET',KEYS[1]); local rev=0; if raw then rev=cjson.decode(raw).revision or 0 end; if rev~=tonumber(ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1`;
export default async function handler(req,res) {
  res.setHeader('Cache-Control','private, no-store');
  try {
    const rep=await requireAccess(req);const owner=ownerFor(rep);
    if(!owner)return res.status(401).json({error:'Sign in with your Staffify account'});
    const state=await redis.get(KEY);
    if(req.method==='GET')return res.status(200).json(visibleState(state,owner));
    if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
    const machine=adminAuthorized(req);
    if(!machine&&req.headers.origin!==SITE)return res.status(403).json({error:'Invalid origin'});
    const body=readBody(req);
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
    } else next=controlState(state,body,owner);
    const saved=await redis.eval(CAS,[KEY],[String(state?.revision||0),JSON.stringify(next)]);
    if(Number(saved)!==1)return res.status(409).json({error:'Queue changed; reload before retrying'});
    return res.status(200).json(visibleState(next,owner));
  } catch(e) {return res.status(503).json({error:'Queue unavailable; no action completed'});}
}
