import test from 'node:test';
import assert from 'node:assert/strict';
import {contactResearch,researchedPhone} from '../api/_outreach-contact-enrichment.js';
import {withCallPhones} from '../api/_outreach-call-phones.js';
const now=Date.parse('2026-10-13T12:00:00Z'),e={campaignId:'ceo',recipient:'a@example.com',provider:'RocketReach',identityMatched:true,phone:{e164:'+15555550100',grade:'A',validity:'valid',last_checked:'2026-10-01'},retrievedAt:'2026-10-13'};
test('research is bound to exact campaign record and recipient',()=>{const doc={records:{a:e}};assert.equal(contactResearch({id:'a',campaignId:'other',recipient:e.recipient},doc),null);assert.equal(contactResearch({id:'a',campaignId:'ceo',recipient:'b@example.com'},doc),null);});
test('only fresh valid grade A identity matches supply a call number',()=>{assert.ok(researchedPhone(e,now));for(const phone of [{...e.phone,grade:'A-'},{...e.phone,validity:'invalid'},{...e.phone,last_checked:'2025-01-01'}])assert.equal(researchedPhone({...e,phone},now),null);assert.equal(researchedPhone({...e,identityMatched:false},now),null);});
test('adding research never makes an ineligible record call-ready',async()=>{const s=await withCallPhones({records:[{id:'a',campaignId:'ceo',recipient:e.recipient,callReady:false}]},{redis:{get:async()=>({records:{a:e}})},crm:()=>{throw Error('must not fetch')},now});assert.equal(s.records[0].callReady,false);assert.equal(s.records[0].contactResearch,e);});
