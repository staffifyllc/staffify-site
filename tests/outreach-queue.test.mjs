import test from 'node:test';import assert from 'node:assert/strict';import {mergeSnapshot,visibleState,controlState,ownerFor} from '../api/_outreach-queue.js';
const row={id:'one',sender:'paul@trystaffify.com',owner:'Paul',recipient:'a@example.com',status:'draft_saved'};
const input={records:[row],assignments:[{email:'a@example.com',owner:'Madison',agencyKey:'example.com'}],suppressions:[]};
test('ownership cannot be bypassed by incoming sender or assignment',()=>{const s=mergeSnapshot(null,input);assert.equal(s.records[0].status,'reserved_for_madison_external');assert.equal(mergeSnapshot(s,{...input,assignments:[]}).records[0].owner,'Madison');});
test('exclusion and pause survive stale worker state',()=>{let s=mergeSnapshot(null,input);s=controlState(s,{action:'suppress',email:row.recipient},'all');s=controlState(s,{action:'pause',owner:'Madison'},'all');s=mergeSnapshot(s,input);assert.equal(s.records[0].status,'suppressed');assert.deepEqual(s.pausedOwners,['Madison']);});
test('owner access isolation',()=>{const s=mergeSnapshot(null,input);assert.equal(visibleState(s,'Paul').records.length,0);assert.equal(visibleState(s,'Madison').records.length,1);assert.throws(()=>controlState(s,{action:'suppress',email:row.recipient},'Paul'));assert.equal(ownerFor({email:'outsider@example.com',role:'rep'}),null);});
test('reject duplicate records and unknown senders',()=>{assert.throws(()=>mergeSnapshot(null,{...input,records:[row,row]}));assert.throws(()=>mergeSnapshot(null,{...input,records:[{...row,sender:'other@example.com'}]}));});
import { readFileSync } from 'node:fs';
import {spawnSync} from 'node:child_process';
test('review page script parses',()=>{const html=readFileSync(new URL('../outreach-review/index.html',import.meta.url),'utf8');const js=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];const parsed=spawnSync(process.execPath,['--input-type=module','--check'],{input:js,encoding:'utf8'});assert.equal(parsed.status,0,parsed.stderr);});

test('stale call-ready flag cannot survive reply, suppression or owner pause',()=>{
 const r={id:'call',owner:'Paul',recipient:'a@example.com',status:'human_reply_hold',sentTouches:4,verifiedSentTouches:4,lastSentAt:'2026-01-01T00:00:00Z',callReady:true};
 const s={records:[r],assignments:[],suppressions:[],pausedOwners:[]};
 assert.equal(visibleState(s,'all').records[0].callReady,false);
 r.status='sent';assert.equal(visibleState(s,'all').records[0].callReady,true);
 s.pausedOwners=['Paul'];assert.equal(visibleState(s,'all').records[0].callReady,false);
 s.pausedOwners=[];s.suppressions=[r.recipient];assert.equal(visibleState(s,'all').records[0].callReady,false);
});

import {canUseCallQueue,sharedCallState} from '../api/_outreach-queue.js';
import {callReady} from '../api/_outreach-policy.js';
test('caller access does not confer sales owner access and shared queue excludes ineligible records',()=>{
 const caller={email:'caller@example.com',role:'caller'};
 assert.equal(canUseCallQueue(caller),true);assert.equal(ownerFor(caller),null);
 assert.equal(canUseCallQueue({email:'outsider@example.com',role:'rep'}),false);
 // The tobit list: the real estate media (agency) list is paused for new calls since 2026-10-27, tested below.
 const due={...row,campaignId:'staffify-tobit-outreach',status:'sent',sentTouches:4,verifiedSentTouches:4,lastSentAt:'2026-01-01'};
 const s={revision:1,records:[due,{...due,id:'two',owner:'Madison',recipient:'b@example.com'},{...due,id:'reply',status:'human_reply_hold'}],assignments:[],pausedOwners:[],suppressions:[]};
 assert.equal(sharedCallState(s).records.length,2);assert.equal(sharedCallState(s).assignments,undefined);
 // Nothing is claimed until somebody records an outcome, so both are offered as work.
 assert.equal(sharedCallState(s,caller.email).records.filter(r=>r.unclaimed).length,2);
 const next=controlState(s,{action:'call-outcome',id:'two',outcome:'connected'},'all',caller.email);
 assert.equal(next.records[1].owner,'Madison');assert.equal(next.records[1].callHistory[0].caller,caller.email);
 // Working it claims the follow-up without touching the sales owner.
 assert.equal(next.records[1].callOwner,caller.email);
 assert.equal(next.records[1].owner,'Madison');
 // Still VISIBLE to the team, but no longer offered as unclaimed work to anyone.
 const seen=sharedCallState(next,caller.email);
 assert.equal(seen.records.length,2);
 assert.equal(seen.records.filter(r=>r.unclaimed).length,1);
 const claimed=seen.records.find(r=>r.id==='two');
 assert.equal(claimed.claimed,true);assert.equal(claimed.mine,true);assert.equal(claimed.unclaimed,false);
 // A different teammate sees the owner, and it is not offered to them either.
 const other=sharedCallState(next,'someone.else@example.com').records.find(r=>r.id==='two');
 assert.equal(other.callOwner,caller.email);assert.equal(other.mine,false);assert.equal(other.unclaimed,false);
});

