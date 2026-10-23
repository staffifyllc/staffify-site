// Milton's pay is a FLAT fee per collected onboarding fee, not a share of one.
// ------------------------------------------------------------------
// Source: Sales Representative Services Agreement, signed 2026-10-20, section 5.2. The risk this
// guards against is the obvious one: he is a third rep on the same ledger as two percentage reps,
// and the quiet failure is his fee silently becoming 30% of something.
import test from 'node:test';
import assert from 'node:assert/strict';
import {accountLedger} from '../api/_account-commissions.js';
import {CALLER_PLANS,flatOnboardingCommission} from '../api/_caller-plan.js';

const FLAT=CALLER_PLANS['milton@trystaffify.com'].onboardingCommission;
const SINCE='2026-10-20';

const invoice=(id,customerId,amount,{date='2026-10-22',balance=0,qty=1,hours=0}={})=>({
 Id:String(id),DocNumber:'INV-'+id,TxnDate:date,CustomerRef:{value:String(customerId)},
 TotalAmt:amount+hours,Balance:balance,CurrencyRef:{value:'USD'},
 Line:[{Id:'L'+id,Amount:amount,DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{name:'VA Staffing'},Qty:qty}},
  ...(hours?[{Id:'H'+id,Amount:hours,DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{name:'VA Hours'},Qty:hours},Description:'Ana Cruz - Acme (Mon, Oct 27, 2026)'}]:[])],
});
const payment=(id,customerId,invoiceId,amount,date='2026-10-23')=>({
 Id:String(id),TxnDate:date,CustomerRef:{value:String(customerId)},TotalAmt:amount,
 PaymentMethodRef:{name:'Check'},
 Line:[{Amount:amount,LinkedTxn:[{TxnType:'Invoice',TxnId:String(invoiceId)}]}],
});
const run=(accounts,invoices,payments,hourMatches={})=>accountLedger({accounts,invoices,payments,hourMatches});
const milton=(customerId='900',source='')=>({customerId,name:'Acme Media',rep:'milton',source,since:SINCE});

test('a collected onboarding fee earns the flat contract fee, not a percentage of it', () => {
 const [a]=run([milton()],[invoice(1,900,2499)],[payment(10,900,1,2499)]);
 assert.equal(a.placementEarned,FLAT);
 assert.notEqual(a.placementEarned,2499*0.3);
 assert.equal(a.invoices[0].rate,null,'no percentage rate is asserted for a flat plan');
 assert.equal(a.invoices[0].flatFee,FLAT);
 assert.deepEqual(a.invoices[0].holds,[],'a flat plan is never held for a lead-source choice');
});

test('the size of the fee does not change the commission', () => {
 const small=run([milton()],[invoice(1,900,900)],[payment(10,900,1,900)])[0];
 const large=run([milton()],[invoice(2,900,25000)],[payment(11,900,2,25000)])[0];
 assert.equal(small.placementEarned,FLAT);
 assert.equal(large.placementEarned,FLAT);
});

test('instalments toward one fee do not pay until the fee is collected in full, and never twice', () => {
 const part=run([milton()],[invoice(1,900,2499,{balance:1249.5})],[payment(10,900,1,1249.5)])[0];
 assert.equal(part.placementEarned,0,'half collected is not collected');
 assert.equal(part.placementPending,FLAT,'one fee, one pending commission');
 const whole=run([milton()],[invoice(1,900,2499)],[payment(10,900,1,1249.5),payment(11,900,1,1249.5,'2026-10-30')])[0];
 assert.equal(whole.placementEarned,FLAT,'two instalments settle one fee');
 assert.equal(whole.placementPending,0);
});

test('every separate fee earns its own commission and nothing caps the total', () => {
 const [a]=run([milton()],[invoice(1,900,2499),invoice(2,900,1999,{date:'2026-10-24'}),
  invoice(3,900,1999,{date:'2026-10-25'}),invoice(4,900,1999,{date:'2026-10-26'}),invoice(5,900,1999,{date:'2026-10-27'})],
  [payment(10,900,1,2499),payment(11,900,2,1999),payment(12,900,3,1999),payment(13,900,4,1999),payment(14,900,5,1999)]);
 assert.equal(a.placementEarned,FLAT*5,'no cap, and the fifth placement is not escalated to 35%');
 assert.ok(a.invoices.every(i=>i.rate===null&&i.placementEarned===FLAT));
});

