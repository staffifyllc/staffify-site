import {redis,currentRep,SITE} from './_auth.js';
import {financeAccess,financeMachine} from './_finance-access.js';
import commissions from './commissions.js';
import residuals from './residuals.js';
import {ensureMadisonPlan} from './_madison-commission-plan.js';
import {reconcileInvoices} from './_invoice-monitor.js';
import {qboQuery} from './_qbo.js';
import {monthlyRevenue} from './_finance-revenue.js';
const KEY='finance:snapshot:v1',LOCK='finance:snapshot:lock';
async function capture(handler){let code=200,value;await handler({method:'GET',headers:{authorization:'Bearer '+process.env.CRON_SECRET},query:{view:'admin'}},{setHeader(){},status(n){code=n;return this;},json(v){value=v;return v;}});if(code!==200||!value||value.error||value.qboError||!value.connected||value.truncated?.hubspot||value.truncated?.qbo)throw Error(value?.error||'Source unavailable');return value;}
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');
 const machine=financeMachine(req),who=await currentRep(req).catch(()=>null);
 if(!machine&&!financeAccess(who))return res.status(who?403:401).json({error:'Revenue and commissions are private to Paul and Madison'});
 if(req.method==='GET'&&!machine){const saved=await redis.get(KEY);return res.status(200).json(saved?{...saved,stale:Date.now()-Date.parse(saved.updatedAt)>15*60000}:{pending:true,message:'First cloud sync is pending'});}
 if(!machine&&(req.method!=='POST'||req.headers.origin!==SITE))return res.status(403).json({error:'Invalid request'});
 const nonce=String(Date.now());if(!await redis.set(LOCK,nonce,{nx:true,ex:290}))return res.status(200).json({running:true});
 const old=await redis.get(KEY);try{
  await ensureMadisonPlan(redis);
  // Sequential: the shared Hubstaff refresh token must not be rotated concurrently.
  const invoiceMonitor=await reconcileInvoices({redis,query:qboQuery,hs:async(path,body,method)=>{const response=await fetch('https://api.hubapi.com'+path,{method:method||(body?'POST':'GET'),headers:{Authorization:'Bearer '+process.env.HUBSPOT_TOKEN,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Invoice CRM sync failed: '+response.status);return response.json();}});
  const commission=await capture(commissions),residual=await capture(residuals);
  const revenue=await monthlyRevenue().catch(()=>({connected:false,error:'QuickBooks monthly revenue report unavailable'}));
  const snapshot={invoiceMonitor,revenue,updatedAt:new Date().toISOString(),status:'complete',commission,residual,intervalMinutes:5};await redis.set(KEY,snapshot);return res.status(200).json({ok:true,updatedAt:snapshot.updatedAt});
 }catch(e){await redis.set(KEY,{...old,status:'error',lastAttemptAt:new Date().toISOString(),error:'A financial source could not be refreshed. Previous figures are retained.'});return res.status(503).json({error:'Finance sync incomplete; previous figures retained'});}
 finally{await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",[LOCK],[nonce]);}
}
