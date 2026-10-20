import test from 'node:test';
import assert from 'node:assert/strict';
import {callerPlan, planSummary, ELIGIBILITY} from '../api/_caller-plan.js';

const MILTON='miltion@trystaffify.com';

test('the plan matches the terms Paul confirmed, exactly',()=>{
 const p=callerPlan(MILTON);
 assert.equal(p.weeklyBase,160);
 assert.equal(p.biweeklyBase,320);
 assert.equal(p.onboardingCommission,650);
 assert.equal(p.residualPerHour,0,'no trial residuals');
 assert.equal(p.trialStart,'2026-10-26');
 assert.equal(p.trialEnd,'2026-11-24');
 assert.match(p.schedule,/UTC-5/);
 assert.ok(!/eastern/i.test(p.schedule),'fixed offset, not daylight-shifting Eastern');
});

test('the dates Paul left open stay open, never invented',()=>{
 const p=callerPlan(MILTON);
 assert.equal(p.firstPayday,null);
 assert.equal(p.payrollCutoff,null);
 assert.equal(planSummary(p).paydayKnown,false);
});

test('the address is the one provisioned, and case does not matter',()=>{
 assert.ok(callerPlan('Miltion@TryStaffify.com'),'case insensitive');
 // The deliberate misspelling is the real login; the obvious spelling is not.
 assert.equal(callerPlan('milton@trystaffify.com'),null);
 for(const e of ['hello@gostaffify.com','madison@gostaffify.com','',null]) assert.equal(callerPlan(e),null);
});

test('the gap between calling and the written trial is surfaced, not resolved',()=>{
 const p=callerPlan(MILTON);
 const during=planSummary(p,new Date('2026-10-22T12:00:00Z'));
 assert.equal(during.callingBeforeTrial,true,'flagged in the six day gap');
 assert.equal(during.started,false,'the written trial has not opened');
 const after=planSummary(p,new Date('2026-10-28T12:00:00Z'));
 assert.equal(after.callingBeforeTrial,false);
 assert.equal(after.started,true);
});

test('the bar for a fee is stated, including the upfront rule',()=>{
 const all=ELIGIBILITY.join(' ').toLowerCase();
 assert.ok(/cleared/.test(all),'funds must clear');
 assert.ok(/separate/.test(all),'one fee, one commission');
 assert.ok(/no financing|instalments|discounts/.test(all),'the upfront rule');
});
