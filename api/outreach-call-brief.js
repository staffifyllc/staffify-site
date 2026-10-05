import {checkBusinessPhone} from './_outreach-phone-evidence.js';
import {site} from './_outreach-supply.js';
import {redis,requireAccess} from './_auth.js';
import {KEY,ownerFor,visibleState} from './_outreach-queue.js';
import {contact,draftBlockReason} from './_outreach-crm.js';
import {config,access,history,compactMessage} from './_outreach-gmail.js';
import {classify,callReady} from './_outreach-policy.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
 try{
  const owner=ownerFor(await requireAccess(req));if(!owner)return res.status(401).json({error:'Sign in to the Hub'});
  const state=await redis.get(KEY),row=visibleState(state,owner).records.find(r=>r.id===req.query.id);
  if(!row)return res.status(404).json({error:'Record not available'});
  if(!row.callReady)return res.status(409).json({error:'This prospect is not due for an unanswered-email call'});
  const block=await draftBlockReason(row);if(block)return res.status(409).json({error:'Do not call: '+block});
  const accounts=(await config()).accounts.filter(a=>a.brand==='Staffify'&&a.draftEnabled);
  if(!accounts.some(a=>a.email===row.sender))throw Error('Sending mailbox is not active');
  const all=(await Promise.all(accounts.map(async a=>(await history(await access(a.email),row.recipient)).map(m=>compactMessage(m,a.email))))).flat();
  const verdict=classify(all,row.recipient,accounts.map(a=>a.email));
  if(verdict.status)return res.status(409).json({error:'Do not call from this queue: '+verdict.status+'. A human must review the conversation.'});
  const sent=all.filter(m=>m.mailbox===row.sender&&m.sent&&m.to.includes(row.recipient));
  if(!callReady({...row,verifiedSentTouches:sent.length,lastSentAt:sent.length?new Date(Math.max(...sent.map(m=>m.date))).toISOString():null}))throw Error('Four sent emails and the reply window could not be verified');
  const latest=await redis.get(KEY);if(!visibleState(latest,owner).records.find(r=>r.id===row.id)?.callReady)throw Error('Queue changed; refresh before calling');
  const p=(await contact(row.recipient)).properties;
  const phoneEvidence=await checkBusinessPhone({phone:p.phone||p.mobilephone,website:p.website,fetchSite:site});
  await redis.set('staffify:call-phone-evidence:'+row.recipient,phoneEvidence,{ex:86400});
  return res.status(200).json({checkedAt:new Date().toISOString(),owner:row.owner,name:[p.firstname,p.lastname].filter(Boolean).join(' ')||row.recipient,phone:phoneEvidence.status==='business_listed'?phoneEvidence.phone:null,phoneEvidence,location:[p.city,p.state,p.country].filter(Boolean).join(', ')||null,company:p.company||row.company,crmUrl:'https://app.hubspot.com/contacts/51666712/record/0-1/'+(row.hubspotId||(await contact(row.recipient)).id),fact:row.source?.excerpt||null,source:row.source||null,opener:'Hi '+(p.firstname||'there')+', this is '+row.owner+' with Staffify. I sent you a few notes about handing off recurring work at '+(p.company||row.company||'your agency')+'. Have I caught you with a minute? I wanted to learn which task is taking the most time from your team right now.',questions:['What recurring task would you most like off your plate?','Who handles it today, and roughly how much time does it take each week?','Would a short discovery call to map out that role be useful?'],events:all.filter(m=>!m.draft).sort((a,b)=>a.date-b.date).map(m=>({kind:m.sent?'sent':'received',at:new Date(m.date).toISOString(),subject:m.subject,body:m.text,mailbox:m.mailbox})),instruction:'Read the actual emails below before calling. Ask about their situation; do not assume interest. Record the result and a dated next step. Any request to stop must use Exclude from outreach.'});
 }catch(e){return res.status(503).json({error:'Call check unavailable. Do not call yet. '+e.message});}
}
