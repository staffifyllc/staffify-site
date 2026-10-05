import {engagementPlan} from './_enterprise-engagement.js';
import {redis} from './_auth.js';
import {ENTERPRISE_KEY,initialState,review} from './_enterprise.js';
// Own datastore only. This job cannot enroll, draft, send or modify agency outreach.
const CAS="local raw=redis.call('GET',KEYS[1]);local rev=0;if raw then rev=cjson.decode(raw).revision or 0 end;if rev~=tonumber(ARGV[1]) then return 0 end;redis.call('SET',KEYS[1],ARGV[2]);return 1";
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(!process.env.CRON_SECRET||req.headers.authorization!=='Bearer '+process.env.CRON_SECRET)return res.status(401).json({error:'Unauthorized'});
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
 try{
  const state=await redis.get(ENTERPRISE_KEY)||initialState(),at=new Date().toISOString(),rows=review(state,at);
  const report={at,mode:'research_and_planning',accounts:rows.length,engagementTasksDue:state.accounts.flatMap(a=>engagementPlan(a,Date.parse(at)).steps).filter(s=>s.current&&['due','email_not_connected','needs_connection'].includes(s.state)).length,due:rows.filter(r=>r.due&&r.status!=='paused').length,stale:rows.filter(r=>r.evidenceStale).length,sendingEnabled:false,sourceRefresh:'Not performed; this job evaluates stored evidence age and next steps.'};
  const next={...state,revision:state.revision+1,lastReview:report};
  if(Number(await redis.eval(CAS,[ENTERPRISE_KEY],[String(state.revision),JSON.stringify(next)]))!==1)return res.status(409).json({error:'Workspace changed; next scheduled review will retry.'});
  return res.status(200).json(report);
 }catch{return res.status(503).json({error:'Enterprise planning review failed'});}
}