test('first recorded outcome claims the follow-up and a later caller cannot steal it',()=>{
 const due={...row,status:'sent',sentTouches:4,verifiedSentTouches:4,lastSentAt:'2026-01-01'};
 const s={revision:1,records:[due],assignments:[],pausedOwners:[],suppressions:[]};
 const soon=new Date(Date.now()+864e5).toISOString();
 const first=controlState(s,{action:'call-outcome',id:due.id,outcome:'no_answer',nextCallAt:soon},'all','first@example.com');
 assert.equal(first.records[0].callOwner,'first@example.com');
 const stamped=first.records[0].callOwnerAt;
 // A second caller covering the callback appends history but ownership does not move.
 const second=controlState({...first,records:first.records.map(r=>({...r,callOutcome:undefined,nextCallAt:null}))},
   {action:'call-outcome',id:due.id,outcome:'voicemail',nextCallAt:soon},'all','second@example.com');
 assert.equal(second.records[0].callOwner,'first@example.com');
 assert.equal(second.records[0].callOwnerAt,stamped);
 assert.equal(second.records[0].callHistory.length,2);
 assert.equal(second.records[0].callHistory[1].caller,'second@example.com');
});

test('"not interested: timing" is a yes later, not a suppression',()=>{
 const due={...row,status:'sent',sentTouches:4,verifiedSentTouches:4,lastSentAt:'2026-01-01'};
 const s={revision:1,records:[due],assignments:[],pausedOwners:[],suppressions:[]};
 const quarter=new Date(Date.now()+90*864e5).toISOString();

 // It needs a future date, exactly like a callback.
 assert.throws(()=>controlState(s,{action:'call-outcome',id:due.id,outcome:'timing',nextCallAt:'2020-01-01'},'all','m@x.com'),/future callback time/);

 const next=controlState(s,{action:'call-outcome',id:due.id,outcome:'timing',nextCallAt:quarter},'all','m@x.com');
 const r=next.records[0];
 assert.equal(r.callOutcome,'timing');
 assert.equal(r.nextCallAt,quarter);
 // Never suppressed: they did not ask to be left alone.
 assert.equal(next.suppressions.length,0);
 assert.ok(!/suppress/.test(r.status||''),'status must not be suppressed');
 // And it claims the follow-up like any other worked call.
 assert.equal(r.callOwner,'m@x.com');
});

test('a timing lead comes back round when its date arrives, and not before',()=>{
 const base={...row,status:'sent',sentTouches:4,verifiedSentTouches:4,lastSentAt:'2026-01-01',callOutcome:'timing'};
 const soon=new Date(Date.now()+30*864e5).toISOString();
 const past=new Date(Date.now()-864e5).toISOString();
 assert.equal(callReady({...base,nextCallAt:soon}),false,'not due yet');
 assert.equal(callReady({...base,nextCallAt:past}),true,'due now');
 assert.equal(callReady({...base,nextCallAt:null}),false,'no date means it never returns blindly');
});

