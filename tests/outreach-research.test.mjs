import test from 'node:test';
import assert from 'node:assert/strict';
import {excerptFrom} from '../api/outreach-research.js';

test('the excerpt prefers the sentence that says what the business does',()=>{
 const page='Home About Contact We are a full service real estate photography and video studio serving Kansas City since 2014. Book now.';
 const out=excerptFrom(page);
 assert.ok(out.includes('real estate photography'),'captures the ICP sentence');
 assert.ok(out.length<=220);
});

test('it falls back to the opening of the page when nothing matches',()=>{
 const page='Acme Consulting helps mid sized manufacturers tighten their operations. '.repeat(6);
 const out=excerptFrom(page);
 assert.ok(out.startsWith('Acme Consulting helps'));
 assert.ok(out.length<=200);
});

test('a page with nothing readable yields no excerpt, never a guess',()=>{
 for(const junk of ['','   ','Home'])
  assert.equal(excerptFrom(junk),'',`"${junk}" must not produce an excerpt`);
});

test('whitespace is normalised so the card does not render a wall of newlines',()=>{
 const out=excerptFrom('Drone   and\n\n  matterport\t tours for listings across the metro area, booked online.');
 assert.ok(!/\s{2,}/.test(out));
 assert.ok(/matterport/.test(out));
});
