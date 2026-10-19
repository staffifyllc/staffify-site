import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../api/intake.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
async function run(body,fail=false){const writes=[],alerts=[];const redis={hset:async(...args)=>{if(fail)throw Error('offline');writes.push(args);},zadd:async(...args)=>writes.push(args)};const ctx={redis,readBody:r=>r.body,newToken:()=> 'test',slackNotify:async text=>alerts.push(text)};vm.createContext(ctx);vm.runInContext(source,ctx);let status,result;const res={setHeader(){},status(n){status=n;return this;},json(v){result=v;return this;}};await ctx.handler({method:'POST',headers:{},body},res);return {status,result,writes,alerts};}
const body={name:'Test fixture',email:'fixture@example.test',source:'sales-intake',notes:'Interview request: Hazel M. and Jedno P. [both]. Real estate media agency.'};
test('existing intake retains context and awaited alert',async()=>{const r=await run(body);assert.equal(r.status,200);assert.equal(r.writes[0][1].note,body.notes);assert.equal(r.writes[0][1].source,'sales-intake');assert.equal(r.writes[0][1].status,'new');assert.equal(r.writes[1][0],'leads:by_date');assert.match(r.alerts[0],/New Get to building intake/);});
test('failed storage is not acknowledged or notified',async()=>{const r=await run(body,true);assert.equal(r.status,500);assert.equal(r.alerts.length,0);});
test('honeypot and invalid email never create leads',async()=>{for(const b of [{...body,website:'bot'},{...body,email:'bad'}]){const r=await run(b);assert.equal(r.writes.length,0);assert.equal(r.alerts.length,0);}});

test('marketplace interview source requires payment and cannot be spoofed as paid',async()=>{for(const source of ['talent-marketplace','talent-marketplace-paid']){const r=await run({...body,source});assert.equal(r.status,402);assert.equal(r.writes.length,0);}});
