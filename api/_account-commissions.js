import {invoiceEvidence} from './_invoice-monitor.js';
import {onboardingAmount,placementUnits} from './_commission-evidence.js';
import {flatOnboardingCommission} from './_caller-plan.js';
// Paul, 2026-10-22: "commission also for folks from People who met us and did not buy should be a
// flat $200." A client re-closed from the Lost deals list already had a sales call with Paul and
// did not buy; the re-engagement is a different, smaller piece of work than sourcing a new client,
// so it pays a flat fee per collected onboarding fee, whoever re-closes it. It is a LEAD SOURCE on
// the account, set like business-generated and rep-generated are.
export const LOST_DEAL_SOURCE='lost-deal';
export const LOST_DEAL_FEE=200;
export const round=n=>Math.round((Number(n)||0)*100)/100;
export function billedHours(invoice, matched={}){
 let hours=0,review=false;
 for(const line of invoice.Line||[]){
  const d=line.SalesItemLineDetail;if(!d||!(Number(line.Amount)>0))continue;
  // Hubstaff is the only source of hours, including when QBO has an hourly quantity.
  const verified=Number(matched[line.Id]);
  if(Number.isFinite(verified)&&verified>0)hours+=verified;
  else if(!onboardingAmount({Line:[line]}))review=true;
 }
 return {hours:round(hours),review};
}
export function accountLedger({accounts,invoices,payments,refunds=[],credits=[],methods=[],hourMatches={}}){
 const methodNames=Object.fromEntries(methods.map(m=>[m.Id,m.Name]));const counts={};
 const ordered=invoices.slice().sort((a,b)=>String(a.TxnDate).localeCompare(String(b.TxnDate))||String(a.Id).localeCompare(String(b.Id)));
 const result=accounts.map(a=>({...a,invoices:[],collected:0,incoming:0,residualEarned:0,residualPending:0,placementEarned:0,placementPending:0}));
 for(const inv of ordered){
  const a=result.find(x=>String(x.customerId)===String(inv.CustomerRef?.value));if(!a||inv.TxnDate<a.since)continue;
  const e=invoiceEvidence(inv,payments),hour=billedHours(inv,hourMatches[inv.Id]),onboard=onboardingAmount(inv),units=placementUnits(inv);
  const holds=[];const currency=inv.CurrencyRef?.value||'USD';
  if(currency!=='USD')holds.push('Non-USD invoice requires review');
  if(refunds.concat(credits).some(r=>String(r.CustomerRef?.value)===a.customerId&&r.TxnDate>=a.since&&Number(r.TotalAmt)>0))holds.push('Refund or credit requires allocation review');
  const key=a.rep+':'+String(inv.TxnDate).slice(0,7),before=counts[key]||0;
  // A rep on a signed flat trial plan earns a FIXED fee per qualifying onboarding fee collected,
  // not a share of it. The percentage ladder below, its fifth-placement escalator and the
  // lead-source question all belong to the percentage plans and must not touch a flat one: his
  // pay does not move with the size of the fee or with where the lead came from.
  // Two separate questions, deliberately not merged. WHAT the onboarding commission is: flat $200
  // for a re-engaged lost deal, otherwise the caller's own flat plan if they have one, otherwise a
  // percentage. And WHETHER residuals are paid: that belongs to the rep's plan (Milton's trial pays
  // none, 5.4), not to the lead source. Re-closing a lost deal changes the commission, never a
  // residual somebody is otherwise owed.
  const repFlat=flatOnboardingCommission(a.rep);
  const flatFee=a.source===LOST_DEAL_SOURCE?LOST_DEAL_FEE:repFlat;
  const noResidual=repFlat!=null;
  const baseRate=flatFee!=null?null:a.rep==='paul'?30:a.source==='self'?30:a.source==='house'?20:null;
  const unitRates=units.map((u,i)=>before+i>=4?35:baseRate);
  if(flatFee==null&&units.length&&e.received>0&&!holds.length)counts[key]=before+units.length;
  const rate=flatFee!=null?null:units.length&&unitRates.every(x=>x!=null)?unitRates.reduce((s,r,i)=>s+r*units[i],0)/units.reduce((s,v)=>s+v,0):baseRate;
  if(flatFee==null&&onboard>0&&rate==null)holds.push('Choose business-generated or rep-generated lead');
  let fees=0;
  for(const receipt of e.receipts){const p=payments.find(p=>String(p.Id)===receipt.id);const method=p?.PaymentMethodRef?.name||methodNames[p?.PaymentMethodRef?.value]||'';
   if(onboard>0&&!method)holds.push('Payment method needs verification');
   if(/card|credit|visa|master|amex|discover|stripe/i.test(method)){fees+=(Number(p.TotalAmt)*.029+.30)*(receipt.amount/Number(p.TotalAmt));}
  }
  const collected=Math.min(e.total,e.received),share=e.total>0?onboard/e.total:0;
  const row={id:String(inv.Id),number:inv.DocNumber||inv.Id,date:inv.TxnDate,currency,total:e.total,balance:e.balance,collected:round(collected),receipts:e.receipts,hours:hour.hours,hoursReview:hour.review,rate,flatFee,holds:[...new Set(holds)],status:e.fullyPaid?'Paid':e.received>0?'Part paid':'Awaiting payment',
   // 5.2: owed only once the onboarding fee is received IN FULL. Payments are not allocated to
   // invoice lines, so an invoice that mixes an onboarding fee with service hours only proves the
   // fee is fully collected when the whole invoice is. One invoice carrying a fee is one
   // commission: instalments toward it do not create a second.
   placementEarned:flatFee!=null?(holds.length||!(onboard>0)||!e.fullyPaid?0:flatFee):holds.length?0:round(Math.max(0,(collected-fees)*share)*(rate||0)/100),
   placementPending:flatFee!=null?(onboard>0&&!e.fullyPaid?flatFee:0):round(e.balance*share*(rate||0)/100),
   // 5.4: no residuals during the trial, so hours on his accounts earn him nothing.
   residualEarned:noResidual?0:!holds.some(h=>!/lead|method/i.test(h))&&e.fullyPaid?hour.hours:0,
   residualPending:noResidual?0:e.fullyPaid?0:hour.hours,lines:(inv.Line||[]).filter(l=>l.SalesItemLineDetail).map(l=>({item:l.SalesItemLineDetail.ItemRef?.name,quantity:l.SalesItemLineDetail.Qty,description:l.Description,amount:l.Amount}))};
  if(hour.review)row.holds.push('Some invoice lines are not confirmed hourly units');
  a.invoices.push(row);
  if(currency==='USD')for(const k of ['collected','residualEarned','residualPending','placementEarned','placementPending'])a[k]=round(a[k]+row[k]);
  if(currency==='USD')a.incoming=round(a.incoming+e.balance);
 }
 return result;
}

