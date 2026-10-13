// QBO applied payments establish collection; only separately verified settlement establishes cleared cash.
import {PAY_ANCHOR} from './_payperiods.js';
const DAY=86400000;
export function payrollThursday(day){
 const anchor=Date.parse(PAY_ANCHOR+'T00:00:00Z')+6*DAY; // Friday billing cycle, payroll the following Thursday after clearance.
 const date=Date.parse(day+'T00:00:00Z');
 return new Date(anchor+Math.ceil((date-anchor)/(14*DAY))*14*DAY).toISOString().slice(0,10);
}
export function applyPayrollGate(accounts,clearances={},today){
 const nextPayroll=payrollThursday(today);
 for(const a of accounts){
  a.placementCashEligible=0;a.residualCashEligible=0;
  for(const i of a.invoices){
   const proofs=i.receipts.map(r=>clearances[r.id]);
   const cleared=i.receipts.length>0&&proofs.every((p,n)=>p?.status==='cleared'&&p?.evidenceRef&&/^\d{4}-\d{2}-\d{2}$/.test(p.clearedDate||'')&&p.customerId===a.customerId&&Number(p.amount)>=Number(i.receipts[n].amount));
   i.cashStatus=cleared?'Funds cleared':i.receipts.length?'Awaiting settlement verification':'Awaiting client payment';
   i.payrollDate=null;i.placementCashEligible=0;i.residualCashEligible=0;
   if(cleared){
    const latest=proofs.map(p=>p.clearedDate).sort().at(-1);
    // Thursday receipts miss Wednesday cutoff, so use strictly following payroll Thursday.
    const afterClearance=new Date(Date.parse(latest+'T00:00:00Z')+DAY).toISOString().slice(0,10);
    i.payrollDate=payrollThursday(afterClearance>today?afterClearance:today);
    i.placementCashEligible=i.placementEarned;i.residualCashEligible=i.residualEarned;
   }
   a.placementCashEligible+=i.placementCashEligible;a.residualCashEligible+=i.residualCashEligible;
  }
 }
 return {cadenceDays:14,nextPayroll,cutoff:'Wednesday 11:59 PM America/New_York',settlementRequired:true,automaticBankPayouts:false};
}
