import test from 'node:test';
import assert from 'node:assert/strict';
import {orderCallQueue,queueGroup,queueMix} from '../assets/js/call-queue-order.js';
const row=(id,extra={})=>({id,campaignId:'agency',owner:'Paul',callReady:true,lastSentAt:'2026-10-01T12:00:00Z',callContact:{phoneStatus:'business_listed',phone:'+15555550100'},...extra});
test('due callbacks precede initial calls; oldest handoffs and ties have stable order',()=>{
 const input=[row('z'),row('a'),row('new',{lastSentAt:'2026-10-02'}),row('callback',{callOutcome:'callback',nextCallAt:'2026-10-10'})];
 assert.deepEqual(orderCallQueue(input,{campaign:'agency'}).map(r=>r.id),['callback','a','z','new']);
 assert.equal(input[0].id,'z');
});
test('queue never mixes campaigns, owners, excluded records or unconfirmed phones',()=>{
 const input=[row('ready'),row('other',{campaignId:'ceo'}),row('madison',{owner:'Madison'}),row('stopped',{callReady:false}),row('research',{callContact:{phoneStatus:'unconfirmed'}})];
 assert.deepEqual(orderCallQueue(input,{campaign:'agency',owner:'Paul'}).map(r=>r.id),['ready']);
 assert.deepEqual(orderCallQueue(input,{campaign:'agency',owner:'Paul',research:true}).map(r=>r.id),['research']);
});
test('missing dates sort after known dates; search keeps the filtered sequence',()=>{
 const input=[row('missing',{lastSentAt:null,company:'Alpha'}),row('known',{company:'Alpha'}),row('beta',{company:'Beta'})];
 assert.deepEqual(orderCallQueue(input,{campaign:'agency',search:'alpha'}).map(r=>r.id),['known','missing']);
});

test('unvalidated CRM numbers can enter live checks but are not labelled verified',()=>{
 const input=[row('crm',{callContact:{phone:'+15555550100',phoneStatus:'available'}}),row('listed')];
 assert.deepEqual(orderCallQueue(input,{campaign:'agency'}).map(r=>r.id),['listed','crm']);
});

test('shared queue includes both sales owners across campaigns while retaining explicit campaign filters',()=>{
 const input=[row('paul'),row('madison',{owner:'Madison',campaignId:'ceo'}),row('stopped',{callReady:false})];
 assert.deepEqual(orderCallQueue(input,{campaign:'all'}).map(r=>r.id),['madison','paul']);
 assert.deepEqual(orderCallQueue(input,{campaign:'ceo'}).map(r=>r.id),['madison']);
});

test('a lead another teammate claimed is never handed out as work, and my own follow-up still is',()=>{
 const base={campaignId:'c',owner:'Paul',callContact:{phoneStatus:'business_listed',phone:'1'},lastSentAt:'2026-01-01'};
 const rows=[
  {...base,id:'open',callReady:true,unclaimed:true,dueForMe:false},
  {...base,id:'theirs',callReady:true,unclaimed:false,dueForMe:false,callOwner:'other@example.com'},
  {...base,id:'mine',callReady:true,unclaimed:false,dueForMe:true,callOwner:'me@example.com'},
  {...base,id:'done',callReady:false,unclaimed:false,dueForMe:false,callOwner:'other@example.com'},
 ];
 const ids=orderCallQueue(rows,{campaign:'all'}).map(r=>r.id);
 assert.ok(ids.includes('open'));
 assert.ok(ids.includes('mine'));
 assert.ok(!ids.includes('theirs'));
 assert.ok(!ids.includes('done'));
});

// Paul, 2026-10-27: "The people that he's calling, they need to be moving to the back or wherever
// they need to move based on the outcome of these calls."
const NOW=Date.parse('2026-10-27T17:00:00Z');
const tried=(n,lastAt)=>Array.from({length:n},(_,i)=>({at:new Date(Date.parse(lastAt)-i*86400000).toISOString(),outcome:i%2?'voicemail':'no_answer',caller:'miltion@trystaffify.com'}));
test('yesterday\'s no-answers go to the back: callbacks due, then not now, then new leads, then people to try again',()=>{
 const input=[
  row('retry',{callOutcome:'no_answer',nextCallAt:'2026-10-27T16:00:00Z',callHistory:tried(1,'2026-10-26T21:00:00Z'),dueForMe:true,unclaimed:false}),
  row('fresh-crm',{callContact:{phoneStatus:'crm_unconfirmed',phone:'+15555550101'},lastSentAt:'2026-09-01T12:00:00Z',unclaimed:true}),
  row('fresh-listed',{lastSentAt:'2026-10-05T12:00:00Z',unclaimed:true}),
  row('later',{callOutcome:'timing',nextCallAt:'2026-10-27T10:00:00Z',dueForMe:true,unclaimed:false}),
  row('callback',{callOutcome:'callback',nextCallAt:'2026-10-27T15:00:00Z',dueForMe:true,unclaimed:false}),
  row('new-number',{callOutcome:'wrong_number',wrongNumberRetry:true,callContact:{phoneStatus:'business_listed',phone:'+15555550102'},lastSentAt:'2026-10-06T12:00:00Z',unclaimed:true}),
 ];
 assert.deepEqual(orderCallQueue(input,{campaign:'all',now:NOW}).map(r=>r.id),['callback','later','fresh-listed','new-number','fresh-crm','retry']);
 assert.deepEqual(input.map(r=>queueGroup(r,NOW)),['retry','new','new','later','callback','new']);
});
test('among people to try again: fewest tries first, then the longest since they were tried',()=>{
 const r=(id,n,last)=>row(id,{callOutcome:'voicemail',nextCallAt:'2026-10-27T16:00:00Z',callHistory:tried(n,last),dueForMe:true,unclaimed:false});
 const input=[r('four',4,'2026-10-20T20:00:00Z'),r('once-recent',1,'2026-10-26T20:00:00Z'),r('once-older',1,'2026-10-22T20:00:00Z'),r('twice',2,'2026-10-21T20:00:00Z')];
 assert.deepEqual(orderCallQueue(input,{campaign:'all',now:NOW}).map(x=>x.id),['once-older','once-recent','twice','four']);
});
test('a callback that is not due yet is not pulled forward, and the mix counts what the bar shows',()=>{
 const input=[row('cb-later',{callOutcome:'callback',nextCallAt:'2026-10-28T15:00:00Z',callReady:true}),row('fresh'),row('retry',{callOutcome:'no_answer',nextCallAt:'2026-10-27T16:00:00Z'})];
 assert.equal(queueGroup(input[0],NOW),'new','an undue callback is only offered if the server says so; it is not treated as due');
 assert.deepEqual(queueMix(orderCallQueue(input,{campaign:'all',now:NOW}),NOW),{callback:0,later:0,new:2,retry:1});
});
