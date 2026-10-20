// The owner commissions screen, actually rendered, with a third rep on a flat plan.
// ------------------------------------------------------------------
// Paul, 2026-10-20: "still not seeing his commissions pull up at all". The screen had two reps
// hardcoded into the view selector, the panel list and the assignment form, so a third one could
// not be selected, could not be assigned and never drew. A source-text assertion would not catch
// a regression here: the panels are built inside one expression. This drives the real render.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const SRC=readFileSync(new URL('../assets/js/account-commissions.js',import.meta.url),'utf8');

// Enough of a DOM for one render pass: the page writes one innerHTML and then looks up controls.
async function harness(payload,{callerOk=false,callerBody=null}={}){
 const nodes={};
 const stub=id=>(nodes[id]=nodes[id]||{id,value:'',textContent:'',onclick:null,onchange:null,
  elements:{since:{value:''},customerId:{value:''},rep:{value:''},source:{value:''}},
  _html:'',get innerHTML(){return this._html;},set innerHTML(h){this._html=h;},
  open:false,querySelectorAll:()=>[],scrollIntoView(){}});
 const app=stub('app');
 const doc={getElementById:id=>(id==='app'?app:stub(id)),querySelectorAll:()=>[],querySelector:()=>null};
 const win={};
 const fetches=[];
 const fetch=async(url)=>{
  fetches.push(String(url));
  if(String(url).includes('my-commissions'))
   return {ok:callerOk,headers:{get:()=>'application/json'},json:async()=>callerBody};
  return {ok:true,headers:{get:()=>'application/json'},json:async()=>payload};
 };
 const run=new Function('window','document','fetch','setInterval','URL','Blob',SRC);
 run(win,doc,fetch,()=>0,{createObjectURL:()=>'blob:x',revokeObjectURL(){}},class{});
 // The page fetches before it draws, so let the promise chain settle before reading the markup.
 for(let i=0;i<12;i++)await Promise.resolve();
 return {app,nodes,fetches};
}

const PLANS={milton:{name:'Milton',onboardingCommission:400,weeklyBase:200,biweeklyBase:400,
 weeklyHours:20,trialStart:'2026-10-20',trialEnd:'2026-11-18',
 source:'Sales Representative Services Agreement, signed 2026-10-20',capped:false,residualPerHour:0}};

const ownerPayload=(accounts=[])=>({
 updatedAt:new Date().toISOString(),stale:false,canEdit:true,viewer:'paul',plans:PLANS,
 accounts,customers:[{id:'900',name:'Acme Media'}],missing:[],hubstaffConnected:true,
 payroll:{nextPayroll:'2026-10-29',cutoff:'Wednesday 11:59 PM America/New_York',cadenceDays:14},
 talent:{connected:false,prompts:[]},
});
const miltonAccount=(over={})=>({customerId:'900',name:'Acme Media',contactName:'',rep:'milton',
 source:'',since:'2026-10-20',collected:2499,incoming:0,trackedHours:null,unlinkedHours:null,
 placementEarned:400,placementPending:0,residualEarned:0,residualPending:0,
 placementCashEligible:0,residualCashEligible:0,
 invoices:[{id:'1',number:'INV-1',date:'2026-10-22',currency:'USD',total:2499,balance:0,collected:2499,
  receipts:[{id:'10',date:'2026-10-23',amount:2499}],hours:0,hoursReview:false,rate:null,flatFee:400,
  holds:[],status:'Paid',placementEarned:400,placementPending:0,residualEarned:0,residualPending:0,
  cashStatus:'Awaiting settlement verification',payrollDate:null,lines:[]}],...over});

test('the view selector offers the flat rep, so Paul can actually look at him', async () => {
 const {app}=await harness(ownerPayload([miltonAccount()]));
 assert.match(app.innerHTML,/<option value="milton">Milton only<\/option>/);
 assert.match(app.innerHTML,/<option value="paul">Paul only<\/option>/);
 // The shared option used to name two reps while silently including a third.
 assert.match(app.innerHTML,/<option value="all">Shared \u00b7 Paul, Madison &amp; Milton<\/option>/);
});

test('the owner opens on the whole team, which is how a third rep gets seen at all', async () => {
 const {nodes}=await harness(ownerPayload([miltonAccount()]));
 assert.equal(nodes.owner.value,'all','Paul landed on Paul only and reported Milton missing');
});

test('a rep who cannot edit still opens on their own figures', async () => {
 const {nodes}=await harness({...ownerPayload([miltonAccount()]),canEdit:false,viewer:'madison'});
 assert.equal(nodes.owner.value,'madison');
});

