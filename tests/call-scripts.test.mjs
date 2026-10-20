import test from 'node:test';
import assert from 'node:assert/strict';
import {callScript} from '../api/_call-scripts.js';

const MEDIA='staffify-agency-outreach', TOBIT='staffify-tobit-outreach', TALENT='staffify-talent-network-outreach';
const make=id=>callScript({campaignId:id,caller:'Milton',company:'Picture KC',firstName:'Joel'});
const spoken=s=>[s.opener,...s.questions,s.voicemail,...s.objections.map(o=>o.say)].join(' ').toLowerCase();

test('QC and revisions language is fenced to media agency owners',()=>{
 const media=spoken(make(MEDIA));
 assert.ok(media.includes('qc')&&media.includes('revisions'),'media script asks about QC and revisions');
 assert.ok(media.includes('editing turnaround'),'media script names their actual work');
 for(const id of [TOBIT,TALENT]){
  const other=spoken(make(id));
  for(const word of ['qc','revisions','editing turnaround','gallery']) assert.ok(!other.includes(word),`${id} must not say "${word}"`);
 }
});

test('the talent network script never references a resume, applicant or vacancy',()=>{
 const s=spoken(make(TALENT));
 for(const word of ['resume','applicant','candidate','vacancy','job posting']) assert.ok(!s.includes(word),`talent script must not say "${word}"`);
});

test('every campaign opens the same way, names the company and offers an exit',()=>{
 for(const id of [MEDIA,TOBIT,TALENT]){
  const s=make(id);
  assert.ok(s.opener.startsWith('Hi Joel,'),'uses the first name');
  assert.ok(s.opener.includes('Picture KC'),'names the company');
  assert.ok(s.opener.includes('cold call'),'is honest about the call');
  assert.ok(/middle of something\?$/.test(s.opener),'hands them the exit');
  assert.equal(s.questions.length,4);
  assert.equal(s.stages.length,4);
  assert.ok(s.voicemail.includes('Picture KC'));
 }
});

test('an unknown campaign still returns a usable generic script',()=>{
 const s=callScript({campaignId:'something-new',caller:'Milton',company:'Acme',firstName:null});
 assert.ok(s.opener.startsWith('Hi there,'));
 assert.equal(s.questions.length,4);
 assert.ok(!spoken(s).includes('revisions'));
});

test('objections separate what is said from the caller note',()=>{
 const s=make(MEDIA);
 assert.equal(s.objections.length,7);
 for(const o of s.objections){assert.ok(o.label&&o.say,'label and say present');}
 const pricing=s.objections.find(o=>o.label==='How much?');
 assert.ok(!pricing.say.toLowerCase().includes('approved pricing'),'the instruction is not read aloud');
 assert.ok(pricing.note.toLowerCase().includes('upfront'),'the upfront-payment rule is in the note');
 const stop=s.objections.find(o=>o.label==='Not interested / stop');
 assert.ok(stop.note.toLowerCase().includes('exclusion is recorded'));
});
