import {randomUUID} from 'node:crypto';
import {redis,adminAuthorized,readBody} from './_auth.js';
import {access,gmail,compactMessage} from './_outreach-gmail.js';
import {SENDER,isWebsiteSource} from './_playbook-conversation.js';
import {classify} from './_outreach-policy.js';
import {optOut} from './_optout.js';
import {reconcileManual} from './_playbook-manual.js';
const INDEX='website:manual-drafts',LOCK='website:conversation:lock';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');if(!adminAuthorized(req))return res.status(401).json({error:'Unauthorized'});
 const nonce=randomUUID();if(!await redis.set(LOCK,nonce,{nx:true,ex:300}))return res.json({status:'already_running'});
 try{
  let tracked=await redis.get(INDEX)||[];
  if(req.method==='POST'){
   const body=readBody(req);if(!Array.isArray(body.drafts)||body.drafts.length>50)throw Error('At most 50 registered drafts required');
   for(const d of body.drafts){
    const email=String(d.email||'').toLowerCase(),threadId=String(d.threadId||'');if(!/^[a-f0-9]+$/.test(threadId))throw Error('Invalid Gmail thread');
    const sub=await redis.hgetall('subscriber:'+email);if(!sub?.playbook_sent_at||!isWebsiteSource(sub.source))throw Error('Existing playbook subscriber required');
    if(!tracked.some(t=>t.email===email&&t.threadId===threadId))tracked.push({email,threadId,sender:SENDER});
   }
   await redis.set(INDEX,tracked);
  }
  const token=await access(SENDER),report={checked:0,confirmedContacts:0,newSends:0,errors:[],at:new Date().toISOString()};
  for(const t of tracked){
   try{
    const raw=await gmail(token,'threads/'+encodeURIComponent(t.threadId)+'?format=full');
    const messages=(raw.messages||[]).map(m=>compactMessage(m,SENDER));
    const key='website:conversation:'+t.email,previous=await redis.get(key)||{events:[],status:'manual_followup'};
    const next=reconcileManual(previous,messages,t);report.checked++;if(!next)continue;
    report.newSends+=next.events.length-(previous.events||[]).length;report.confirmedContacts++;
    const verdict=classify(messages,t.email,[SENDER]);
    if(verdict.status==='human_reply_hold')next.humanReplyConfirmedAt=next.humanReplyConfirmedAt||new Date().toISOString();
    if(verdict.status){next.status=verdict.status;next.reason='Confirmed in registered personal playbook thread';if(verdict.status==='suppressed')await optOut({email:t.email,reason:'Playbook opt-out reply',source:'playbook-reconciliation'});}
    else if(!['human_reply_hold','suppressed','client_hold'].includes(next.status)){next.status='manual_followup';next.reason='Personal outreach sent; follow-up handled by Paul';}
    await redis.set(key,next);
   }catch(e){report.errors.push({email:t.email,reason:String(e.message).slice(0,160)});}
  }
  await redis.set('website:manual-reconciliation:health',report);return res.json(report);
 }catch(e){return res.status(503).json({error:e.message});}
 finally{await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",[LOCK],[nonce]);}
}
