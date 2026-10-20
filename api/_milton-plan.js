// Separate trial policy. Never reuse the owners' percentage/residual plans.
export const MILTON_EMAIL = 'miltion@trystaffify.com';
export const miltonIdentity = rep => rep?.email?.toLowerCase() === MILTON_EMAIL;
export const MILTON_PLAN = Object.freeze({weeklyBase:160,biweeklyBase:320,onboardingCommission:650,residualPerHour:0,start:'2026-10-26',end:'2026-11-24',schedule:'Monday–Friday, 4–8 PM fixed EST (UTC−5)',firstPayday:null,payrollCutoff:null});
export function miltonCommission(record, invoice, clearances={}, fresh=false) {
 let status='Awaiting invoice match';
 if(invoice && String(invoice.customerId)===String(record.customerId)) {
  status=!fresh?'Payment data needs refresh':!invoice.fullyPaid?'Awaiting full client payment':'Awaiting cleared funds';
  const proofs=(invoice.receipts||[]).map(p=>clearances[p.id]);
  const cleared=proofs.length>0&&proofs.every((p,i)=>p?.status==='cleared'&&p.evidenceRef&&/^\d{4}-\d{2}-\d{2}$/.test(p.clearedDate||'')&&p.customerId===record.customerId&&Number(p.amount)>=Number(invoice.receipts[i].amount));
  if(fresh&&invoice.fullyPaid&&invoice.currency==='USD'&&cleared)status='Eligible for payroll review';
 }
 return {id:record.id,client:record.client,invoiceId:record.invoiceId,status,commission:status==='Eligible for payroll review'?650:0,potentialCommission:650};
}