test('real estate media is paused: its unworked cards leave the pool, an owned callback moves to the Paused area, and the worker never sends for it', async () => {
 // Paul, 2026-10-27: "Stop targeting real estate media/REP agencies ... without deleting records or hiding owned callbacks."
 const { withPauses } = await import('../api/_outreach-gmail.js');
 const agency={...row,status:'sent',sentTouches:4,verifiedSentTouches:4,lastSentAt:'2026-01-01'};
 const owned={...agency,id:'mine',recipient:'m@example.com',callOwner:'caller@example.com',callOutcome:'callback',nextCallAt:'2026-01-02T15:00:00Z',callHistory:[{outcome:'callback',caller:'caller@example.com',at:'2026-01-01'}]};
 const v=sharedCallState({revision:1,records:[agency,owned],assignments:[],pausedOwners:[],suppressions:[]},'caller@example.com').records;
 assert.equal(v.find(r=>r.id==='one').unclaimed,false,'not offered as new work to anyone');
 // PM refinement, 2026-10-27: owned REP callbacks are kept (owner, history, promised time) but are not due work.
 const mine=v.find(r=>r.id==='mine');
 assert.equal(mine.dueForMe,false,'not tomorrow\'s worklist'); assert.equal(mine.pausedFollowUp,true,'in the Paused area instead');
 assert.equal(mine.callOwner,'caller@example.com'); assert.equal(mine.nextCallAt,'2026-01-02T15:00:00Z','the promise is kept, not rewritten');
 assert.equal(v.length,2,'nothing deleted');
 assert.deepEqual(withPauses({allowedCampaignIds:null}).allowedCampaignIds,['staffify-tobit-outreach','staffify-talent-network-outreach'],'no stored list: everything but the paused campaign');
 assert.deepEqual(withPauses({allowedCampaignIds:['staffify-agency-outreach','staffify-talent-network-outreach']}).allowedCampaignIds,['staffify-talent-network-outreach'],'a stored list that names it cannot re-enable it');
});
// Paul, 2026-10-30: "not only being removed from our view". A said-no row leaves the shared call list even when owned.
test('a person who said no or opted out leaves the shared call list, owned or not',()=>{const s={revision:1,records:[{id:'a',recipient:'a@x.com',owner:'Paul',status:'suppressed',callOwner:'milton@trystaffify.com',callOutcome:'callback'},{id:'b',recipient:'b@x.com',owner:'Paul',status:'sent',callOwner:'milton@trystaffify.com',callOutcome:'callback'},{id:'c',recipient:'c@x.com',owner:'Paul',status:'sent',callOwner:'milton@trystaffify.com',callOutcome:'callback'}],assignments:[],suppressions:['b@x.com'],pausedOwners:[]};assert.deepEqual(sharedCallState(s,'milton@trystaffify.com').records.map(r=>r.id),['c']);});

// Paul, 2026-10-31: "i can probably realistically do 20 dials a day on my end, so the rest should go to the team".
test('Paul is capped at 20 new people a day; his callbacks never are, and the rest stays in the team pool', async () => {
    const { capNewPeople, newCalledToday, DAILY_NEW_CAP } = await import('../api/_outreach-queue.js');
    assert.equal(DAILY_NEW_CAP['hello@gostaffify.com'], 20);
    const now = Date.parse('2026-11-02T18:00:00Z');   // 1 PM Eastern
    const mine = i => ({ id: 'm' + i, unclaimed: false, mine: true, dueForMe: true, callHistory: [{ caller: 'hello@gostaffify.com', at: '2026-11-02T1' + (i % 6) + ':00:00Z', outcome: 'no_answer' }] });
    const fresh = i => ({ id: 'n' + i, unclaimed: true, callHistory: [] });
    const yesterday = { id: 'y', unclaimed: false, callHistory: [{ caller: 'hello@gostaffify.com', at: '2026-11-01T18:00:00Z' }] };
    const someoneElse = { id: 'o', unclaimed: false, callHistory: [{ caller: 'milton@trystaffify.com', at: '2026-11-02T15:00:00Z' }] };
    const under = [...Array.from({ length: 19 }, (_, i) => mine(i)), yesterday, someoneElse, fresh(1), fresh(2)];
    assert.equal(newCalledToday(under, 'HELLO@gostaffify.com', now), 19);
    const a = capNewPeople(under, 'hello@gostaffify.com', now);
    assert.deepEqual(a.dailyNew, { cap: 20, used: 19 }); assert.equal(a.records.filter(r => r.unclaimed).length, 2, 'under the cap, the pool is open');
    const at = [...under, mine(19)];
    const b = capNewPeople(at, 'hello@gostaffify.com', now);
    assert.deepEqual(b.dailyNew, { cap: 20, used: 20 });
    assert.equal(b.records.filter(r => r.unclaimed).length, 0, 'at 20, no new people are offered');
    assert.ok(b.records.filter(r => r.capReached).every(r => !(r.callHistory || []).length));
    assert.equal(b.records.filter(r => r.dueForMe).length, 20, 'his own follow-ups are untouched');
    const team = capNewPeople(at, 'milton@trystaffify.com', now);
    assert.equal(team.dailyNew, null); assert.equal(team.records.filter(r => r.unclaimed).length, 2, 'the team keeps every card');
    // Late evening Eastern is still the same day: 11 PM ET on Nov 2 is 04:00 UTC on Nov 3.
    assert.equal(newCalledToday([{ callHistory: [{ caller: 'hello@gostaffify.com', at: '2026-11-03T03:30:00Z' }] }], 'hello@gostaffify.com', Date.parse('2026-11-03T04:00:00Z')), 1);
});
