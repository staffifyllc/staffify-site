import test from 'node:test';
import assert from 'node:assert/strict';
import {followup} from '../api/_outreach-policy.js';
test('first follow-up invites an agency connection with accurate sender attribution',()=>{
 const paul=followup({owner:'Paul',sentTouches:1,verifiedFirstName:'Chris'});
 const madison=followup({owner:'Madison',sentTouches:1,verifiedFirstName:'Chris'});
 assert.match(paul,/Hey Chris,\n\n/);assert.match(paul,/I’ve built my own/);
 assert.match(madison,/Paul, our founder/);assert.doesNotMatch(madison,/I’ve built my own/);
 for(const body of [paul,madison]){assert.match(body,/calendly.com\/go-staffify\/media-owner-workflow-chat/);assert.match(body,/kick rocks/);}
});
test('later touches retain delivery and closeout copy',()=>{
 assert.match(followup({owner:'Paul',sentTouches:2}),/For delivery/);
 assert.match(followup({owner:'Paul',sentTouches:3}),/wrap up this email thread/);
});
