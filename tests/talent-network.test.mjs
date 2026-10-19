import test from 'node:test';import assert from 'node:assert/strict';
import {TALENT_ID,campaignAllowed} from '../api/_talent-network-campaign.js';
import {eligible,followup,callReady,reconcileThread} from '../api/_outreach-policy.js';
const now=Date.now(),row={campaignId:TALENT_ID,owner:'Paul',recipient:'buyer@example.com',sender:'paul@trystaffify.com',status:'sent',sentTouches:1,lastSentAt:new Date(now-48*3600000).toISOString(),followupBodies:{2:'second',3:'third',4:'fourth'}};
test('isolated campaign scope blocks old campaign and permits new',()=>{const cfg={allowedCampaignIds:[TALENT_ID]};assert.equal(campaignAllowed(row,cfg),true);assert.equal(campaignAllowed({...row,campaignId:'staffify-agency-outreach'},cfg),false);assert.equal(campaignAllowed({...row,campaignId:'staffify-tobit-outreach'},cfg),false);});
test('timing and four-email cap',()=>{const s={pausedOwners:[],suppressions:[]};assert.equal(eligible(row,s,now),true);assert.equal(eligible({...row,lastSentAt:new Date(now).toISOString()},s,now),false);assert.equal(eligible({...row,sentTouches:4},s,now),false);assert.equal(followup(row),'second');assert.equal(followup({...row,sentTouches:3}),'fourth');});
test('caller requires four verified sends and response window',()=>{assert.equal(callReady(row,now),false);const done={...row,sentTouches:4,verifiedSentTouches:4};assert.equal(callReady(done,now),true);assert.equal(callReady({...done,status:'human_reply_hold'},now),false);assert.equal(callReady({...done,lastSentAt:new Date(now).toISOString()},now),false);});
test('human reply removes completed sequence from dialer',()=>{const r={...row,sentTouches:4,verifiedSentTouches:4};reconcileThread(r,[{id:'reply',sent:false,from:row.recipient,to:[row.sender],text:'Let us talk',date:now}],now);assert.equal(r.status,'human_reply_hold');assert.equal(callReady(r,now),false);});

test('balances new intros over Paul outreach inboxes and retains existing threads',async()=>{
 const {balancedSender,TALENT_ID}=await import('../api/_talent-network-campaign.js');
 const accounts=['paul@trystaffify.com','paul@staffifyhq.com','paul@hirestaffify.com','hello@gostaffify.com','madison@trystaffify.com'].map(email=>({email,owner:email.startsWith('madison')?'Madison':'Paul',brand:'Staffify',draftEnabled:true}));
 const rows=Array.from({length:11},(_,i)=>({campaignId:TALENT_ID,recipient:'sent'+i,sender:'paul@trystaffify.com'}));
 for(let i=0;i<25;i++)rows.push({campaignId:TALENT_ID,recipient:'new'+i,sender:balancedSender(accounts,rows)});
 assert.deepEqual(accounts.slice(0,3).map(a=>rows.filter(r=>r.sender===a.email).length),[12,12,12]);
 assert.equal(rows[0].sender,'paul@trystaffify.com');
});
