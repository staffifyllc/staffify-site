import test from 'node:test';
import assert from 'node:assert/strict';
import {orderCallQueue} from '../assets/js/call-queue-order.js';
const row=(id,extra={})=>({id,campaignId:'agency',owner:'Paul',callReady:true,lastSentAt:'2026-10-01T12:00:00Z',callContact:{phoneStatus:'business_listed',phone:'+15555550100'},...extra});
test('due callbacks precede initial calls; oldest handoffs and ties have stable order',()=>{
 const input=[row('z'),row('a'),row('new',{lastSentAt:'2026-10-02'}),row('callback',{nextCallAt:'2026-10-10'})];
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
