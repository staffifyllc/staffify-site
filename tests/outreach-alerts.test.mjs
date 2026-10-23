import {test} from 'node:test';import assert from 'node:assert/strict';import {incidents,checkAlerts,alertText} from '../api/_outreach-alerts.js';
const now=Date.parse('2026-10-01T14:00:00Z');const healthy=()=>({cfg:{enabled:true},run:{finishedAt:new Date(now).toISOString(),status:'complete'},health:{accounts:[{email:'test@example.com',ok:true}]},prep:{finishedAt:new Date(now).toISOString(),status:'complete'}});
const at=(t,mut)=>{const s=healthy();s.run.finishedAt=new Date(t).toISOString();s.prep.finishedAt=new Date(t).toISOString();if(s.companyPrep)s.companyPrep.finishedAt=new Date(t).toISOString();if(mut)mut(s);return s;};
function harness(){const map=new Map(),messages=[];return {redis:{get:async k=>map.get(k),set:async(k,v)=>map.set(k,structuredClone(v))},notify:async t=>{messages.push(t);return {ok:true};},messages};}
test('normal runs and intentional pause stay quiet',()=>{assert.deepEqual(incidents(healthy(),now),[]);assert.deepEqual(incidents({cfg:{enabled:false}},now),[]);});
test('stale worker and broken mailbox are independent actionable incidents',()=>{const s=healthy();s.run.finishedAt='2026-10-01T13:00:00Z';s.health.accounts[0].ok=false;assert.deepEqual(incidents(s,now).map(i=>i.id),['worker-overdue','mailbox-access']);});
test('an incident is reported after thirty minutes, reminded daily, and recovered once',async()=>{const h=harness();const bad=s=>{s.run.status='error';};
 for(const t of [now,now+300000,now+600000,now+1500000])await checkAlerts({...h,snapshot:at(t,bad),now:t});assert.equal(h.messages.length,0,'nothing in the first twenty-five minutes');
 await checkAlerts({...h,snapshot:at(now+1800000,bad),now:now+1800000});assert.equal(h.messages.length,1,'reported once it has held for thirty minutes');assert.match(h.messages[0],/needs attention/);
 for(const t of [now+2100000,now+6*3600000,now+12*3600000])await checkAlerts({...h,snapshot:at(t,bad),now:t});assert.equal(h.messages.length,1,'no repeat inside a day');
 const day=now+1800000+24*3600000;await checkAlerts({...h,snapshot:at(day,bad),now:day});assert.equal(h.messages.length,2,'one reminder a day while it stands');
 await checkAlerts({...h,snapshot:at(day+300000),now:day+300000});assert.equal(h.messages.length,3);assert.match(h.messages[2],/recovered/);
 await checkAlerts({...h,snapshot:at(day+600000),now:day+600000});assert.equal(h.messages.length,3,'recovery is said once');});
test('a flapping provider is not twenty posts: a clear and a re-trip inside the quiet period say nothing',async()=>{const h=harness();const bad=s=>{s.prep.status='retrying';};
 let t=now;for(let i=0;i<7;i++){await checkAlerts({...h,snapshot:at(t,bad),now:t});t+=300000;}assert.equal(h.messages.length,1,'reported after thirty minutes');
 // Clears for ten minutes, comes back, holds another hour: the pattern from 2026-10-22.
 await checkAlerts({...h,snapshot:at(t),now:t});t+=300000;assert.equal(h.messages.length,2,'the recovery is news once');
 await checkAlerts({...h,snapshot:at(t),now:t});t+=300000;
 for(let i=0;i<13;i++){await checkAlerts({...h,snapshot:at(t,bad),now:t});t+=300000;}
 assert.equal(h.messages.length,2,'the re-trip inside the day is not reported again');
 await checkAlerts({...h,snapshot:at(t),now:t});assert.equal(h.messages.length,2,'and a recovery nobody was told about is not posted either');
 // A short blip never settles, so it is never mentioned at all.
 const h2=harness();for(const tt of [now,now+300000,now+600000])await checkAlerts({...h2,snapshot:at(tt,bad),now:tt});await checkAlerts({...h2,snapshot:at(now+900000),now:now+900000});assert.equal(h2.messages.length,0);});
test('failed delivery retries and never pretends it was sent',async()=>{const h=harness(),s=healthy();s.run.status='error';let n=0;const notify=async()=>({ok:++n>1,error:'test'});await checkAlerts({...h,notify,snapshot:s,now:now-1800000});await checkAlerts({...h,notify,snapshot:s,now});await checkAlerts({...h,notify,snapshot:s,now:now+1});await checkAlerts({...h,notify,snapshot:s,now:now+2});assert.equal(n,2);});
test('deliberate pause does not send a recovery',async()=>{const h=harness();const bad=s=>{s.run.status='error';};
 await checkAlerts({...h,snapshot:at(now,bad),now});await checkAlerts({...h,snapshot:at(now+1800000,bad),now:now+1800000});assert.equal(h.messages.length,1);
 await checkAlerts({...h,snapshot:{cfg:{enabled:false}},now:now+2100000});assert.equal(h.messages.length,1,'pausing is not recovering');});
test('untrusted values cannot create Slack mentions',()=>{assert.doesNotMatch(alertText({title:'<!channel>',impact:'a',action:'b'}),/<!channel>/);});
