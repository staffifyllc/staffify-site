import test from 'node:test';
import assert from 'node:assert/strict';
import {excerptFrom} from '../api/outreach-research.js';

// Real text shapes taken from the first backfill batch against live sites.
test('a nav strip never becomes the excerpt',()=>{
 const nav='Real Estate Photography - Eastside Pics Click here to see our 5-Star reviews on Google Home Gallery Our Services Pricing The Team Agent Login More Home Gallery';
 const out=excerptFrom(nav);
 assert.ok(!/Agent Login|Open Menu|Close Menu/.test(out),'no menu items: '+out);
});

test('it prefers the sentence that describes the business',()=>{
 const page='Home Services About Contact. We are a full service real estate photography and video studio serving Kansas City since 2014. Book now.';
 const out=excerptFrom(page);
 assert.ok(out.includes('real estate photography and video studio'),out);
 assert.ok(!out.startsWith('Home Services'),out);
});

test('a descriptive title is used when there is no prose',()=>{
 const out=excerptFrom('AK Media - Real Estate Photography, Aerial/Drone, 3D Virtual Tours, Video Skip to content Welcome Real Estate Media Photography Marketing Kit');
 assert.ok(/Real Estate Photography/.test(out),out);
});

test('nothing readable yields nothing, never a guess',()=>{
 for(const junk of ['','   ','Home','Open Menu Close Menu Our Services Order Now Open Menu Close Menu'])
  assert.equal(excerptFrom(junk),'',`"${junk.slice(0,30)}" must not produce an excerpt`);
});

test('a generic business page with no media signal still gets its own sentence',()=>{
 const out=excerptFrom('Acme Consulting. We help mid sized manufacturers tighten up their operations and reporting across the business. Contact us.');
 assert.ok(/mid sized manufacturers/.test(out),out);
});

test('whitespace is normalised and the excerpt stays short',()=>{
 const out=excerptFrom('Nav. We shoot   drone\n\n and  matterport tours for listings right across the metro area, booked entirely online by our agents.');
 assert.ok(!/\s{2,}/.test(out));
 assert.ok(out.length<=220,'length '+out.length);
 assert.ok(/matterport/.test(out));
});
