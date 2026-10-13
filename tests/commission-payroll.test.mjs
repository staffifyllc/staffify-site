import test from 'node:test';import assert from 'node:assert/strict';import {applyPayrollGate,payrollThursday} from '../api/_commission-payroll.js';
const records=()=>[{customerId:'1',invoices:[{receipts:[{id:'p',amount:100}],placementEarned:30,residualEarned:5}]}];
const proof=date=>({p:{status:'cleared',evidenceRef:'bank:123',clearedDate:date,customerId:'1',amount:100}});
test('Friday billing cycle leads to Thursday payroll',()=>assert.equal(payrollThursday('2026-10-13'),'2026-10-15'));
test('recorded client payment without settlement earns no cash eligibility',()=>{const a=records();applyPayrollGate(a,{},'2026-10-13');assert.equal(a[0].placementCashEligible,0);assert.equal(a[0].invoices[0].payrollDate,null);});
test('Wednesday clearance qualifies; Thursday clearance rolls forward',()=>{const a=records();applyPayrollGate(a,proof('2026-10-14'),'2026-10-14');assert.equal(a[0].invoices[0].payrollDate,'2026-10-15');const b=records();applyPayrollGate(b,proof('2026-10-15'),'2026-10-15');assert.equal(b[0].invoices[0].payrollDate,'2026-10-29');});
test('wrong client settlement cannot qualify',()=>{const a=records(),p=proof('2026-10-19');p.p.customerId='2';applyPayrollGate(a,p,'2026-10-20');assert.equal(a[0].residualCashEligible,0);});
