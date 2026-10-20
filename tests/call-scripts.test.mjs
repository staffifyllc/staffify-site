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
  assert.ok(/quick second\?$/.test(s.opener),'hands them the exit');
  // The media script asks one more than the others, so this is a floor, not a fixed number.
  assert.ok(s.questions.length>=4,'at least four questions');
  assert.equal(s.stages.length,s.questions.length,'a stage per question, none blank');
  for(const st of s.stages) assert.ok(st.label&&st.say,'every stage has a label and a line');
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

test('the call tree is complete: every branch leads somewhere and ends on a real disposition',()=>{
 const OUTCOMES=new Set(['connected','callback','timing','no_answer','voicemail','wrong_number','suppress']);
 for(const id of ['staffify-agency-outreach','staffify-tobit-outreach','staffify-talent-network-outreach']){
  const t=callScript({campaignId:id,caller:'Milton',company:'Picture KC',firstName:'Joel'}).tree;
  assert.ok(t.open,'has an entry node');
  // no dangling branches
  for(const [node,def] of Object.entries(t))
   for(const [label,to] of def.choices||[])
    assert.ok(t[to],`${id}: "${label}" on ${node} points at missing node ${to}`);
  // every node is reachable from open
  const seen=new Set(['open']),stack=['open'];
  while(stack.length){for(const [,to] of (t[stack.pop()].choices||[]))if(!seen.has(to)){seen.add(to);stack.push(to);}}
  for(const node of Object.keys(t)) assert.ok(seen.has(node),`${id}: ${node} is unreachable`);
  // every leaf tells the caller what to log, with an outcome the card accepts
  for(const [node,def] of Object.entries(t)){
   if((def.choices||[]).length) continue;
   assert.ok(def.log,`${id}: leaf ${node} has no disposition`);
   assert.ok(OUTCOMES.has(def.log),`${id}: leaf ${node} logs "${def.log}" which is not a real outcome`);
  }
  // a prospect who did not opt out is never suppressed
  assert.equal(t.nothing.log,'connected','no current need is not an opt-out');
  assert.equal(t.stop.log,'suppress');
 }
});

test('the tree asks the campaign-correct discovery question',()=>{
 const media=callScript({campaignId:'staffify-agency-outreach',caller:'M',company:'C',firstName:'J'});
 assert.ok(/QC and revisions/.test(media.tree.discover.say));
 const b2b=callScript({campaignId:'staffify-tobit-outreach',caller:'M',company:'C',firstName:'J'});
 assert.ok(!/QC|revisions/i.test(b2b.tree.discover.say));
 assert.ok(!/QC|revisions/i.test(Object.values(b2b.tree).map(n=>n.say||'').join(' ')));
});

test('media owners are asked how long a client issue takes to resolve',()=>{
 const m=callScript({campaignId:'staffify-agency-outreach',caller:'M',company:'Picture KC',firstName:'J'});
 assert.equal(m.questions.length,5);
 assert.ok(m.questions.some(q=>/how long it|how long you|how long/i.test(q)&&/resolved/i.test(q)),'asks the resolution question');
 assert.ok(m.tree.resolve,'the tree has a node for it');
 // Both discovery branches reach it, directly when they admit they are in it and via
 // "what's left then" when they say it is handled, because the question works either way.
 assert.equal(m.tree.discover.choices[0][1],'resolve');
 assert.equal(m.tree.discover.choices[1][1],'elsewhere');
 assert.equal(m.tree.elsewhere.choices[0][1],'resolve');
 assert.equal(m.tree.elsewhere.choices[1][1],'nothing','a happy prospect still gets a polite exit');
 // The other campaigns are not asked it and get no node.
 for(const id of ['staffify-tobit-outreach','staffify-talent-network-outreach']){
  const o=callScript({campaignId:id,caller:'M',company:'C',firstName:'J'});
  assert.equal(o.questions.length,4);
  assert.equal(o.tree.resolve,undefined,id+' must not get the media resolution node');
 }
});

test('the close asks for the meeting at every question count',()=>{
 for(const id of ['staffify-agency-outreach','staffify-tobit-outreach','staffify-talent-network-outreach']){
  const s=callScript({campaignId:id,caller:'M',company:'C',firstName:'J'});
  assert.ok(/half an hour/i.test(s.tree.close.say),id+' close must ask for the meeting, got: '+s.tree.close.say);
  assert.equal(s.tree.close.say,s.questions[s.questions.length-1]);
 }
});

test('the reason beat is said before any question, on every route in',()=>{
 for(const id of ['staffify-agency-outreach','staffify-tobit-outreach','staffify-talent-network-outreach']){
  const s=callScript({campaignId:id,caller:'Milton',company:'Picture KC',firstName:'Joel'});
  assert.ok(s.reason,'reason present');
  assert.ok(/only call a few people/i.test(s.reason),'the pattern interrupt');
  assert.ok(/six million/i.test(s.reason),'the founder credential');
  // Both ways into the conversation go through it before discovery.
  assert.equal(s.tree.open.choices[0][1],'reason','"go ahead" hits the reason first');
  assert.equal(s.tree.context.choices[0][1],'reason','"what is this about" rejoins at the reason');
  assert.equal(s.tree.reason.choices[0][1],'discover','and it leads into the first question');
  // It is a statement, not a discovery question, so it must not be counted as a stage.
  assert.ok(!s.stages.some(st=>st.say===s.reason),'never rendered as a question stage');
 }
});

test('everyone books through the contract link until a caller is authorized otherwise',async()=>{
 const {bookingLinkFor}=await import('../api/_call-scripts.js');
 const CONTRACT='https://calendly.com/go-staffify/discovery-call';
 // Section 4 of the signed agreement requires Paul's link; Section 6 ties attribution to the
 // booking being recorded under it, so a personal link would risk the caller's own commission.
 for(const e of ['milton@trystaffify.com','miltion@trystaffify.com','hello@gostaffify.com','',null,undefined])
  assert.equal(bookingLinkFor(e),CONTRACT,`${e} must use the contract link`);
});

test('the brief hands out the contract booking link',()=>{
 const milton=callScript({campaignId:'staffify-agency-outreach',caller:'Milton',callerEmail:'milton@trystaffify.com',company:'C',firstName:'J'});
 assert.equal(milton.bookingUrl,'https://calendly.com/go-staffify/discovery-call');
 const other=callScript({campaignId:'staffify-agency-outreach',caller:'Paul',callerEmail:'hello@gostaffify.com',company:'C',firstName:'J'});
 assert.equal(other.bookingUrl,'https://calendly.com/go-staffify/discovery-call');
 // No identity at all still yields a usable link.
 assert.equal(callScript({campaignId:'staffify-agency-outreach',caller:'X',company:'C',firstName:'J'}).bookingUrl,
              'https://calendly.com/go-staffify/discovery-call');
});
