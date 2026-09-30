// QBO invoice/payment evidence is authoritative. Never infer a sale from a zero balance alone.
import {invoicePayments,placementUnits,onboardingAmount} from './_commission-evidence.js';
export const INVOICE_MONITOR_KEY='finance:invoice-monitor:v1';
const PIPELINE='914670001',WON='1390230875';
const cents=n=>Math.round(Number(n)*100);
const email=s=>String(s||'').trim().toLowerCase();
export function invoiceEvidence(invoice,payments){
 const receipts=[];
 for(const p of payments){
  if(String(p.CustomerRef?.value)!==String(invoice.CustomerRef?.value)||!(Number(p.TotalAmt)>0))continue;
  for(const a of invoicePayments(p))if(a.invoiceId===String(invoice.Id)&&a.amount>0)receipts.push({id:String(p.Id),amount:a.amount,date:p.TxnDate,updatedAt:p.MetaData?.LastUpdatedTime});
 }
 const total=Number(invoice.TotalAmt),balance=Number(invoice.Balance),received=receipts.reduce((n,p)=>n+p.amount,0);
 return {total,balance,received,receipts,fullyPaid:total>0&&balance===0&&cents(received)>=cents(total),placement:placementUnits(invoice).length>0,placementAmount:onboardingAmount(invoice)};
}
export function selectInvoiceDeal(deals,invoice,claimed={}){
 const eligible=deals.filter(d=>d.properties.pipeline===PIPELINE);
 const won=eligible.filter(d=>d.properties.dealstage===WON);
 if(won.length)return {reason:'Existing client: invoice tracked without creating another win'};
 const canonical=eligible.filter(d=>!/\bdiscovery\s+call\b/i.test(d.properties.dealname||''));
 const candidates=canonical.length?canonical:eligible;
 if(candidates.length!==1)return {reason:candidates.length?'Multiple deals need an invoice mapping':'No matching Staffify deal'};
 const d=candidates[0];
 if(claimed[d.id]&&String(claimed[d.id].invoiceId)!==String(invoice.Id))return {reason:'Deal already linked to a different invoice'};
 // Do not attach an older sale to a new opportunity using customer identity alone.
 if(d.properties.createdate&&invoice.TxnDate<String(d.properties.createdate).slice(0,10))return {reason:'Invoice predates this opportunity'};
 return {deal:d};
}
async function all(query,type){
 const rows=[];for(let start=1;start<=10001;start+=1000){const j=await query(`SELECT * FROM ${type} STARTPOSITION ${start} MAXRESULTS 1000`);const page=j.QueryResponse?.[type]||[];rows.push(...page);if(page.length<1000)return rows;}
 throw Error('Invoice monitor source pagination exceeded limit');
}
export async function reconcileInvoices({redis,query,hs,now=new Date().toISOString()}){
 const prior=await redis.get(INVOICE_MONITOR_KEY);
 const [invoices,payments,customers,refunds,credits]=await Promise.all(['Invoice','Payment','Customer','RefundReceipt','CreditMemo'].map(t=>all(query,t)));
 const rows=[],customerRows=[],customerById=new Map(customers.map(c=>[String(c.Id),c]));
 const enabledAt=prior?.enabledAt||now;
 const overrideRaw=await redis.hgetall('commission:overrides')||{};
 const overrides=Object.fromEntries(Object.entries(overrideRaw).map(([k,v])=>[k,typeof v==='string'?JSON.parse(v):v]));
 const priorRows=new Map((prior?.invoices||[]).map(i=>[i.id,i]));
 for(const invoice of invoices){
  const e=invoiceEvidence(invoice,payments),c=customerById.get(String(invoice.CustomerRef?.value))||{};
  const old=priorRows.get(String(invoice.Id));
  const recentPayment=e.receipts.some(p=>p.date>=enabledAt.slice(0,10)&&Date.parse(p.updatedAt)>=Date.parse(enabledAt));
  const recentInvoice=Date.parse(invoice.MetaData?.CreateTime)>=Date.parse(enabledAt);
  rows.push({id:String(invoice.Id),number:invoice.DocNumber||invoice.Id,customerId:String(invoice.CustomerRef?.value||''),client:c.DisplayName||invoice.CustomerRef?.name||'',email:email(c.PrimaryEmailAddr?.Address),currency:invoice.CurrencyRef?.value||'USD',date:invoice.TxnDate,...e,firstSeenAt:old?.firstSeenAt||now,dealId:old?.dealId,convertedAt:old?.convertedAt,attemptedAt:old?.attemptedAt,
   status:old?.convertedAt?(e.fullyPaid?'closed_won':'payment_review'):!e.fullyPaid?(e.received>0?'part_paid':'awaiting_payment'):!e.placement?'revenue_only':!(recentInvoice||recentPayment)&&!old?.eligible?'historical_review':'ready',eligible:!!(old?.eligible||recentInvoice||recentPayment)});
 }
 // Persist the complete financial evidence before any CRM mutation, including unpaid invoices.
 const state={enabledAt,updatedAt:now,status:'complete',invoices:rows,clients:customerRows};
 await redis.set(INVOICE_MONITOR_KEY,state);
 const account=await hs('/account-info/v3/details');if(String(account.portalId)!=='51666712')throw Error('Invoice monitor refused wrong CRM portal');
 let count=0;const started=Date.now();
 for(const row of rows.filter(r=>['ready','review'].includes(r.status)).sort((a,b)=>(a.attemptedAt||'').localeCompare(b.attemptedAt||''))){
  if(++count>8||Date.now()-started>45000)break;
  row.attemptedAt=now;row.status='review';
  try{
   if(!row.email){row.reason='QuickBooks customer email is missing';continue;}
   if(customers.filter(c=>email(c.PrimaryEmailAddr?.Address)===row.email).length!==1){row.reason='Email belongs to multiple QuickBooks customers';continue;}
   if(refunds.concat(credits).some(r=>String(r.CustomerRef?.value)===row.customerId&&r.TxnDate>=row.date&&Number(r.TotalAmt)>0)){row.reason='Refund or credit requires allocation review';continue;}
   const contacts=await hs('/crm/v3/objects/contacts/search',{filterGroups:[{filters:[{propertyName:'email',operator:'EQ',value:row.email}]}],properties:['email'],limit:2});
   if(contacts.total!==1){row.reason='Exactly one CRM contact must match the invoice email';continue;}
   const contactId=contacts.results[0].id;
   const ass=await hs('/crm/v4/objects/contacts/'+contactId+'/associations/deals?limit=100');
   if(ass.paging?.next){row.reason='Deal associations need review';continue;}
   const ids=ass.results.map(a=>({id:String(a.toObjectId)}));
   const ds=ids.length?await hs('/crm/v3/objects/deals/batch/read',{inputs:ids,properties:['dealname','dealstage','pipeline','createdate','hubspot_owner_id','amount','closedate']}):{results:[]};
   const auditRaw=await redis.hget('finance:invoice-win-audit',row.id);
   const audit=typeof auditRaw==='string'?JSON.parse(auditRaw):auditRaw;
   const resume=audit&&ds.results.find(d=>String(d.id)===String(audit.dealId)&&d.properties.pipeline===PIPELINE&&String(overrides[d.id]?.invoiceId)===row.id);
   const result=resume?{deal:resume}:selectInvoiceDeal(ds.results,invoices.find(i=>String(i.Id)===row.id),overrides);
   if(!result.deal){row.reason=result.reason;continue;}
   const d=result.deal,oldOverride=overrides[d.id]||{};
   if(oldOverride.customerId&&oldOverride.customerId!==row.customerId){row.reason='Existing commission mapping has a different customer';continue;}
   const duplicate=Object.entries(overrides).find(([id,o])=>id!==d.id&&String(o.invoiceId)===row.id);
   if(duplicate){row.reason='Invoice already assigned to another commission record';continue;}
   // Durable audit first; a retry can complete the same write without duplicating a deal or payout.
   if(!audit)await redis.hset('finance:invoice-win-audit',{[row.id]:JSON.stringify({invoiceId:row.id,customerId:row.customerId,dealId:d.id,before:d.properties,paymentIds:row.receipts.map(p=>p.id),at:now})});
   await redis.hset('commission:overrides',{[d.id]:JSON.stringify({...oldOverride,customerId:row.customerId,invoiceId:row.id,paymentMatchedAt:now})});
   overrides[d.id]={...oldOverride,customerId:row.customerId,invoiceId:row.id};
   const paidDate=row.receipts.map(p=>p.date).sort().at(-1);
   const props={dealstage:WON,closedate:paidDate+'T12:00:00.000Z'};
   if(/\bdiscovery\s+call\b/i.test(d.properties.dealname||''))props.dealname=d.properties.dealname.replace(/\bdiscovery\s+call\b/ig,'Staffify VA');
   if(!(Number(d.properties.amount)>0))props.amount=String(row.placementAmount);
   await hs('/crm/v3/objects/deals/'+d.id,{properties:props},'PATCH');
   const check=await hs('/crm/v3/objects/deals/'+d.id+'?properties=dealstage');
   if(check.properties.dealstage!==WON)throw Error('Closed Won did not verify');
   await redis.hset('subscriber:'+row.email,{email:row.email,decision:'client',qb_customer_id:row.customerId,qb_invoice_id:row.id,paid_at:Date.parse(now)});
   row.dealId=d.id;row.convertedAt=now;row.status='closed_won';row.reason='Verified paid placement invoice';
  }catch(e){row.reason=String(e.message).slice(0,180);state.status='needs_attention';}
  finally{await redis.set(INVOICE_MONITOR_KEY,state);}
 }
 for(const c of customers){
  const inv=rows.filter(r=>r.customerId===String(c.Id));if(!inv.length)continue;
  const currencies=[...new Set(inv.map(i=>i.currency))];
  for(const currency of currencies){const items=inv.filter(i=>i.currency===currency);const rr=refunds.filter(r=>String(r.CustomerRef?.value)===String(c.Id)&&(r.CurrencyRef?.value||'USD')===currency);
   customerRows.push({id:String(c.Id),name:c.DisplayName,email:email(c.PrimaryEmailAddr?.Address),currency,invoiced:items.reduce((n,i)=>n+i.total,0),outstanding:items.reduce((n,i)=>n+i.balance,0),paymentsApplied:items.reduce((n,i)=>n+i.received,0),refunds:rr.reduce((n,r)=>n+Number(r.TotalAmt||0),0),invoices:items.length,firstInvoice:items.map(i=>i.date).sort()[0]});}
 }
 await redis.set(INVOICE_MONITOR_KEY,state);return state;
}
