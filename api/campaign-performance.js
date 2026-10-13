import {redis,requireAccess,adminAuthorized} from './_auth.js';
import {KEY,ownerFor,visibleState} from './_outreach-queue.js';
import {performance} from './_campaign-performance.js';
import {conversationEmail} from './_playbook-conversation.js';
import {introduction} from './_outreach-copy.js';
import {followup} from './_outreach-policy.js';
import {createHash} from 'node:crypto';
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');
 try{
 const owner=ownerFor(await requireAccess(req));if(!owner)return res.status(401).json({error:'Sign in to the Hub'});
 const state=visibleState(await redis.get(KEY),owner),campaigns=[];
 for(const c of state.campaigns||[])campaigns.push({id:c.id,name:c.name,...performance(state.records.filter(r=>r.campaignId===c.id))});
 const ids=await redis.zrange('subscribers:by_date',0,-1),website=[];
 for(let i=0;i<ids.length;i+=25){const result=await Promise.all(ids.slice(i,i+25).map(async recipient=>{const r=await redis.get('website:conversation:'+recipient);return r?{...r,recipient,sentTouches:r.events?.length||0,events:[...(r.events||[]),...(r.replies||[]).map(e=>({...e,kind:'received'}))]}:null;}));website.push(...result.filter(Boolean));}
 if(owner==='Paul'||owner==='all')campaigns.push({id:'website-playbook',name:'Delegation playbook follow-ups',...performance(website)});
 const at=new Date().toISOString();
 // Scheduled machine snapshots preserve the daily totals and exact template revisions.
 if(req.query?.snapshot==='1'){
  if(!adminAuthorized(req))return res.status(403).json({error:'Worker authorization required'});
  const templates={agency:[introduction('Paul',''),introduction('Madison',''),...[1,2,3].map(sentTouches=>followup({owner:'Paul',sentTouches}))],playbook:[1,2,3].map(n=>conversationEmail('',n)),ceo:state.records.filter(r=>r.campaignId==='staffify-tobit-outreach').map(r=>({id:r.id,followups:r.followupBodies}))};
  const revision=createHash('sha256').update(JSON.stringify(templates)).digest('hex').slice(0,16);
  await redis.set('campaign:copy-version:'+revision,{at,templates},{nx:true});
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date());
  await redis.set('campaign:performance:'+day,{at,campaigns,revision});await redis.zadd('campaign:performance:dates',{score:Date.now(),member:day});await redis.set('campaign:performance:last',{at,revision});
 }
 const saved=await redis.get('campaign:performance:last');
 const dates=owner==='all'?await redis.zrange('campaign:performance:dates',-14,-1):[];
 const history=(await Promise.all(dates.map(d=>redis.get('campaign:performance:'+d)))).filter(Boolean);
 return res.json({at,campaigns,history,snapshot:saved,notes:'Counts use retained message evidence, not drafting targets. Historical totals can be incomplete. Subject/body versions are retained from this release onward. Revenue conversions are not enabled.'});
 }catch{return res.status(503).json({error:'Campaign performance could not be loaded'});}
}
