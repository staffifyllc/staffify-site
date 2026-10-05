import {redis,requireAccess,adminAuthorized,SITE,readBody} from './_auth.js';
import {ownerFor} from './_outreach-queue.js';
import {ENTERPRISE_KEY,initialState,view,update} from './_enterprise.js';
const CAS="local raw=redis.call('GET',KEYS[1]);local rev=0;if raw then rev=cjson.decode(raw).revision or 0 end;if rev~=tonumber(ARGV[1]) then return 0 end;redis.call('SET',KEYS[1],ARGV[2]);return 1";
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');
 try{
  const rep=await requireAccess(req);if(!ownerFor(rep))return res.status(401).json({error:'Sign in to the Staffify Hub with Paul or Madison’s account.'});
  const state=await redis.get(ENTERPRISE_KEY)||initialState();
  if(req.method==='GET')return res.status(200).json(view(state));
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  if(!adminAuthorized(req)&&req.headers.origin!==SITE)return res.status(403).json({error:'Invalid origin'});
  const body=readBody(req);if(body.expectedRevision!==state.revision)return res.status(409).json({error:'Account workspace changed. Refresh before saving.'});
  let next;try{next=update(state,body,rep.email);}catch(e){return res.status(400).json({error:e.message});}
  if(Number(await redis.eval(CAS,[ENTERPRISE_KEY],[String(state.revision),JSON.stringify(next)]))!==1)return res.status(409).json({error:'Account workspace changed. Refresh before saving.'});
  return res.status(200).json(view(next));
 }catch{return res.status(503).json({error:'Enterprise workspace unavailable; no action confirmed.'});}
}
