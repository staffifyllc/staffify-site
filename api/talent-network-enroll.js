import {createHash,randomUUID} from 'node:crypto';
import {redis,adminAuthorized,readBody} from './_auth.js';
import {config,CONFIG,access,gmail,compactMessage,history} from './_outreach-gmail.js';
import {KEY} from './_outreach-queue.js';
import {canDraft} from './_outreach-crm.js';
import {classify,reconcileThread} from './_outreach-policy.js';
import {TALENT_ID,balancedSender} from './_talent-network-campaign.js';
const CAS="local s=redis.call('GET',KEYS[1]); if not s or cjson.decode(s).revision~=tonumber(ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');if(!adminAuthorized(req))return res.status(401).json({error:'Unauthorized'});
 if(req.method!=='POST')return res.status(405).json({error:'POST required'});
 const nonce=randomUUID();if(!await redis.set('outreach:cloud:lock',nonce,{nx:true,ex:360}))return res.status(409).json({error:'Worker running; retry'});
 try{
 const b=readBody(req),cfg=await config();if(cfg.sendingEnabled)return res.status(409).json({error:'Pause sending before enrollment'});
 const state=await redis.get(KEY);if(!state)throw Error('Missing queue');
 if(b.action==='scope'){cfg.allowedCampaignIds=[TALENT_ID];await redis.set(CONFIG,cfg);return res.status(200).json({allowedCampaignIds:cfg.allowedCampaignIds,sendingEnabled:false});}
 const input=b.record;if(!input||!input.company||!['2','3','4'].every(k=>typeof input.followupBodies?.[k]==='string'&&input.followupBodies[k].length>80))return res.status(400).json({error:'Company and three follow-ups required'});
 const recipient=String(input.recipient||'').toLowerCase().trim();
 const id='talent-network-'+createHash('sha256').update(input.company.toLowerCase().trim()).digest('hex').slice(0,20);
 const prior=state.records.find(r=>r.id===id);if(prior&&!(b.action==='promote'&&prior.status==='contact_research_hold'&&!prior.sentTouches&&!prior.draftId))return res.status(200).json({id,status:prior.status,alreadyEnrolled:true});
 if(recipient&&state.records.some(r=>r.id!==id&&r.recipient===recipient))return res.status(409).json({error:'Recipient already tracked'});
 let row={id,campaignId:TALENT_ID,owner:'Paul',sender:'paul@trystaffify.com',recipient,company:String(input.company),subject:String(input.subject||''),bodyText:String(input.bodyText||''),followupBodies:input.followupBodies,roleContext:String(input.roleContext||''),source:input.source||null,status:'contact_research_hold',sentTouches:0,verifiedSentTouches:0,qualificationApproved:false,createdAt:new Date().toISOString()};
 if(recipient){
 if(!input.messageId&&b.action!=='promote')return res.status(400).json({error:'Existing sent message required'});
 if(b.action==='promote'){if(!prior||!recipient.includes('@'))return res.status(400).json({error:'Held company and verified address required'});row.sender=balancedSender(cfg.accounts,state.records);row.verifiedFirstName=String(input.verifiedFirstName||'');}
 if(state.suppressions.includes(recipient))return res.status(409).json({error:'Suppressed'});
 const senders=cfg.accounts.filter(a=>a.brand==='Staffify'&&a.draftEnabled).map(a=>a.email);
 let messages=[];for(const sender of senders){const token=await access(sender);messages.push(...(await history(token,recipient)).map(m=>compactMessage(m,sender)));}
 const verdict=classify(messages,recipient,senders);if(verdict.status)return res.status(409).json({error:verdict.status});
 if(b.action==='promote'?(messages.length>0):(verdict.sent.length!==1||verdict.sent[0].id!==input.messageId||verdict.sent[0].mailbox!==row.sender||messages.some(m=>m.draft)))return res.status(409).json({error:'Sent history mismatch'});
 if(!await canDraft(row))return res.status(409).json({error:'CRM/client/verification hold'});
 row.qualificationApproved=true;if(b.action==='promote'){row.status='prepared';row.enrichedAt=new Date().toISOString();}else{row.status='sent';row.threadId=verdict.sent[0].threadId;reconcileThread(row,messages);}
 }
 if(prior)state.records=state.records.map(r=>r.id===id?row:r);else state.records.push(row);const rev=state.revision;state.revision++;state.queueUpdatedAt=new Date().toISOString();
 if(Number(await redis.eval(CAS,[KEY],[String(rev),JSON.stringify(state)]))!==1)throw Error('Queue changed; retry');
 return res.status(200).json({id,sender:row.sender,status:row.status,sentTouches:row.sentTouches,nextEligibleAt:row.nextEligibleAt});
 }catch(e){return res.status(503).json({error:String(e.message).slice(0,160)});}finally{await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",['outreach:cloud:lock'],[nonce]);}
}