test('hours on his accounts earn him no residual during the trial', () => {
 const [a]=run([milton()],[invoice(1,900,2499,{hours:40})],[payment(10,900,1,2539)],{1:{H1:40}});
 assert.equal(a.residualEarned,0);
 assert.equal(a.residualPending,0);
 assert.equal(a.placementEarned,FLAT,'the onboarding fee still pays');
});

test('a fee on an invoice still owed is pending, never earned', () => {
 const [a]=run([milton()],[invoice(1,900,2499,{balance:2499})],[]);
 assert.equal(a.placementEarned,0);
 assert.equal(a.placementPending,FLAT);
 assert.equal(a.invoices[0].status,'Awaiting payment');
});

test('the percentage reps are untouched by the flat branch', () => {
 const paul=run([{customerId:'901',name:'Evan Ulsh',rep:'paul',source:'self',since:SINCE}],[invoice(1,901,2000)],[payment(10,901,1,2000)])[0];
 assert.equal(paul.invoices[0].rate,30);
 assert.equal(paul.placementEarned,600);
 const madison=run([{customerId:'902',name:'John Reid',rep:'madison',source:'house',since:SINCE}],[invoice(2,902,2000)],[payment(11,902,2,2000)])[0];
 assert.equal(madison.invoices[0].rate,20);
 assert.equal(madison.placementEarned,400);
 assert.equal(madison.invoices[0].flatFee,null,'a percentage rep carries no flat fee');
});

test('only a handle with a signed plan reads as flat', () => {
 assert.equal(flatOnboardingCommission('milton'),FLAT);
 assert.equal(flatOnboardingCommission('paul'),null);
 assert.equal(flatOnboardingCommission('madison'),null);
 assert.equal(flatOnboardingCommission(''),null);
 assert.equal(flatOnboardingCommission(undefined),null);
});

// ------------------------------------------------------------------
// Paul, 2026-10-22: "commission also for folks from People who met us and did not buy should be a
// flat $200." A lead source on the account, whoever re-closes it.
import { LOST_DEAL_FEE, LOST_DEAL_SOURCE } from '../api/_account-commissions.js';

const lostDeal = (rep, over = {}) => ({ customerId: '950', name: 'Back From The Dead Co', rep, source: LOST_DEAL_SOURCE, since: SINCE, ...over });

test('a re-engaged lost deal pays a flat $200, not a percentage, whoever closes it', () => {
    assert.equal(LOST_DEAL_FEE, 200);
    for (const rep of ['madison', 'paul', 'milton']) {
        const [a] = run([lostDeal(rep)], [invoice(1, 950, 2499)], [payment(10, 950, 1, 2499)]);
        assert.equal(a.placementEarned, 200, rep);
        assert.equal(a.invoices[0].rate, null, rep + ' is not paid a rate');
        assert.equal(a.invoices[0].flatFee, 200, rep);
    }
});

test('the $200 is owed only once the fee is collected in full, like every flat fee', () => {
    const [part] = run([lostDeal('madison')], [invoice(1, 950, 2499, { balance: 1249.5 })], [payment(10, 950, 1, 1249.5)]);
    assert.equal(part.placementEarned, 0);
    assert.equal(part.placementPending, 200);
});

test('re-engaging a lost deal changes the commission, never a residual somebody is owed', () => {
    // Madison earns $1 per Hubstaff hour. Paul set a flat commission, not a cut to her residuals.
    const [madison] = run([lostDeal('madison')], [invoice(1, 950, 2499, { hours: 40 })], [payment(10, 950, 1, 2539)], { 1: { H1: 40 } });
    assert.equal(madison.placementEarned, 200);
    assert.equal(madison.residualEarned, 40, 'her residuals are untouched');
    // Milton's trial plan pays no residuals at all (5.4), and that is still true on a lost deal.
    const [milton] = run([lostDeal('milton')], [invoice(1, 950, 2499, { hours: 40 })], [payment(10, 950, 1, 2539)], { 1: { H1: 40 } });
    assert.equal(milton.residualEarned, 0);
});

test('a normal account is untouched by the new source', () => {
    const [house] = run([{ customerId: '902', name: 'John Reid', rep: 'madison', source: 'house', since: SINCE }], [invoice(2, 902, 2000)], [payment(11, 902, 2, 2000)]);
    assert.equal(house.invoices[0].rate, 20);
    assert.equal(house.placementEarned, 400);
    const [milton] = run([milton_()], [invoice(3, 900, 2499)], [payment(12, 900, 3, 2499)]);
    assert.equal(milton.placementEarned, 400, 'his sourced deals still pay the contract $400');
});
function milton_() { return { customerId: '900', name: 'Acme Media', rep: 'milton', source: '', since: SINCE }; }
