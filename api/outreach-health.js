import {randomUUID} from 'node:crypto';
import {redis} from './_auth.js';
import {config} from './_outreach-gmail.js';
import {slackNotify} from './_slack.js';
import {checkAlerts} from './_outreach-alerts.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');if(!process.env.CRON_SECRET||req.headers.authorization!=='Bearer '+process.env.CRON_SECRET)return res.status(401).json({error:'Unauthorized'});
 const lock='staffify:alerts:lock',nonce=randomUUID();if(!await redis.set(lock,nonce,{nx:true,ex:240}))return res.status(200).json({status:'already_running'});
 try{
 if(req.method==='POST'&&req.query?.action==='test'){
 const result=await slackNotify(':white_check_mark: *Staffify alert delivery test*\nThis is a connection test, not a claim that outreach is fully operational.\nCloud checks will report failures and recovery here.\n<https://www.gostaffify.com/outreach-review/|Open Sales Hub>');
 await redis.set('staffify:alerts:delivery-test',{...result,checkedAt:new Date().toISOString()});return res.status(result.ok?200:503).json(result);}
 const [cfg,run,health,prep]=await Promise.all([config(),redis.get('outreach:cloud:last-run'),redis.get('outreach:cloud:health'),redis.get('staffify:lead-prep:last-run')]);
 return res.status(200).json(await checkAlerts({redis,notify:slackNotify,snapshot:{cfg,run,health,prep}}));
 }catch{return res.status(503).json({error:'Health monitor unavailable'});}
 finally{await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",[lock],[nonce]);}
}
