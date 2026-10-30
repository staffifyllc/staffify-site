import test from 'node:test';
import assert from 'node:assert/strict';
import {makeWorker} from '../api/_outreach-worker-core.js';
import * as policy from '../api/_outreach-policy.js';
function harness({record,mailboxFailed=false,createUncertain=false}={}){
 const key='queue',calls=[];const initial={revision:1,records:record?[record]:[],assignments:[],suppressions:[],pausedOwners:[],creations:[],updatedAt:new Date().toISOString()};const db=new Map([[key,structuredClone(initial)]]);
 const redis={get:async k=>structuredClone(db.get(k)),set:async(k,v,o)=>{if(o?.nx&&db.has(k))return null;db.set(k,structuredClone(v));return 'OK';},eval:async(script,keys,args)=>{if(script.includes('cjson.decode')){if(db.get(key).revision!==Number(args[0]))return 0;db.set(key,JSON.parse(args[1]));return 1;}if(db.get(keys[0])===args[0])db.delete(keys[0]);return 1;}};
 const sender='paul@trystaffify.com';const prior={id:'sent1',replyId:'sent1',mailbox:sender,threadId:'thread',from:sender,to:['prospect@example.com'],sent:true,text:'hello',date:Date.now()-72*3600000};let draft={id:'draft',message:{id:'msg',threadId:'thread',labelIds:['DRAFT'],payload:{headers:[{name:'To',value:'prospect@example.com'}]}}};
 const d={...policy,redis,KEY:key,config:async()=>({enabled:true,draftingEnabled:true,accounts:[{email:sender,brand:'Staffify',draftEnabled:true,owner:'Paul'}]}),access:async()=>{if(mailboxFailed)throw Error('expired');return 'token';},gmail:async(t,path,body,method)=>{calls.push({path,body,method});if(path.startsWith('messages?'))return {};if(path.startsWith('threads/'))return {messages:[prior]};if(path==='drafts'&&body){if(createUncertain)throw Error('connection lost');return draft;}if(path.startsWith('drafts/')){if(method==='PUT')draft={...draft,message:{...draft.message,payload:{headers:[{name:'To',value:''}]}}};return draft;}throw Error(path);},history:async()=>[prior],headers:m=>Object.fromEntries((m.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value])),messageText:()=>'',mime:o=>JSON.stringify(o),compactMessage:m=>m,assertDraft:(d,r)=>{assert.equal(d.message.payload.headers[0].value,r||'');return d;},supply:async()=>0,canDraft:async()=>true,suppress:async()=>{},randomUUID:()=>Math.random().toString(),cronSecret:()=> 'test-secret'};
 const req={headers:{authorization:'Bearer test-secret'}};let response;const res={setHeader(){},status(code){this.code=code;return this;},json(body){response={code:this.code,body};assert.equal(db.has('outreach:cloud:lock'),false,'lock is released before response');return response;}};
 return {d,db,calls,run:async()=>{await makeWorker(d)(req,res);return response;},state:()=>db.get(key),setDraft:v=>draft=v};
}
const base={id:'one',recipient:'prospect@example.com',sender:'paul@trystaffify.com',owner:'Paul',sentTouches:1,status:'sent',lastSentAt:new Date(Date.now()-72*3600000).toISOString(),threadId:'thread',subject:'A useful task',bodyText:'hello'};
test('successful follow-up is saved once, read back and remains single on retry',async()=>{const h=harness({record:base});await h.run();assert.equal(h.state().records[0].status,'draft_saved');assert.equal(h.calls.filter(c=>c.path==='drafts').length,1);h.d.gmail=async(t,path)=>path.startsWith('messages?')?{}:path.startsWith('threads/')?{messages:[{id:'pending',draft:true}]}:{id:'draft',message:{id:'msg',payload:{headers:[{name:'To',value:base.recipient}]}}};await h.run();assert.equal(h.calls.filter(c=>c.path==='drafts').length,1);});
test('uncertain Gmail create is held and never blindly retried',async()=>{const h=harness({record:base,createUncertain:true});assert.equal((await h.run()).code,503);assert.equal(h.state().records[0].status,'draft_creation_pending');await h.run();assert.equal(h.state().records[0].status,'draft_creation_uncertain_hold');assert.equal(h.calls.filter(c=>c.path==='drafts').length,1);});
test('global suppression clears recipients and verifies draft before progressing',async()=>{const h=harness({record:{...base,status:'suppressed',draftId:'draft'}});await h.run();assert.equal(h.state().records[0].cloudHeld,true);assert.equal(h.calls.filter(c=>c.method==='PUT').length,1);assert.equal(h.calls.filter(c=>c.path==='drafts/draft').length,3);});
test('a stale sent draft pointer is archived without trying to modify sent mail',async()=>{const h=harness({record:{...base,status:'held_reply',draftId:'draft'}});h.setDraft({id:'draft',message:{id:'msg',labelIds:['SENT']}});await h.run();assert.equal(h.state().records[0].draftId,null);assert.equal(h.state().records[0].previousDraftId,'draft');assert.equal(h.calls.filter(c=>c.method==='PUT').length,0);});
test('missing mailbox access fails closed without any Gmail mutation',async()=>{const h=harness({record:base,mailboxFailed:true});assert.equal((await h.run()).code,503);assert.equal(h.calls.length,0);});

