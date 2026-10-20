import test from 'node:test';
import assert from 'node:assert/strict';
import {industryFor} from '../api/_industry.js';

test('the agency campaign is definitional, no guessing required',()=>{
 const i=industryFor({campaignId:'staffify-agency-outreach',company:'Picture KC'});
 assert.equal(i.label,'Real estate media');
 assert.equal(i.source,'campaign');
});

test('a filled-in CRM industry beats anything inferred from prose',()=>{
 const i=industryFor({campaignId:'staffify-tobit-outreach',company:'Forcepoint',crmIndustry:'Computer & Network Security',excerpt:'we build houses'});
 assert.equal(i.key,'software');
 assert.equal(i.source,'CRM');
});

test('a CRM value we have no mapping for is still used, not discarded',()=>{
 const i=industryFor({campaignId:'staffify-tobit-outreach',company:'X',crmIndustry:'Wine & Spirits'});
 assert.equal(i.label,'Wine & Spirits');
 assert.equal(i.source,'CRM');
});

test('it reads the real research when the CRM is blank',()=>{
 const cases=[
  ['Arch-Con Corporation','a general contractor delivering design-build projects','construction'],
  ['Jefferson Bank','community banking and lending for local businesses','finance'],
  ['Rubrik, Inc.','a cloud platform for data security and recovery','software'],
  ['Frontline Education','k-12 software for school administrators','education'],
  ['Vivent Health','patient care and clinic services','health'],
  ['AOG Living','property management across multifamily communities','property'],
 ];
 for(const [company,excerpt,key] of cases){
  const i=industryFor({campaignId:'staffify-tobit-outreach',company,excerpt});
  assert.ok(i,`${company} should classify`);
  assert.equal(i.key,key,`${company} -> ${i.key}, expected ${key}`);
  assert.equal(i.source,'research');
 }
});

test('no signal means NO tag, never a guess',()=>{
 assert.equal(industryFor({campaignId:'staffify-tobit-outreach',company:'T. Kerr Group',excerpt:''}),null);
 assert.equal(industryFor({}),null);
});
