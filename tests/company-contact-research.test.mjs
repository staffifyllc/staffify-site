import test from 'node:test';import assert from 'node:assert/strict';
import {publishedEmail,knownCompany,ownerOnSite,repFit} from '../api/_company-contact-research.js';
test('published contact must be on its own business domain; vendor and personal addresses do not get guessed',()=>{
 const p={url:'https://www.example.com/contact',html:'designer@vendor.com hello@example.com noreply@example.com'};
 assert.equal(publishedEmail(p,'example.com'),'hello@example.com');assert.equal(publishedEmail({...p,url:'https://directory.com'},'example.com'),null);
 assert.equal(publishedEmail({...p,html:'person@gmail.com'},'example.com'),null);
});
test('existing company assignment blocks another discovered address',()=>{
 assert.equal(knownCompany({name:'Example',website:'example.com'},{records:[{recipient:'old@example.com'}]}),true);
 assert.equal(knownCompany({name:'Example',website:'example.com'},{assignments:[{company:'Example',owner:'Madison'}]}),true);
});
test('no fabricated owner from a title or generic company name',()=>{assert.equal(ownerOnSite({text:'Example Media photography'}),null);assert.equal(ownerOnSite({text:'Founder: Jane Smith'}),'Jane Smith');assert.equal(repFit('Real estate photography and video'),true);assert.equal(repFit('wedding photography'),false);});

test('large embedded assets do not stall extraction or produce truncated addresses', async()=>{
 const {spawnSync}=await import('node:child_process');
 const script=`import {publishedEmail} from './api/_company-contact-research.js';
 const html='A'.repeat(500000)+' '+ 'x'.repeat(100)+'@example.com hello@example.com';
 console.log(publishedEmail({url:'https://example.com',html},'example.com'));`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:3000});
 assert.ifError(result.error);assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'hello@example.com');
});
