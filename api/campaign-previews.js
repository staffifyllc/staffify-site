import {redis,requireAccess} from './_auth.js';
import {KEY,ownerFor,visibleState} from './_outreach-queue.js';
import {introduction} from './_outreach-copy.js';
import {followup} from './_outreach-policy.js';
import {conversationEmail} from './_playbook-conversation.js';
import {LANES,SEQUENCES} from './_enterprise.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Read-only endpoint'});
 try{
  const owner=ownerFor(await requireAccess(req));if(!owner)return res.status(401).json({error:'Sign in to the Staffify Sales Hub'});
  const state=visibleState(await redis.get(KEY),owner),rows=state.records||[];
  const agencyOwners=owner==='all'?['Paul','Madison']:[owner];
  const campaigns=[{id:'staffify-agency-outreach',name:'Agency outreach',kind:'Current templates',note:'These are the current templates for new prospects. Already prepared or sent messages can differ; see each recipient in Outreach review.',variants:agencyOwners.map(owner=>({label:owner+' template',steps:[{title:'Email 1 · Introduction',subject:'The work between shoots',body:introduction(owner,'[first name]')},...[1,2,3].map(sentTouches=>({title:'Email '+(sentTouches+1)+' · At least 48 hours after previous send',subject:'Same email thread',body:followup({owner,verifiedFirstName:'[first name]',sentTouches})}))]}))}];
  const tobit=rows.filter(r=>r.campaignId==='staffify-tobit-outreach');
  campaigns.push({id:'staffify-tobit-outreach',name:'CEO b2b outreach',kind:'Saved recipient copy',note:'Choose a recipient to inspect their saved messages. Preview is not proof of sending; actual send history stays in Outreach review.',variants:tobit.map(r=>{const first=(r.events||[]).filter(e=>e.kind==='sent').sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))[0];return {label:r.recipient,steps:[{title:'Email 1 · '+(first?'Recorded sent copy':'Saved copy'),subject:first?.subject||r.subject,body:first?.body||r.bodyText||'Original message body is not available in this record.'},...[2,3,4].map(n=>({title:'Email '+n+' · At least 48 hours after previous send',subject:'Same email thread',body:r.followupBodies?.[n]||'No saved follow-up copy. Sending must remain held.'}))]};})});
  campaigns.push({id:'website-playbook',name:'Delegation playbook follow-ups',kind:'Current templates',note:'Three personal check-ins. First eligible 48 hours after enrollment; later check-ins at least 48 hours after the previous send. Replies, clients and opt-outs stop automation.',variants:[{label:'Paul template',steps:[1,2,3].map(n=>{const c=conversationEmail('',n);return {title:'Personal check-in '+n,subject:c.subject,body:c.body};})}]});
  for(const lane of LANES)campaigns.push({id:lane.id,name:lane.name,kind:'Planning only · Not automatically sending',note:'Account-specific entry messages and LinkedIn tasks are in the enterprise workspace. These are the planning framework, not approved recipient messages.',variants:[{label:'Sequence framework',steps:SEQUENCES[lane.sequenceId].map((s,i)=>({title:'Email '+(i+1)+' · '+s.purpose,subject:'Account-specific subject required',body:s.copy}))}]});
  return res.json({checkedAt:new Date().toISOString(),campaigns});
 }catch{return res.status(503).json({error:'Campaign previews unavailable'});}
}
