import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {financeAccess,financeMachine} from '../api/_finance-access.js';
test('financial access is restricted to verified Paul identities and Madison, never generic roles',()=>{for(const email of ['hello@gostaffify.com','paul@staffifyhq.com','madison@gostaffify.com'])assert.equal(financeAccess({email,role:'rep'}),true);for(const email of ['newhire@gostaffify.com','outsider@example.com','madison@staffifyhq.com'])assert.equal(financeAccess({email,role:'admin'}),false);assert.equal(financeAccess(null),false);});
test('machine financial access requires the scheduler bearer, never query identity or tokens',()=>{process.env.CRON_SECRET='test-only';assert.equal(financeMachine({headers:{authorization:'Bearer test-only'}}),true);assert.equal(financeMachine({headers:{},query:{token:'test-only',email:'hello@gostaffify.com'}}),false);delete process.env.CRON_SECRET;});
test('all financial routes enforce access before querying sources and do not trust open identity',()=>{for(const name of ['commissions','residuals','finance-snapshot']){const s=readFileSync(new URL('../api/'+name+'.js',import.meta.url),'utf8');assert.match(s,/financeAccess\(who\)/);assert.doesNotMatch(s,/await openIdentity/);assert.match(s,/403:401/);}});
// The commissions page carried its logic inline and a client-side ME.financeAccess flag. Both are
// gone: the logic moved to /assets/js/account-commissions.js on 2026-10-13 and the gate is the API
// refusal, which is the only one that was ever real. This asserts what protects the page now, and
// drives the refusal rather than matching a string that no longer exists.
test('the commissions page ships no figures of its own and renders the API refusal, not a ledger',async()=>{
 const page=readFileSync(new URL('../commissions/index.html',import.meta.url),'utf8');
 const body=page.slice(page.indexOf('<body'));
 assert.doesNotMatch(body,/<script>[\s\S]*?<\/script>/,'no inline finance logic');
 assert.match(body,/<script src="\/assets\/js\/account-commissions\.js"><\/script>/);
 assert.doesNotMatch(body,/placementEarned|residualEarned|commission[^s]/i,'no earnings baked into the markup');

 const src=readFileSync(new URL('../assets/js/account-commissions.js',import.meta.url),'utf8');
 const app={_html:'',get innerHTML(){return this._html;},set innerHTML(h){this._html=h;}};
 const doc={getElementById:id=>(id==='app'?app:null),querySelectorAll:()=>[],querySelector:()=>null};
 const refuse=async()=>({ok:false,status:403,headers:{get:()=>'application/json'},json:async()=>({error:'Private to Paul and Madison'})});
 new Function('window','document','fetch','setInterval',src)({},doc,refuse,()=>0);
 for(let i=0;i<12;i++)await Promise.resolve();
 assert.match(app.innerHTML,/Private to Paul and Madison/);
 assert.match(app.innerHTML,/href="\/hub\/"/,'it offers the sign-in instead of an empty ledger');
 assert.doesNotMatch(app.innerHTML,/commissions<\/h2>/,'no rep panel is drawn for a refused session');
});
import {onboardingAmount,invoicePayments} from '../api/_commission-evidence.js';
test('placement commissions exclude ordinary hours and subtract onboarding discounts',()=>{const line=(name,Amount)=>({Amount,SalesItemLineDetail:{ItemRef:{name}}});assert.equal(onboardingAmount({Line:[line('VA Staffing',2499),line('Hourly VA',5000),line('Action Taker Price',-500)]}),1999);assert.equal(onboardingAmount({Line:[line('Hourly VA',5000)]}),0);});
test('cash evidence is invoice-specific and ambiguous allocations are not guessed',()=>{assert.deepEqual(invoicePayments({Line:[{Amount:700,LinkedTxn:[{TxnType:'Invoice',TxnId:'a'}]},{Amount:300,LinkedTxn:[{TxnType:'Invoice',TxnId:'b'},{TxnType:'Invoice',TxnId:'c'}]}]}),[{invoiceId:'a',amount:700}]);});
test('anonymous requests cannot impersonate finance identities through any finance route',async()=>{process.env.KV_REST_API_URL='https://example.com';process.env.KV_REST_API_TOKEN='test';for(const name of ['commissions','residuals','finance-snapshot','finance-connection']){const handler=(await import('../api/'+name+'.js')).default;for(const email of ['hello@gostaffify.com','madison@gostaffify.com']){let code;const res={setHeader(){},status(n){code=n;return this;},json(v){return v;}};await handler({method:'GET',headers:{},query:{email,view:'admin',probe:'1'}},res);assert.equal(code,401,name);}}});

test('discovery placeholders cannot take placement invoice evidence',async()=>{const {commissionDeal}=await import('../api/_commission-evidence.js');assert.equal(commissionDeal({name:'John Reid - Discovery Call'}),false);assert.equal(commissionDeal({name:'John Reid - Staffify VA'}),true);});

test('actual invoice allocation preserves Madison placement ahead of discovery placeholder',async()=>{
 const {assignInvoices}=await import('../api/commissions.js');
 const q={connected:true,custById:{c:{}},custByName:{'john reid':'c'},byCust:{c:{invoices:[{id:'i',date:'2026-09-05',onboarding:2100}]}}};
 const a=assignInvoices([{dealId:'discovery',name:'John Reid - Discovery Call',company:'John Reid',closeDate:'2026-09-01'},{dealId:'placement',name:'John Reid - Staffify VA',company:'John Reid',closeDate:'2026-09-04'}],{},q);
 assert.equal(a.discovery,undefined);assert.equal(a.placement.inv.id,'i');
 const b=assignInvoices([{dealId:'new',company:'John Reid',closeDate:'2027-01-01'}],{},q);assert.equal(b.new.inv,null);
});

test('monthly revenue uses the accounting income total and never guesses zero',async()=>{
 const {reportIncome}=await import('../api/_finance-revenue.js');
 assert.equal(reportIncome({Header:{ReportBasis:'Accrual'},Rows:{Row:[{group:'Income',Summary:{ColData:[{value:'Income'},{value:'95720.98'}]}},{group:'NetIncome',Summary:{ColData:[{value:'Net Income'},{value:'100'}]}}]}}).amount,95720.98);
 assert.throws(()=>reportIncome({Rows:{Row:[]}}));
});
