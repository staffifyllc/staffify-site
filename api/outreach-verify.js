import {redis} from './_auth.js';
import {KEY} from './_outreach-queue.js';
import {draftBlockReason} from './_outreach-crm.js';
import {verifyEmail} from './_outreach-verification.js';
const CAS="local s=redis.call('GET',KEYS[1]); if not s or cjson.decode(s).revision~=tonumber(ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(!process.env.CRON_SECRET||req.headers.authorization!=='Bearer '+process.env.CRON_SECRET)return res.status(401).json({error:'Unauthorized'});
 if(req.method!=='POST')return res.status(405).json({error:'Use POST for bounded pending-queue verification'});
 try{
 const state=await redis.get(KEY);if(!state)return res.status(503).json({error:'Queue unavailable'});
 const offset=Math.max(0,Number(req.body?.after)||0),rows=state.records.filter(r=>r.status==='draft_saved'&&!state.suppressions.includes(r.recipient)&&!state.pausedOwners.includes(r.owner));
 const results=[];
 for(const row of rows.slice(offset,offset+5)){
  const blocked=await draftBlockReason(row);if(blocked){results.push({id:row.id,email:row.recipient,status:'skipped',reason:blocked});continue;}
  const result=await verifyEmail(row.recipient,{redis});results.push({id:row.id,...result});
  // Publish only verification evidence. Never enroll, resume, send or change ownership here.
  for(let retry=0;retry<3;retry++){const live=await redis.get(KEY),r=live.records.find(r=>r.id===row.id&&r.recipient===row.recipient);if(!r)break;const revision=live.revision;r.emailVerification=result;live.revision++;if(Number(await redis.eval(CAS,[KEY],[String(revision),JSON.stringify(live)]))===1)break;}
  if(result.status==='unavailable')break;
 }
 return res.status(200).json({results,total:rows.length,next:offset+results.length<rows.length?offset+results.length:null});
 }catch{return res.status(503).json({error:'Verification audit could not finish; no messages sent'});}
}
