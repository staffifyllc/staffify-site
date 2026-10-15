import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {websiteLead} from '../api/_website-leads.js';
const raw=fs.readFileSync(new URL('../api/subscribe.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export function renderEmail','function renderEmail').replace('export default async function handler','async function handler');
async function request(body,{suppressed=false}={}){
 const writes=[];
 const redis={sismember:async()=>suppressed,hget:async(k,f)=>f==='signed_up_at'?100:0,hset:async(k,v)=>writes.push([k,v]),zadd:async()=>{},hgetall:async()=>({enrolled_at:100})};
 const context={Redis:function(){return redis;},process:{env:{}},console,slackNotify:async()=>{throw Error('unexpected notification');},fetch:async()=>{throw Error('unexpected email');}};
 vm.createContext(context);vm.runInContext(raw,context);
 let status,payload;const res={setHeader(){},status(n){status=n;return this;},json(v){payload=v;return this;}};
 await context.handler({method:'POST',headers:{},body},res);return {status,payload,writes};
}
test('optional phone is durably stored and exposed in authenticated lead projection',async()=>{
 const r=await request({email:'example@example.test',phone:'+1 (202) 555-0123',source:'delegation-popup'});
 assert.equal(r.status,200);assert.equal(r.writes[0][1].phone,'+1 (202) 555-0123');assert.equal(r.writes[0][1].phone_source,'delegation-popup');
 assert.equal(websiteLead(r.writes[0][1]).phone,'+1 (202) 555-0123');assert.equal(r.writes[0][1].sms_consent,undefined);
});
test('blank phone does not erase an existing phone',async()=>{for(const phone of ['',undefined]){const r=await request({email:'example@example.test',phone});assert.equal(r.status,200);assert.equal('phone' in r.writes[0][1],false);}});
test('invalid phone is rejected without writes',async()=>{for(const phone of ['123','abc',{},'1'.repeat(16)]){const r=await request({email:'example@example.test',phone});assert.equal(r.status,400);assert.equal(r.writes.length,0);}});
test('suppressed and honeypot requests do not persist phone',async()=>{const a=await request({email:'example@example.test',phone:'+12025550123'},{suppressed:true});assert.equal(a.writes.length,0);const b=await request({email:'example@example.test',phone:'+12025550123',website:'bot'});assert.equal(b.writes.length,0);});
