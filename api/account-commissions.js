import {redis,currentRep,readBody,SITE} from './_auth.js';
import {financeAccess,financeMachine} from './_finance-access.js';
import {qboQuery} from './_qbo.js';
import {hoursByClient} from './_hubstaff.js';
import {accountLedger,matchServiceHours} from './_account-commissions.js';
const KEY='finance:account-owners:v1',SNAP='finance:account-ledger:v1';
const parse=x=>typeof x==='string'?JSON.parse(x):x;
const norm=x=>String(x||'').toLowerCase().replace(/[^a-z0-9]/g,'');
async function all(type){let rows=[];for(let start=1;start<=10001;start+=1000){const j=await qboQuery(`SELECT * FROM ${type} STARTPOSITION ${start} MAXRESULTS 1000`);const p=j.QueryResponse?.[type]||[];rows.push(...p);if(p.length<1000)return rows;}throw Error('Source too large; refresh incomplete');}
async function refresh(){
 const [customers,invoices,payments,refunds,credits,methods]=await Promise.all(['Customer','Invoice','Payment','RefundReceipt','CreditMemo','PaymentMethod'].map(all));
 let raw=await redis.hgetall(KEY)||{};
 const missing=[];
 for(const seed of [{name:'Evan Ulsh',rep:'paul',source:'self',since:'2026-09-29'},{name:'John Reid',rep:'madison',source:'house',since:'2026-09-04'},{name:'Joel Marion Photography',rep:'madison',source:'',since:'2026-09-29'}]){
  const matches=customers.filter(c=>[c.DisplayName,c.CompanyName,[c.GivenName,c.FamilyName].filter(Boolean).join(' ')].some(n=>norm(n)===norm(seed.name)));
  if(matches.length!==1){missing.push(seed.name+': '+(matches.length?'multiple QBO customers match':'QBO customer match needed'));continue;}
  const c=matches[0];if(!raw[c.Id])await redis.hsetnx(KEY,c.Id,JSON.stringify({...seed,customerId:String(c.Id),name:seed.name,qboName:c.DisplayName,by:'Paul instruction',at:new Date().toISOString()}));
 }
 raw=await redis.hgetall(KEY)||{};
 const accounts=Object.values(raw).map(parse).filter(a=>!a.archived).map(a=>{const c=customers.find(c=>String(c.Id)===a.customerId);return {...a,qboName:c?.DisplayName||a.name,name:c?.CompanyName==='Joel Marion Photography'?'Joel Marion Photography':a.name};});
 const start=accounts.map(a=>a.since).sort()[0]||new Date().toISOString().slice(0,10);
 const hours=await hoursByClient({start,stop:new Date().toISOString().slice(0,10)}).catch(()=>({connected:false}));
 const hourMatches=matchServiceHours(accounts,invoices,hours);
 const snapshot={updatedAt:new Date().toISOString(),accounts:accountLedger({accounts,invoices,payments,refunds,credits,methods,hourMatches}),hubstaffConnected:!!hours.connected&&!hours.truncated,customers:customers.map(c=>({id:String(c.Id),name:c.DisplayName})),missing,status:'complete'};
 await redis.set(SNAP,snapshot);return snapshot;
}
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');const machine=financeMachine(req),who=await currentRep(req).catch(()=>null);
 if(!machine&&!financeAccess(who))return res.status(who?403:401).json({error:'Private to Paul and Madison'});
 const canEdit=machine||who?.email!=='madison@gostaffify.com';
 if(req.method==='POST'){
  if(!canEdit||(!machine&&req.headers.origin!==SITE))return res.status(403).json({error:'Only Paul can change account ownership'});
  const b=readBody(req);if(!['paul','madison'].includes(b.rep)||!['self','house',''].includes(b.source)||!/^\d{4}-\d{2}-\d{2}$/.test(b.since||''))return res.status(400).json({error:'Rep, lead source and start date required'});
  const snapshot=await redis.get(SNAP),customer=snapshot?.customers?.find(c=>c.id===String(b.customerId));if(!customer)return res.status(400).json({error:'Choose a verified QBO customer'});
  const before=await redis.hget(KEY,customer.id);const after={customerId:customer.id,name:customer.name,qboName:customer.name,rep:b.rep,source:b.source,since:b.since,by:who?.email||'Paul instruction',at:new Date().toISOString()};
  await redis.lpush('finance:account-owner-audit:v1',JSON.stringify({before,after}));await redis.hset(KEY,{[customer.id]:JSON.stringify(after)});
 }else if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
 try{
  let s=await redis.get(SNAP);
  if(machine||req.method==='POST'||!s){
   const lock=await redis.set('finance:account-ledger:lock',Date.now(),{nx:true,ex:180});
   if(lock){try{s=await refresh();}finally{await redis.del('finance:account-ledger:lock');}}
  }
  if(!s)return res.status(503).json({error:'First QBO sync is running'});
  return res.json({...s,canEdit,viewer:who?.email==='madison@gostaffify.com'?'madison':'paul',stale:Date.now()-Date.parse(s.updatedAt)>10*60000});
 }catch(e){return res.status(503).json({error:'QBO refresh failed. No new earnings have been asserted.',detail:String(e.message).slice(0,160)});}
}
