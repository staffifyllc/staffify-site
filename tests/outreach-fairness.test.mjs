import test from 'node:test';
import assert from 'node:assert/strict';
import {fairCandidates} from '../api/_outreach-fairness.js';
const rows=[{id:'p',owner:'Paul',sentTouches:3},{id:'m1',owner:'Madison',sentTouches:0},{id:'m2',owner:'Madison',sentTouches:1}];
test('Paul backlog cannot starve Madison; her follow-ups stay first',()=>{assert.deepEqual(fairCandidates(rows,[{owner:'Paul',status:'verified'}]).map(r=>r.id),['m2','m1','p']);});
test('next success returns turn to Paul without waiting for Madison backlog',()=>{assert.equal(fairCandidates(rows,[{owner:'Paul',status:'verified'},{owner:'Madison',status:'verified'}])[0].id,'p');});
test('uncertain operations do not count as successful turns; absent owner does not block',()=>{assert.equal(fairCandidates(rows,[{owner:'Paul',status:'verified'},{owner:'Madison',status:'reserved'}])[0].id,'m2');assert.equal(fairCandidates([rows[0]],[{owner:'Paul',status:'verified'}])[0].id,'p');});
