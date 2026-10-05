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
