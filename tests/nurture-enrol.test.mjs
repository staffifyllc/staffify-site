import test from 'node:test';
import assert from 'node:assert/strict';

// The real module imports the live opt-out and client gates, so this exercises the decision
// ordering through a stubbed redis rather than reimplementing it.
const { enrolInNurture, NURTURE_SET } = await import('../api/_nurture-enrol.js');

const fakeRedis = (seed = {}) => {
    const h = { ...seed }, z = [];
    return { h, z,
        hgetall: async k => h[k] || null,
        hset: async (k, v) => { h[k] = { ...(h[k] || {}), ...v }; },
        zadd: async (k, { member }) => { z.push([k, member]); },
    };
};

test('an empty address is refused before anything is written',async()=>{
 const r=fakeRedis();
 const out=await enrolInNurture({redis:r,email:''});
 assert.equal(out.enrolled,false);
 assert.equal(out.reason,'no email');
 assert.equal(r.z.length,0,'nothing added to the set');
});

test('somebody already in the nurture is left alone',async()=>{
 const r=fakeRedis({'nurture:joel@picturekc.com':{email:'joel@picturekc.com',day3_sent_at:'123'}});
 const out=await enrolInNurture({redis:r,email:'Joel@PictureKC.com'});
 assert.equal(out.enrolled,false);
 assert.equal(out.reason,'already in nurture');
 // Re-enrolling would restart the day counter and mail them from the top again.
 assert.equal(r.z.length,0);
 assert.equal(r.h['nurture:joel@picturekc.com'].day3_sent_at,'123','their progress is untouched');
});

test('it never throws, whatever the store does',async()=>{
 const broken={hgetall:async()=>{throw Error('redis down');}};
 const out=await enrolInNurture({redis:broken,email:'x@y.com'});
 assert.equal(out.enrolled,false);
 assert.match(out.reason,/enrolment failed/);
});

test('the set name matches what the nurture cron reads',()=>{
 assert.equal(NURTURE_SET,'nurture:active');
});