test('an untracked pending Gmail draft prevents a duplicate follow-up',async()=>{const h=harness({record:base});h.d.history=async()=>[{id:'other',draft:true,mailbox:base.sender,to:[base.recipient]}];await h.run();assert.equal(h.state().records[0].status,'existing_draft_hold');assert.equal(h.calls.filter(c=>c.path==='drafts').length,0);});

// Paul, 2026-10-30: "not only being removed from our view, but removed from any automated contact as well".
test('a Not interested pressed in the Hub stops the person here before anything is drafted, and the CRM is told',async()=>{
 const h=harness({record:base});const synced=[];let done=0;
 h.d.stops={take:async()=>[{email:'Prospect@Example.com',hiringId:null,by:'madison@gostaffify.com',why:'Not interested / stop on a call',at:'2026-10-30T17:39:00Z'},{email:'nobody@else.com',hiringId:'hire:1',by:'madison@gostaffify.com',why:'Not interested / stop on a call'}],done:async n=>{done=n;}};
 h.d.suppress=async row=>{synced.push(row.recipient);};
 const r=await h.run();
 const row=h.state().records[0];
 assert.equal(row.status,'suppressed');assert.equal(row.stopped.by,'madison@gostaffify.com');assert.equal(row.globalSuppressionSynced,true);
 assert.deepEqual(h.state().suppressions.sort(),['nobody@else.com','prospect@example.com']);
 assert.equal(done,2,'both requests removed after the save');
 assert.deepEqual(synced,['prospect@example.com'],'the CRM write runs for the row (a person with no row was marked by the Hub press itself)');
 assert.equal(h.calls.filter(c=>c.path==='drafts'&&c.body).length,0,'nothing drafted for them');
 assert.deepEqual(r.body.stops,{requests:2,rows:1});
});

test('a failed save keeps the stop requests for the next run',async()=>{
 const h=harness({record:base});let done=0;
 h.d.stops={take:async()=>[{email:'prospect@example.com'}],done:async n=>{done=n;}};
 const realEval=h.d.redis.eval;h.d.redis.eval=async(script,keys,args)=>script.includes('cjson.decode')?0:realEval(script,keys,args);
 await h.run();
 assert.equal(done,0);assert.equal(h.state().records[0].status,'sent');
});

test('a row may carry a Reply-To, which reaches the draft',async()=>{
 const h=harness({record:{...base,replyTo:['paul@trystaffify.com','hello@gostaffify.com','milton@trystaffify.com']}});
 await h.run();
 const create=h.calls.find(c=>c.path==='drafts'&&c.body);
 assert.deepEqual(JSON.parse(create.body.message.raw).replyTo,['paul@trystaffify.com','hello@gostaffify.com','milton@trystaffify.com']);
});

test('stop requests are applied even while the hosted worker is paused',async()=>{
 const h=harness({record:base});let done=0;h.d.config=async()=>({enabled:false,accounts:[]});
 h.d.stops={take:async()=>[{email:'prospect@example.com',by:'madison@gostaffify.com'}],done:async n=>{done=n;}};
 await h.run();assert.equal(h.state().records[0].status,'suppressed');assert.equal(done,1);
});
test('a CRM that is briefly down is tried again later; a missing contact counts as done',async()=>{
 const h=harness({record:{...base,status:'suppressed'}});let calls=0;h.d.suppress=async row=>{calls++;row.crmRetryAt=new Date(Date.now()+15*60000).toISOString();return {retry:true};};
 await h.run();const row=h.state().records[0];assert.equal(row.globalSuppressionSynced,undefined);assert.ok(row.crmRetryAt);
 await h.run();assert.equal(calls,1,'not retried before its time');
});