const norm=x=>String(x||'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function matchServiceHours(accounts,invoices,hubstaff){
 const out={},candidates=[],counts={};if(!hubstaff?.connected||hubstaff.truncated)return out;
 for(const inv of invoices){const account=accounts.find(a=>a.customerId===String(inv.CustomerRef?.value));if(!account||inv.TxnDate<account.since)continue;
  for(const line of inv.Line||[]){if(!line.SalesItemLineDetail||!line.Id||onboardingAmount({Line:[line]})>0)continue;
   const m=String(line.Description||'').match(/^(.+?) - (.+?) \((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([A-Z][a-z]{2} \d{1,2}, \d{4})\)$/);if(!m)continue;
   const date=new Date(m[3]+' 12:00:00 GMT');if(Number.isNaN(+date))continue;const day=date.toISOString().slice(0,10);if(day<account.since)continue;
   const projects=hubstaff.clients.filter(c=>norm(c.name)===norm(m[2])&&[account.name,account.qboName].some(n=>norm(n)===norm(m[2])));
   if(projects.length!==1)continue;const project=projects[0];if(project.byDayUsers?.[day]?.length!==1)continue;
   const hours=Number(project.byDay?.[day])/3600;if(!(hours>0))continue;
   const key=project.projectId+':'+day;counts[key]=(counts[key]||0)+1;candidates.push({invoice:inv.Id,line:line.Id,key,hours});
  }
 }
 for(const c of candidates)if(counts[c.key]===1)(out[c.invoice]||(out[c.invoice]={}))[c.line]=c.hours;
 return out;
}
