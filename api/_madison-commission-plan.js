// Paul confirmed these terms on 2026-09-29. Older offer pages and cached rate snapshots do not override them.
export const MADISON_PLAN=Object.freeze({version:'2026-09-29-confirmed',email:'madison@gostaffify.com',houseRate:20,selfRate:30,acceleratedRate:35,afterPlacements:4,residualPerHour:1,residualMonths:null,thresholdMode:'fifth-and-later',timezone:'America/New_York'});
const identities=new Set(['madison@gostaffify.com','madison@staffifyhq.com','madison@trystaffify.com','madison@hirestaffify.com','madison.sterling@trystaffify.com']);
export const isMadison=email=>identities.has(String(email||'').toLowerCase());
export const cents=value=>Math.round((Number(value)||0)*100)/100;
export function sourceKind(value){const v=String(value||'').trim().toLowerCase().replace(/[ _-]+/g,' ');if(['self','self sourced','madison','madison generated','rep sourced'].includes(v))return 'self';if(['house','business','company','paul','business generated','company generated'].includes(v))return 'house';return '';}
export function applyMadisonPlan(lines){
 const byMonth=new Map();
 for(const line of lines){if(!isMadison(line.repEmail)||line.dealType!=='va')continue;line.planVersion=MADISON_PLAN.version;const month=String(line.closeDate||'').slice(0,7);if(!/^\d{4}-\d{2}$/.test(month))continue;if(!byMonth.has(month))byMonth.set(month,[]);byMonth.get(month).push(line);}
 for(const [month,rows] of byMonth){
  let count=0;const claimed=new Set();
  rows.sort((a,b)=>String(a.closeDate).localeCompare(String(b.closeDate))||String(a.dealId).localeCompare(String(b.dealId)));
  for(const row of rows){
   const units=Array.isArray(row.placementUnits)?row.placementUnits:[];
   const eligible=!!row.invoiceId&&units.length>0&&!claimed.has(row.invoiceId)&&!row.refunded;
   row.month=month;row.monthlyPlacementsBefore=count;row.placements=eligible?units.length:0;
   const source=sourceKind(row.leadSource),baseRate=source==='self'?30:20;
   const weights=eligible?units:[1],total=weights.reduce((n,x)=>n+x,0)||1;
   const rates=weights.map((_,i)=>eligible&&count+i>=4?35:baseRate);
   const effective=rates.reduce((n,r,i)=>n+r*weights[i],0)/total;
   if(eligible){claimed.add(row.invoiceId);count+=units.length;}
   row.monthlyPlacementsAfter=count;
   if(row.status==='paid_out')continue; // Recorded payouts are never repriced.
   row.rate=effective;row.rateDisplay=cents(effective);row.unitRates=rates;row.accelerated=rates.some(r=>r===35);row.splitPlan=true;
   const sourceKnown=!!source||rates.every(r=>r===35);
   row.leadSourceVerified=sourceKnown;
   row.commission=row.refunded?0:cents(row.base*effective/100);
   row.remainingCommission=cents(row.outstanding*effective/100);
   for(const p of row.paymentSchedule||[]){const share=row.invoiceTotal?Math.min(1,(row.commissionEligibleBase||0)/row.invoiceTotal):0;p.commission=cents((p.amount*share-p.fee)*effective/100);}
   if(!sourceKnown&&row.status==='payable')row.status='source_review';
   if(!eligible&&row.status==='payable')row.status='placement_review';
  }
  for(const row of rows)row.monthlyVerifiedPlacements=count;
 }
 return lines;
}
export function residualTerms(email,closeDate,months=6){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(closeDate||''))return null;
 const from=new Date(closeDate+'T00:00:00Z');if(Number.isNaN(+from))return null;
 if(isMadison(email))return {from:closeDate,to:null,perHour:1};
 const to=new Date(from);to.setUTCMonth(to.getUTCMonth()+months);return {from:closeDate,to:to.toISOString().slice(0,10)};
}
export const eligibleResidualDay=(day,window)=>!!window&&day>=window.from&&(!window.to||day<window.to);
export async function ensureMadisonPlan(redis){
 const key='finance:madison-plan';const current=await redis.get(key);if(current?.version===MADISON_PLAN.version)return;
 const existing=await redis.hgetall('rep:'+MADISON_PLAN.email);if(!existing)throw Error('Madison Hub identity missing');
 await redis.set('finance:madison-plan:before:'+MADISON_PLAN.version,existing,{nx:true});
 await redis.hset('rep:'+MADISON_PLAN.email,{rate:'30',houseRate:'20',residualPerHour:'1',commissionPlanVersion:MADISON_PLAN.version});
 await redis.set(key,{...MADISON_PLAN,confirmedBy:'Paul',confirmedAt:'2026-09-29',appliedAt:new Date().toISOString()});
}
// Several placements for the same Madison client still earn one dollar per hour, not once per deal.
export function indexResidualDeal(index,key,deal){
 if(!key||key.length<=2)return;
 if(!Object.hasOwn(index,key)){index[key]=deal;return;}
 const prior=index[key];if(prior?.dealId===deal.dealId)return;
 if(prior&&isMadison(prior.ownerEmail)&&isMadison(deal.ownerEmail)){
  if(deal.closeDate&&(!prior.closeDate||deal.closeDate<prior.closeDate))index[key]=deal;
 }else index[key]=null;
}
