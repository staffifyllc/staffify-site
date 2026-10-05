import test from 'node:test';import assert from 'node:assert/strict';
import {listedPhone,checkBusinessPhone} from '../api/_outreach-phone-evidence.js';
test('business evidence matches formatted NANP numbers but not another number',()=>{assert.ok(listedPhone({text:'Call (305) 555-1234'},'+13055551234'));assert.ok(!listedPhone({text:'Call (305) 555-9999'},'+13055551234'));assert.ok(!listedPhone({text:'5551234'},'5551234'));});
test('follows observed same-origin contact link and retains provenance',async()=>{let urls=[];const r=await checkBusinessPhone({phone:'3055551234',website:'https://example.com',fetchSite:async u=>{urls.push(u);return u.endsWith('/contact')?{url:u,text:'305-555-1234'}:{url:u,html:'<a href="/contact">Contact</a><a href="https://other.com/about">Other</a>',text:''};}});assert.equal(r.status,'business_listed');assert.equal(r.sourceUrl,'https://example.com/contact');assert.equal(urls.length,2);});
test('unavailable and mismatched sites never approve a number',async()=>{for(const fetchSite of [async()=>{throw Error('offline')},async()=>({url:'https://example.com',text:'3055559999'})]){assert.equal((await checkBusinessPhone({phone:'3055551234',website:'https://example.com',fetchSite})).status,'needs_confirmation');}});

test('published phone numbers can use typographic dashes',()=>assert.ok(listedPhone({text:'Call (707) 363–2489'},'+17073632489')));
