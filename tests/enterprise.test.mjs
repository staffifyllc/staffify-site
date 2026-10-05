import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,update,review,view,ENTERPRISE_KEY,POLICY} from '../api/_enterprise.js';
import {KEY} from '../api/_outreach-queue.js';
import {eligible,callReady} from '../api/_outreach-policy.js';
import {sendDecision} from '../api/_outreach-send.js';
test('enterprise cohort is distinct, sourced, conservative, and excluded from agency sending',()=>{
 const s=initialState();assert.notEqual(ENTERPRISE_KEY,KEY);assert.equal(s.accounts.length,6);assert.equal(POLICY.sendingEnabled,false);
 for(const a of s.accounts){assert.ok(a.stakeholders.length>=3&&a.stakeholders.length<=6);assert.ok(a.facts.some(f=>f.sourceIds.length));for(const f of a.facts)for(const id of f.sourceIds)assert.ok(view(s).sources[id]);const row={campaignId:a.lane,status:'prepared',bodyText:'hello',sentTouches:0,qualificationApproved:true};assert.equal(eligible(row,{pausedOwners:[],suppressions:[]}),false);assert.equal(callReady({...row,status:'sent',sentTouches:4,verifiedSentTouches:4,lastSentAt:'2026-01-01'}),false);assert.equal(sendDecision(row,{},[],[]),'campaign_not_enabled_hold');}
});
test('account notes persist with attribution and cannot fabricate outreach stage',()=>{
 const s=initialState(),body={action:'account',id:'capital-one',owner:'Madison',status:'qualifying',nextAction:'Confirm MSP',notes:'Source checked',nextActionAt:'2026-10-10'};const n=update(s,body,'paul');assert.equal(s.accounts[0].owner,'Paul');assert.equal(n.accounts[0].owner,'Madison');assert.equal(n.accounts[0].events[0].actor,'paul');assert.equal(n.revision,1);assert.throws(()=>update(s,{...body,status:'sent'},'paul'));assert.throws(()=>update(s,{...body,nextActionAt:'invalid'},'paul'));
});
test('contacts require evidence, deduplicate, cap at six and never become verified by user input',()=>{
 let s=initialState();const b={action:'contact',id:'capital-one',name:'Example person',role:'Buyer',email:'example@example.com',source:'https://example.com/bio',emailVerification:'valid'};s=update(s,b,'paul');assert.equal(s.accounts[0].contacts[0].emailVerification,'not_verified');assert.throws(()=>update(s,b,'paul'));assert.throws(()=>update(s,{...b,name:'Another',email:'new@example.com',source:'javascript:alert(1)'},'paul'));for(let i=1;i<6;i++)s=update(s,{...b,name:'Person '+i,email:`p${i}@example.com`},'paul');assert.throws(()=>update(s,{...b,name:'Seventh',email:'seven@example.com'},'paul'));
});
test('review reports overdue work and stale evidence without pretending to refresh it',()=>{
 const s=initialState();s.accounts[0].nextActionAt='2026-10-06';const r=review(s,'2026-12-01');assert.equal(r[0].due,true);assert.equal(r[0].evidenceStale,true);assert.equal(r[0].verifiedEmails,0);assert.ok(r[0].blockers.includes('Enterprise sending integration is not enabled'));assert.equal(s.accounts[0].researchedAt,'2026-10-05');
});
