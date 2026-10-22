import test from 'node:test';import assert from 'node:assert/strict';import {withCallPhones} from '../api/_outreach-call-phones.js';
const state={records:[{id:'1',recipient:'owner@example.com',callReady:true},{id:'2',recipient:'other@example.com',callReady:false}]};
function cache(){const m=new Map();return {get:async k=>m.get(k),set:async(k,v)=>m.set(k,v)};}
test('due cards receive CRM phone without changing outreach status; cache prevents repeated lookups',async()=>{let calls=0;const redis=cache(),crm=async(path)=>{calls++;return path.includes('account-info')?{portalId:51666712}:{results:[{id:'123',properties:{email:'owner@example.com',phone:'+15551234567'}}]};};let d=await withCallPhones(state,{redis,crm});assert.equal(d.records[0].callContact.phone,'+15551234567');assert.equal(d.records[1].callContact,undefined);assert.equal(state.records[0].callContact,undefined);await withCallPhones(state,{redis,crm});assert.equal(calls,2);});
test('blank primary number uses mobile; genuinely missing phone remains explicit',async()=>{for(const [mobile,expected] of [['+15557654321','+15557654321'],[null,null]]){const crm=async path=>path.includes('account-info')?{portalId:51666712}:{results:[{id:'123',properties:{email:'owner@example.com',phone:' ',mobilephone:mobile}}]};const d=await withCallPhones(state,{redis:cache(),crm});assert.equal(d.records[0].callContact.phone,expected);}});
test('CRM outage or wrong portal leaves the queue visible and never invents a phone',async()=>{for(const crm of [async()=>{throw Error('offline')},async()=>({portalId:7858857})]){const d=await withCallPhones(state,{redis:cache(),crm});assert.equal(d.records[0].callContact.phoneStatus,'unavailable');assert.equal(d.records.length,2);}});
test('failed live eligibility hides a call without deleting its history',async()=>{const redis=cache();await redis.set('staffify:call-block:1',{error:'CRM client',lastSentAt:'2026-10-01'});const records=[{...state.records[0],lastSentAt:'2026-10-01',events:[{kind:'sent'}]}];const d=await withCallPhones({records},{redis,crm:async()=>{throw Error('offline')}});assert.equal(d.records[0].callReady,false);assert.equal(d.records[0].events.length,1);assert.equal(records[0].callReady,true);});
// Paul, 2026-10-22: "our sales people shouldn't have to do this." This used to withhold the number
// entirely, so the card showed nothing and told the caller to go and research it. An uncorroborated
// main line is a worse call than a direct dial and a far better call than none, so it is handed
// over and labelled rather than hidden. The original intent, never CALL it verified, still holds.
test('an uncorroborated number is given to the caller, labelled, not withheld',async()=>{const redis=cache();await redis.set('staffify:call-phone-evidence:owner@example.com',{phone:'3055551234',status:'needs_confirmation'});const d=await withCallPhones(state,{redis,crm:async()=>{throw Error('offline')}});const c=d.records[0].callContact;
 assert.equal(c.phone,'3055551234','he can actually dial something');
 assert.equal(c.phoneStatus,'crm_unconfirmed','and is told it is not corroborated');
 assert.notEqual(c.phoneStatus,'business_listed','it is never passed off as verified');
 assert.match(c.phoneSource,/not found on their website/);
 assert.match(c.phoneDetail,/Ask for them by name/);});

test('a number published on their own website is used when nothing better exists',async()=>{const redis=cache();await redis.set('staffify:call-site-phone:owner@example.com',{phone:'+15129004433',sourceUrl:'https://example.com/contact/',alternates:['+15129004434'],checkedAt:new Date().toISOString()});const d=await withCallPhones(state,{redis,crm:async()=>{throw Error('offline')}});const c=d.records[0].callContact;
 assert.equal(c.phone,'+15129004433');
 assert.equal(c.phoneStatus,'site_main');
 assert.equal(c.phoneSourceUrl,'https://example.com/contact/','the caller can see where it came from');
 assert.deepEqual(c.phoneAlternates,['+15129004434']);});

test('a vendor direct dial outranks the main line, because it reaches the person',async()=>{const redis=cache();
 await redis.set('staffify:call-site-phone:owner@example.com',{phone:'+15129004433',sourceUrl:'https://example.com/contact/',alternates:[],checkedAt:new Date().toISOString()});
 await redis.set('staffify:call-phone-vendor:owner@example.com',{phone:'+18137084610',source:'RocketReach',type:'mobile',checkedAt:new Date().toISOString()});
 const d=await withCallPhones(state,{redis,crm:async()=>{throw Error('offline')}});
 assert.equal(d.records[0].callContact.phone,'+18137084610');
 assert.equal(d.records[0].callContact.phoneStatus,'vendor_direct');});
