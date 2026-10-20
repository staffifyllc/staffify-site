import test from 'node:test';import assert from 'node:assert/strict';import {mergeSnapshot,visibleState,controlState,ownerFor} from '../api/_outreach-queue.js';
const row={id:'one',sender:'paul@trystaffify.com',owner:'Paul',recipient:'a@example.com',status:'draft_saved'};
const input={records:[row],assignments:[{email:'a@example.com',owner:'Madison',agencyKey:'example.com'}],suppressions:[]};
test('ownership cannot be bypassed by incoming sender or assignment',()=>{const s=mergeSnapshot(null,input);assert.equal(s.records[0].status,'reserved_for_madison_external');assert.equal(mergeSnapshot(s,{...input,assignments:[]}).records[0].owner,'Madison');});
test('exclusion and pause survive stale worker state',()=>{let s=mergeSnapshot(null,input);s=controlState(s,{action:'suppress',email:row.recipient},'all');s=controlState(s,{action:'pause',owner:'Madison'},'all');s=mergeSnapshot(s,input);assert.equal(s.records[0].status,'suppressed');assert.deepEqual(s.pausedOwners,['Madison']);});
test('owner access isolation',()=>{const s=mergeSnapshot(null,input);assert.equal(visibleState(s,'Paul').records.length,0);assert.equal(visibleState(s,'Madison').records.length,1);assert.throws(()=>controlState(s,{action:'suppress',email:row.recipient},'Paul'));assert.equal(ownerFor({email:'outsider@example.com',role:'rep'}),null);});
test('reject duplicate records and unknown senders',()=>{assert.throws(()=>mergeSnapshot(null,{...input,records:[row,row]}));assert.throws(()=>mergeSnapshot(null,{...input,records:[{...row,sender:'other@example.com'}]}));});
import { readFileSync } from 'node:fs';
import {spawnSync} from 'node:child_process';
test('review page script parses',()=>{const html=readFileSync(new URL('../outreach-review/index.html',import.meta.url),'utf8');const js=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];const parsed=spawnSync(process.execPath,['--input-type=module','--check'],{input:js,encoding:'utf8'});assert.equal(parsed.status,0,parsed.stderr);});

test('stale call-ready flag cannot survive reply, suppression or owner pause',()=>{
 const r={id:'call',owner:'Paul',recipient:'a@example.com',status:'human_reply_hold',sentTouches:4,verifiedSentTouches:4,lastSentAt:'2026-01-01T00:00:00Z',callReady:true};
 const s={records:[r],assignments:[],suppressions:[],pausedOwners:[]};
 assert.equal(visibleState(s,'all').records[0].callReady,false);
 r.status='sent';assert.equal(visibleState(s,'all').records[0].callReady,true);
 s.pausedOwners=['Paul'];assert.equal(visibleState(s,'all').records[0].callReady,false);
 s.pausedOwners=[];s.suppressions=[r.recipient];assert.equal(visibleState(s,'all').records[0].callReady,false);
});

import {canUseCallQueue,sharedCallState} from '../api/_outreach-queue.js';
test('caller access does not confer sales owner access and shared queue excludes ineligible records',()=>{
 const caller={email:'caller@example.com',role:'caller'};
 assert.equal(canUseCallQueue(caller),true);assert.equal(ownerFor(caller),null);
 assert.equal(canUseCallQueue({email:'outsider@example.com',role:'rep'}),false);
 const due={...row,status:'sent',sentTouches:4,verifiedSentTouches:4,lastSentAt:'2026-01-01'};
 const s={revision:1,records:[due,{...due,id:'two',owner:'Madison',recipient:'b@example.com'},{...due,id:'reply',status:'human_reply_hold'}],assignments:[],pausedOwners:[],suppressions:[]};
 assert.equal(sharedCallState(s).records.length,2);assert.equal(sharedCallState(s).assignments,undefined);
 // Nothing is claimed until somebody records an outcome, so both are offered as work.
 assert.equal(sharedCallState(s,caller.email).records.filter(r=>r.unclaimed).length,2);
 const next=controlState(s,{action:'call-outcome',id:'two',outcome:'connected'},'all',caller.email);
 assert.equal(next.records[1].owner,'Madison');assert.equal(next.records[1].callHistory[0].caller,caller.email);
 // Working it claims the follow-up without touching the sales owner.
 assert.equal(next.records[1].callOwner,caller.email);
 assert.equal(next.records[1].owner,'Madison');
 // Still VISIBLE to the team, but no longer offered as unclaimed work to anyone.
 const seen=sharedCallState(next,caller.email);
 assert.equal(seen.records.length,2);
 assert.equal(seen.records.filter(r=>r.unclaimed).length,1);
 const claimed=seen.records.find(r=>r.id==='two');
 assert.equal(claimed.claimed,true);assert.equal(claimed.mine,true);assert.equal(claimed.unclaimed,false);
 // A different teammate sees the owner, and it is not offered to them either.
 const other=sharedCallState(next,'someone.else@example.com').records.find(r=>r.id==='two');
 assert.equal(other.callOwner,caller.email);assert.equal(other.mine,false);assert.equal(other.unclaimed,false);
});

test('first recorded outcome claims the follow-up and a later caller cannot steal it',()=>{
 const due={...row,status:'sent',sentTouches:4,verifiedSentTouches:4,lastSentAt:'2026-01-01'};
 const s={revision:1,records:[due],assignments:[],pausedOwners:[],suppressions:[]};
 const soon=new Date(Date.now()+864e5).toISOString();
 const first=controlState(s,{action:'call-outcome',id:due.id,outcome:'no_answer',nextCallAt:soon},'all','first@example.com');
 assert.equal(first.records[0].callOwner,'first@example.com');
 const stamped=first.records[0].callOwnerAt;
 // A second caller covering the callback appends history but ownership does not move.
 const second=controlState({...first,records:first.records.map(r=>({...r,callOutcome:undefined,nextCallAt:null}))},
   {action:'call-outcome',id:due.id,outcome:'voicemail',nextCallAt:soon},'all','second@example.com');
 assert.equal(second.records[0].callOwner,'first@example.com');
 assert.equal(second.records[0].callOwnerAt,stamped);
 assert.equal(second.records[0].callHistory.length,2);
 assert.equal(second.records[0].callHistory[1].caller,'second@example.com');
});
