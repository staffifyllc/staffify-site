import {workspaceHTML} from './_milton-content.js';
import {currentRep,redis,readBody,SITE} from './_auth.js';
import {miltonIdentity,MILTON_EMAIL,MILTON_PLAN,miltonCommission} from './_milton-plan.js';
const KEY='finance:milton-onboardings:v1';
const parse=v=>typeof v==='string'?JSON.parse(v):v;
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');
 const who=await currentRep(req).catch(()=>null);
 if(!who)return res.status(401).json({error:'Sign in to your Staffify account'});
 const admin=who.role==='admin';
 if(!admin&&!miltonIdentity(who))return res.status(403).json({error:'This workspace is private'});
 const monitor=await redis.get('finance:invoice-monitor:v1');
 if(req.method==='POST'){
  if(req.headers.origin!==SITE)return res.status(403).json({error:'Invalid origin'});
  const b=readBody(req);
  if(b.action==='complete-training'){
   if(!['positioning','calls','payment','booking'].includes(b.module))return res.status(400).json({error:'Invalid module'});
   await redis.hset('training:milton:'+who.email,{[b.module]:new Date().toISOString()});
  }else if(b.action==='attribute'&&admin){
   const invoice=monitor?.invoices?.find(i=>i.id===String(b.invoiceId));
   if(!invoice||!invoice.placement||invoice.currency!=='USD')return res.status(400).json({error:'Choose a verified USD onboarding invoice'});
   if(!/^\d{4}-\d{2}-\d{2}$/.test(b.bookedAt||'')||b.bookedAt<MILTON_PLAN.start||b.bookedAt>MILTON_PLAN.end||!/^\d{4}-\d{2}-\d{2}$/.test(b.signedAt||'')||b.signedAt<b.bookedAt||b.signedAt>'2027-02-22'||!/^https:\/\/app.hubspot.com\//.test(b.evidence||'')||b.confirmDistinctFee!==true)return res.status(400).json({error:'Trial booking, signed agreement date, HubSpot attribution evidence and distinct fee confirmation required'});
   // One entry per confirmed fee. A multi-fee invoice requires allocation review, never quantity-based assumptions.
   const record={id:invoice.id,invoiceId:invoice.id,customerId:invoice.customerId,client:invoice.client,email:MILTON_EMAIL,bookedAt:b.bookedAt,signedAt:b.signedAt,evidence:b.evidence,confirmedBy:who.email,confirmedAt:new Date().toISOString()};
   if(!await redis.hsetnx(KEY,record.id,JSON.stringify(record)))return res.status(409).json({error:'Invoice already attributed; review existing entry'});
  }else return res.status(403).json({error:'Action not permitted'});
 }else if(req.method!=='GET')return res.status(405).end();
 const raw=await redis.hgetall(KEY)||{},clearRaw=await redis.hgetall('finance:verified-settlements:v1')||{};
 const clearances=Object.fromEntries(Object.entries(clearRaw).map(([k,v])=>[k,parse(v)]));
 const fresh=monitor?.status==='complete'&&Date.now()-Date.parse(monitor.updatedAt)<15*60000;
 const rows=Object.values(raw).map(parse).filter(x=>x.email===MILTON_EMAIL).map(x=>miltonCommission(x,monitor?.invoices?.find(i=>i.id===x.invoiceId),clearances,fresh));
 return res.json({workspaceHTML,name:'Milton',email:MILTON_EMAIL,admin,plan:MILTON_PLAN,rows,checkedAt:monitor?.updatedAt||null,paymentDataFresh:!!fresh,training:await redis.hgetall('training:milton:'+who.email)||{},updates:[{date:'2026-10-19',title:'Your trial workspace is ready',body:'Sell dedicated remote staffing. All onboarding fees are due in full upfront. No financing, installments or unauthorized discounts. Use the shared call queue and log each outcome.'}],payrollNote:'Biweekly payroll. First payday and cutoff await confirmation. Eligible commission is not proof of payout. No automatic bank transfers.'});
}
