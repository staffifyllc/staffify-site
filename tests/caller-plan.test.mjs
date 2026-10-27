import test from 'node:test';
import assert from 'node:assert/strict';
import {callerPlan, planSummary, ELIGIBILITY, emailMismatch, CALLER_PLANS, CALLER_HANDLES, callerPlanByHandle} from '../api/_caller-plan.js';

// Source: Staffify_Agreement_Milton_Signed.pdf, signed 2026-10-20. Section 15 supersedes earlier
// proposals including "different base compensation amounts", so anything relayed verbally loses.
const CONTRACT='milton@trystaffify.com';

test('the figures are the signed ones, not the ones relayed beforehand',()=>{
 const p=callerPlan(CONTRACT);
 assert.equal(p.weeklyBase,200,'5.1: $200 a week');
 assert.equal(p.biweeklyBase,400,'5.1: $400 biweekly');
 assert.equal(p.onboardingCommission,400,'5.2: flat $400 per collected onboarding fee');
 assert.equal(p.weeklyHours,20);
 // The superseded numbers must not survive anywhere in the plan.
 const values=Object.values(p).filter(v=>typeof v==='number');
 for(const wrong of [160,320,650]) assert.ok(!values.includes(wrong),`${wrong} is superseded and must not appear`);
});

test('the trial runs the dates the agreement sets',()=>{
 const p=callerPlan(CONTRACT);
 assert.equal(p.trialStart,'2026-10-20','1: services begin October 20');
 assert.equal(p.trialEnd,'2026-11-18','1: 30-day trial ends November 18');
 assert.match(p.schedule,/UTC-5/);
 assert.ok(!/daylight/i.test(p.schedule));
});

test('no residuals, no appointment fee, no cap',()=>{
 const p=callerPlan(CONTRACT);
 assert.equal(p.residualPerHour,0,'5.4: no residuals during the trial');
 assert.equal(p.appointmentFee,0,'5.4: no separate appointment fee');
 assert.equal(p.commissionCapped,false,'5.2: no cap');
 assert.equal(p.mustClosePersonally,false,'5.2: need not close personally');
});

test('what the agreement leaves open stays open',()=>{
 const p=callerPlan(CONTRACT);
 assert.equal(p.firstPayday,null,'5.3: calendar provided before services begin');
 assert.equal(p.payrollCutoff,null);
 assert.equal(planSummary(p).paydayKnown,false);
});

test('the provisioned login resolves, and the mismatch is reported not hidden',()=>{
 // Section 14 names milton@; the Hub account was created as "miltion".
 assert.ok(callerPlan('miltion@trystaffify.com'),'he can still see his own pay');
 assert.ok(callerPlan('Milton@TryStaffify.com'),'case insensitive');
 const m=emailMismatch('miltion@trystaffify.com');
 assert.equal(m.onContract,CONTRACT);
 assert.equal(emailMismatch(CONTRACT),null,'no mismatch when signed in as the contract address');
 assert.equal(callerPlan('someone@else.com'),null);
});

test('eligibility states that collection, not signature, earns the fee',()=>{
 const all=ELIGIBILITY.join(' ').toLowerCase();
 assert.ok(/cleared funds/.test(all),'5.2: in full, in cleared funds');
 assert.ok(/does not create a payable commission/.test(all),'a signed agreement alone earns nothing');
 assert.ok(/instalments toward one fee/.test(all),'5.2: instalments are one commission');
 assert.ok(/hubspot/.test(all),'6: HubSpot is the attribution record');
});

test('the post-trial attribution window is the contractual 90 days',()=>{
 assert.equal(callerPlan(CONTRACT).postTrialAttributionDays,90);
});

test('the plan carries the ledger handle that ties it to the QBO evidence', () => {
 // Without this, his commission has no way to reach either screen: the finance ledger attributes a
 // client account to a rep handle, and nothing matched him.
 const plan = CALLER_PLANS['milton@trystaffify.com'];
 assert.equal(plan.handle, 'milton');
 assert.equal(callerPlanByHandle('milton'), plan);
 assert.equal(callerPlanByHandle('Milton'), plan);
 assert.equal(callerPlanByHandle('paul'), null, 'a percentage rep has no trial plan');
 assert.deepEqual(CALLER_HANDLES, ['milton']);
});

test('an owner reading a card sees the caller who works it, never "[your name]" where one is assigned', async () => {
    const { cardCallerName } = await import('../api/_caller-plan.js');
    // Paul, 2026-10-27, in his own view of the dialer: "Hey Nolan, this is [your name] with Staffify."
    assert.equal(cardCallerName({ campaignId: 'staffify-tobit-outreach' }, 'Paul Chareth'), 'Milton', 'the Spearhead list is his');
    assert.equal(cardCallerName({ campaignId: 'staffify-agency-outreach' }, 'Paul Chareth'), 'Paul', 'the shared queue: whoever reads it is the one calling');
    assert.equal(cardCallerName({ campaignId: 'staffify-agency-outreach', callOwner: 'miltion@trystaffify.com' }, 'Paul'), 'Paul');
    assert.equal(cardCallerName({ campaignId: 'staffify-talent-network-outreach' }, ''), null, 'nothing known: the placeholder stays');
    assert.equal(cardCallerName(null, null), null);
});
