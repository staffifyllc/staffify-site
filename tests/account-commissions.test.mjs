import test from 'node:test';import assert from 'node:assert/strict';import {accountLedger,billedHours} from '../api/_account-commissions.js';
const account={customerId:'1',rep:'paul',source:'self',since:'2026-09-29'};
const invoice={Id:'i',CustomerRef:{value:'1'},TxnDate:'2026-10-01',TotalAmt:200,Balance:0,Line:[{Id:'h',Amount:200,SalesItemLineDetail:{ItemRef:{name:'VA Hourly'},Qty:20,UnitPrice:10}}]};
const payment={Id:'p',CustomerRef:{value:'1'},TxnDate:'2026-10-02',TotalAmt:200,Line:[{Id:'h',Amount:200,LinkedTxn:[{TxnType:'Invoice',TxnId:'i'}]}]};
const run=(inv=invoice,pay=[payment],extra={})=>accountLedger({accounts:[account],invoices:[inv],payments:pay,hourMatches:{i:{h:20}},...extra})[0];
test('zero balance without payment cannot earn residual',()=>assert.equal(run(invoice,[]).residualEarned,0));
test('fully collected invoice earns exactly one dollar per billed hour',()=>assert.equal(run().residualEarned,20));
test('partial payment keeps all residual pending',()=>{const x=run({...invoice,Balance:100},[{...payment,TotalAmt:100,Line:[{Amount:100,LinkedTxn:[{TxnType:'Invoice',TxnId:'i'}]}]}]);assert.equal(x.residualEarned,0);assert.equal(x.residualPending,20);});
test('old and unrelated customer invoices excluded',()=>{assert.equal(run({...invoice,TxnDate:'2025-01-01'}).invoices.length,0);assert.equal(run({...invoice,CustomerRef:{value:'2'}}).invoices.length,0);});
test('placement quantities are not billed hours',()=>assert.equal(billedHours({...invoice,Line:[{Id:'h',Amount:200,SalesItemLineDetail:{ItemRef:{name:'VA Staffing'},Qty:1}}]}).hours,0));
test('refunds hold residuals',()=>assert.equal(run(invoice,[payment],{refunds:[{CustomerRef:{value:'1'},TxnDate:'2026-10-02',TotalAmt:20}]}).residualEarned,0));
import {matchServiceHours} from '../api/_account-commissions.js';
const service={...invoice,Line:[{Id:'l',Amount:200,Description:'Lorenz Miguel - John Reid (Fri, Oct 2, 2026)',SalesItemLineDetail:{ItemRef:{name:'Services'},Qty:1}}]};
const hours={connected:true,clients:[{projectId:10,name:'John Reid',byDay:{'2026-10-02':7200},byDayUsers:{'2026-10-02':[11]}}]};
test('service line matches unique account/project/day hours, never qty one',()=>{const a={...account,name:'John Reid'};const matches=matchServiceHours([a],[service],hours);assert.equal(matches.i.l,2);assert.equal(accountLedger({accounts:[a],invoices:[service],payments:[payment],hourMatches:matches})[0].residualEarned,2);});
test('same day in two invoices cannot double pay',()=>assert.deepEqual(matchServiceHours([{...account,name:'John Reid'}],[service,{...service,Id:'second'}],hours),{}));
test('multiple staff on same project day require explicit evidence',()=>assert.deepEqual(matchServiceHours([{...account,name:'John Reid'}],[service],{...hours,clients:[{...hours.clients[0],byDayUsers:{'2026-10-02':[11,12]}}]}),{}));

test("invoice hourly quantities alone never establish Hubstaff hours",()=>assert.equal(run(invoice,[payment],{hourMatches:{}}).residualEarned,0));
