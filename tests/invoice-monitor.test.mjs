import test from 'node:test';
import assert from 'node:assert/strict';
import {invoiceEvidence,selectInvoiceDeal,reconcileInvoices,INVOICE_MONITOR_KEY} from '../api/_invoice-monitor.js';
const invoice={Id:'i',DocNumber:'100',TxnDate:'2026-09-30',CustomerRef:{value:'c'},TotalAmt:2000,Balance:0,MetaData:{CreateTime:'2026-09-30T12:00:00Z'},Line:[{Amount:2000,SalesItemLineDetail:{ItemRef:{name:'VA Staffing'},Qty:1}}]};
const payment={Id:'p',CustomerRef:{value:'c'},TotalAmt:2000,TxnDate:'2026-09-30',MetaData:{LastUpdatedTime:'2026-09-30T12:00:00Z'},Line:[{Amount:2000,LinkedTxn:[{TxnType:'Invoice',TxnId:'i'}]}]};
const deal={id:'d',properties:{pipeline:'914670001',dealstage:'1390230874',dealname:'Agency staffing',createdate:'2026-09-29',hubspot_owner_id:'owner'}};
test('zero balance without money received cannot win; partial payment cannot win',()=>{
 assert.equal(invoiceEvidence(invoice,[]).fullyPaid,false);
 assert.equal(invoiceEvidence(invoice,[{...payment,Line:[{...payment.Line[0],Amount:500}]}]).fullyPaid,false);
 assert.equal(invoiceEvidence(invoice,[payment]).fullyPaid,true);
 assert.equal(invoiceEvidence(invoice,[{...payment,CustomerRef:{value:'other'}}]).fullyPaid,false);
});
test('ambiguous deals and existing clients cannot create another win',()=>{
 assert.ok(selectInvoiceDeal([deal,{...deal,id:'second'}],invoice).reason);
 assert.ok(selectInvoiceDeal([{...deal,properties:{...deal.properties,dealstage:'1390230875'}}],invoice).reason);
 assert.equal(selectInvoiceDeal([deal],invoice).deal.id,'d');
 assert.ok(selectInvoiceDeal([deal],invoice,{d:{invoiceId:'different'}}).reason);
 assert.ok(selectInvoiceDeal([deal],{...invoice,TxnDate:'2020-01-01'}).reason);
});
function fixture(){
 const store=new Map(),hashes=new Map();let patches=0;
 const redis={get:async k=>structuredClone(store.get(k)),set:async(k,v)=>store.set(k,structuredClone(v)),hgetall:async k=>hashes.get(k),hget:async(k,f)=>hashes.get(k)?.[f],hset:async(k,v)=>hashes.set(k,{...hashes.get(k),...v})};
 const data={Invoice:[invoice],Payment:[payment],Customer:[{Id:'c',DisplayName:'Agency',PrimaryEmailAddr:{Address:'owner@example.com'}}],RefundReceipt:[],CreditMemo:[]};
 const query=async sql=>({QueryResponse:{[sql.split(' ')[3]]:data[sql.split(' ')[3]]}});
 const hs=async(path,body,method)=>{
 if(path.includes('account-info'))return {portalId:51666712};
 if(path.includes('contacts/search'))return {total:1,results:[{id:'contact'}]};
 if(path.includes('associations/deals'))return {results:[{toObjectId:'d'}]};
 if(path.includes('batch/read'))return {results:[structuredClone(deal)]};
 if(method==='PATCH'){patches++;return {};}
 return {properties:{dealstage:'1390230875'}};
 };return {redis,query,hs,store,hashes,data,patches:()=>patches};
}
test('baseline records invoices without converting history',async()=>{
 const f=fixture();const s=await reconcileInvoices({...f,now:'2026-10-01T00:00:00Z'});
 assert.equal(f.patches(),0);assert.equal(s.invoices[0].status,'historical_review');assert.equal(s.clients[0].paymentsApplied,2000);
});
test('new paid invoice closes once, pins commission evidence and marks client',async()=>{
 const f=fixture();await f.redis.set(INVOICE_MONITOR_KEY,{enabledAt:'2026-09-29T00:00:00Z',invoices:[]});
 let s=await reconcileInvoices({...f,now:'2026-10-01T00:00:00Z'});
 assert.equal(s.invoices[0].status,'closed_won');assert.equal(f.patches(),1);
 assert.equal(f.hashes.get('subscriber:owner@example.com').decision,'client');
 assert.equal(JSON.parse(f.hashes.get('commission:overrides').d).invoiceId,'i');
 s=await reconcileInvoices({...f,now:'2026-10-01T01:00:00Z'});assert.equal(f.patches(),1);
});
test('refund holds close and wrong CRM portal fails',async()=>{
 const f=fixture();await f.redis.set(INVOICE_MONITOR_KEY,{enabledAt:'2026-09-29T00:00:00Z',invoices:[]});f.data.RefundReceipt=[{CustomerRef:{value:'c'},TxnDate:'2026-09-30',TotalAmt:100}];
 const s=await reconcileInvoices({...f,now:'2026-10-01T00:00:00Z'});assert.equal(f.patches(),0);assert.match(s.invoices[0].reason,/Refund/);
 await assert.rejects(reconcileInvoices({...f,hs:async()=>({portalId:123})}),/wrong CRM/);
});