test('his panel draws with the signed flat terms and no percentage', async () => {
 const {app}=await harness(ownerPayload([miltonAccount()]));
 const panel=app.innerHTML.split('Milton’s commissions')[1].split('</section>')[0];
 assert.match(panel,/\$400\.00 for every onboarding fee Staffify collects in full/);
 assert.match(panel,/with no cap/);
 assert.match(panel,/Base pay of \$200\.00 a week for 20 hours/);
 assert.doesNotMatch(panel,/30%|20%|35%/,'no percentage ladder is shown to a flat rep');
 assert.doesNotMatch(panel,/per Hubstaff hour/,'and no residual he cannot earn');
 assert.match(panel,/Commission on collected fees/);
 assert.match(panel,/\$400\.00<\/b><span>Base pay per two weeks/);
 assert.match(panel,/Trial 2026-10-20 to 2026-11-18/);
});

test('with no account attributed yet, the zero explains itself instead of looking broken', async () => {
 const {app}=await harness(ownerPayload([]));
 const panel=app.innerHTML.split('Milton’s commissions')[1].split('</section>')[0];
 assert.match(panel,/No client account is attributed to Milton yet/);
 assert.match(panel,/Assign the account under Assign a client account/);
});

test('the assignment form can put a client on him, which is the only way a fee reaches him', async () => {
 const {app}=await harness(ownerPayload([miltonAccount()]));
 const form=app.innerHTML.split('name="rep"')[1].split('</select>')[0];
 assert.match(form,/<option value="milton">Milton<\/option>/);
});

test('his client card names the flat plan rather than a missing lead source', async () => {
 const {app}=await harness(ownerPayload([miltonAccount()]));
 assert.match(app.innerHTML,/Milton · Flat fee per collected onboarding fee/);
 assert.doesNotMatch(app.innerHTML,/Milton · Lead source not recorded/);
 assert.match(app.innerHTML,/flat \$400\.00 once this fee is collected in full/);
});

test('the percentage reps keep their own terms on the same screen', async () => {
 const {app}=await harness(ownerPayload([miltonAccount()]));
 const paul=app.innerHTML.split('Paul’s commissions')[1].split('</section>')[0];
 assert.match(paul,/All leads: 30%/);
 assert.match(paul,/Residual: \$1 per Hubstaff hour/);
 const madison=app.innerHTML.split('Madison’s commissions')[1].split('</section>')[0];
 assert.match(madison,/Business-generated: 20%\. Self-generated: 30%\./);
});

test('the caller view renders his own pay from the ledger, in dollars, not a row count', async () => {
 const {app}=await harness(null,{callerOk:true,callerBody:{
  name:'Milton',
  plan:{name:'Milton',weeklyBase:200,biweeklyBase:400,onboardingCommission:400,
   trialStart:'2026-10-20',trialEnd:'2026-11-18',schedule:'Monday to Friday, 4:00pm to 8:00pm EST',
   firstPayday:null,payrollCutoff:null,eligibility:['Collection, not signature, earns the fee.']},
  ledger:{readable:true,updatedAt:new Date().toISOString(),accounts:1},
  credited:[{client:'Acme Media',invoice:'INV-1',date:'2026-10-22',status:'cleared',amount:400,
   awaiting:0,collection:'Paid',funds:'Funds cleared',earliestPayroll:'2026-10-29',holds:[]}],
  totals:{commissionCleared:400,awaitingCollection:0,clearedForPayroll:400,baseWeekly:200,baseBiweekly:400},
  notes:['Eligible commission is not proof of payout. Payroll confirms every payment.'],
 }});
 assert.match(app.innerHTML,/Your pay/);
 assert.match(app.innerHTML,/Acme Media/);
 assert.match(app.innerHTML,/Funds cleared/);
 assert.match(app.innerHTML,/Commission on collected fees: <strong>\$400<\/strong>/);
 assert.match(app.innerHTML,/\$400 cleared and ready for payroll review/);
 assert.doesNotMatch(app.innerHTML,/undefined|NaN/);
});

test('a client name carrying markup is escaped, not rendered', async () => {
 const {app}=await harness(null,{callerOk:true,callerBody:{
  name:'Milton',
  plan:{name:'Milton',weeklyBase:200,biweeklyBase:400,onboardingCommission:400,trialStart:'2026-10-20',
   trialEnd:'2026-11-18',schedule:'x',firstPayday:null,payrollCutoff:null,eligibility:[]},
  ledger:{readable:true,updatedAt:null,accounts:1},
  credited:[{client:'<img src=x onerror=alert(1)>',invoice:'1',date:'2026-10-22',status:'cleared',
   amount:400,awaiting:0,collection:'Paid',funds:'Funds cleared',earliestPayroll:null,holds:[]}],
  totals:{commissionCleared:400,awaitingCollection:0,clearedForPayroll:0},notes:[],
 }});
 assert.doesNotMatch(app.innerHTML,/<img src=x/);
 assert.match(app.innerHTML,/&lt;img src=x/);
});
