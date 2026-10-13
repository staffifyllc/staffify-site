import {invoiceEvidence} from './_invoice-monitor.js';
import {onboardingAmount,placementUnits} from './_commission-evidence.js';
export const round=n=>Math.round((Number(n)||0)*100)/100;
export function billedHours(invoice, matched={}){
 let hours=0,review=false;
 for(const line of invoice.Line||[]){
  const d=line.SalesItemLineDetail;if(!d||!(Number(line.Amount)>0))continue;
  const name=String(d.ItemRef?.name||'');
  // Only explicit hourly billing units qualify. Staffing placement quantities are never hours.
  if(!/hour|hourly/i.test(name)){if(matched[line.Id]!=null)hours+=matched[line.Id];else if(!onboardingAmount({Line:[line]}))review=true;continue;}
  const qty=Number(d.Qty);if(!Number.isFinite(qty)||qty<=0||!(Number(d.UnitPrice)>0)){review=true;continue;}
  hours+=qty;
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
  const baseRate=a.rep==='paul'?30:a.source==='self'?30:a.source==='house'?20:null;
  const unitRates=units.map((u,i)=>before+i>=4?35:baseRate);
  if(units.length&&e.received>0&&!holds.length)counts[key]=before+units.length;
  const rate=units.length&&unitRates.every(x=>x!=null)?unitRates.reduce((s,r,i)=>s+r*units[i],0)/units.reduce((s,v)=>s+v,0):baseRate;
  if(onboard>0&&rate==null)holds.push('Choose business-generated or rep-generated lead');
  let fees=0;
  for(const receipt of e.receipts){const p=payments.find(p=>String(p.Id)===receipt.id);const method=p?.PaymentMethodRef?.name||methodNames[p?.PaymentMethodRef?.value]||'';
   if(onboard>0&&!method)holds.push('Payment method needs verification');
   if(/card|credit|visa|master|amex|discover|stripe/i.test(method)){fees+=(Number(p.TotalAmt)*.029+.30)*(receipt.amount/Number(p.TotalAmt));}
  }
  const collected=Math.min(e.total,e.received),share=e.total>0?onboard/e.total:0;
  const row={id:String(inv.Id),number:inv.DocNumber||inv.Id,date:inv.TxnDate,currency,total:e.total,balance:e.balance,collected:round(collected),receipts:e.receipts,hours:hour.hours,hoursReview:hour.review,rate,holds:[...new Set(holds)],status:e.fullyPaid?'Paid':e.received>0?'Part paid':'Awaiting payment',placementEarned:holds.length?0:round(Math.max(0,(collected-fees)*share)*(rate||0)/100),placementPending:round(e.balance*share*(rate||0)/100),residualEarned:!holds.some(h=>!/lead|method/i.test(h))&&e.fullyPaid?hour.hours:0,residualPending:e.fullyPaid?0:hour.hours,lines:(inv.Line||[]).filter(l=>l.SalesItemLineDetail).map(l=>({item:l.SalesItemLineDetail.ItemRef?.name,quantity:l.SalesItemLineDetail.Qty,description:l.Description,amount:l.Amount}))};
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
  for(const line of inv.Line||[]){if(line.SalesItemLineDetail?.ItemRef?.name!=='Services'||!line.Id)continue;
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
