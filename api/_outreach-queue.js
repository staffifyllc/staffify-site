import {campaignPaused,poolPaused} from './_campaign-pause.js';
import {tagCampaign} from './_outreach-campaign.js';
import {callReady} from './_outreach-policy.js';
import {hasCallerPlan} from './_caller-plan.js';
export const KEY = 'staffify:outreach-review:v1';
export const SENDERS = ['paul@trystaffify.com','paul@staffifyhq.com','hello@gostaffify.com','paul@hirestaffify.com','madison@gostaffify.com','madison@staffifyhq.com','madison@trystaffify.com','madison@hirestaffify.com','madison.sterling@trystaffify.com'];
export function ownerFor(rep) {
  if (rep?.role === 'admin') return 'all';
  if (SENDERS.slice(4).includes(rep?.email?.toLowerCase())) return 'Madison';
  if (SENDERS.slice(0,4).includes(rep?.email?.toLowerCase())) return 'Paul';
  return null;
}
export function visibleState(state, owner) {
  const s=tagCampaign(state || {revision:0,records:[],assignments:[],suppressions:[],pausedOwners:[],updatedAt:null});
  const records=s.records.filter(r=>owner==='all'||r.owner===owner).map(r=>({...r,callReady:callReady(r)&&!s.pausedOwners?.includes(r.owner)&&!s.suppressions?.includes(r.recipient)}));
  return {...s,records,assignments:s.assignments.filter(r=>owner==='all'||r.owner===owner),suppressions:owner==='all'?s.suppressions:s.suppressions.filter(e=>records.some(r=>r.recipient===e)),workerFresh:!!(s.queueUpdatedAt||s.updatedAt) && Date.now()-Date.parse(s.queueUpdatedAt||s.updatedAt)<90*60*1000};
}
export function mergeSnapshot(previous, incoming, now=new Date().toISOString()) {
  if (!Array.isArray(incoming.records)||!Array.isArray(incoming.assignments)||incoming.records.length>10000) throw Error('Invalid snapshot');
  const assignments=previous?.assignments?.length?previous.assignments:incoming.assignments;
  const assignment=new Map(assignments.map(a=>[String(a.email).toLowerCase(),a.owner]));
  const agencyOwners=new Map(assignments.map(a=>[a.agencyKey,a.owner]));
  const suppressed=new Set([...(previous?.suppressions||[]),...(incoming.suppressions||[])].map(e=>String(e).toLowerCase()));
  const ids=new Set();
  // A booking mark lives only here (api/_booked-leads.js); an uploaded snapshot never carries it, so it is kept.
  const booked=new Map((previous?.records||[]).filter(r=>r.booking).map(r=>[r.id,r.booking]));
  const records=incoming.records.map(r=>{
    if(!r.id||ids.has(r.id)||!SENDERS.includes(r.sender)||!['Paul','Madison'].includes(r.owner))throw Error('Invalid record');
    ids.add(r.id);
    const recipient=String(r.recipient||'').toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))throw Error('Invalid recipient');
    const owner=assignment.get(recipient)||agencyOwners.get(r.agencyKey)||r.owner;
    const ownershipHold=owner==='Madison'&&!SENDERS.slice(4).includes(r.sender);
    return {...r,...(booked.has(r.id)?{booking:booked.get(r.id),callReady:false}:{}),recipient,owner,status:suppressed.has(recipient)?'suppressed':ownershipHold?'reserved_for_madison_external':r.status};
  });
  return {revision:(previous?.revision||0)+1,records,assignments,suppressions:[...suppressed],pausedOwners:previous?.pausedOwners||[],updatedAt:now,mailboxes:incoming.mailboxes||[],lastWorkerError:incoming.lastWorkerError||null};
}
// dialled: the number the dialer had on screen when the outcome was logged. Kept on the history entry
// so a report can pair the outcome with the phone system's record of that exact call.
const dialledNumber = d => { const s = String(d || '').replace(/[^+\d]/g, '').slice(0, 16); return s.replace(/\D/g, '').length >= 10 ? s : null; };
export function controlState(previous, {action,owner,email,id,outcome,notes,nextCallAt,dialled}, actor, callerIdentity=actor) {
  if (!previous) throw Error('Queue not initialized');
  if (action==='pause'||action==='resume') {
    if(!['Paul','Madison'].includes(owner)||(actor!=='all'&&actor!==owner))throw Error('Forbidden');
    const paused=new Set(previous.pausedOwners||[]);action==='pause'?paused.add(owner):paused.delete(owner);
    return {...previous,pausedOwners:[...paused],revision:previous.revision+1};
  }
  if(action==='call-outcome') {
    const row=previous.records.find(r=>r.id===id);
    if(!row||(actor!=='all'&&actor!==row.owner))throw Error('Forbidden');
    // 'timing' is a yes later, not a no. It is deliberately NOT a suppression: the prospect
    // never asked to be left alone, they asked to be asked again.
    if(!['connected','no_answer','voicemail','callback','gatekeeper','timing','wrong_number'].includes(outcome))throw Error('Invalid outcome');
    if(!callReady(row)||previous.pausedOwners?.includes(row.owner)||previous.suppressions?.includes(row.recipient))throw Error('Call is no longer due');
    if(['no_answer','voicemail','callback','gatekeeper','timing'].includes(outcome)&&!(Date.parse(nextCallAt)>Date.now()))throw Error('Choose a future callback time');
    const at=new Date().toISOString(),entry={outcome,notes:String(notes||'').slice(0,4000),at,caller:callerIdentity,nextCallAt:nextCallAt||null,...(dialledNumber(dialled)?{dialled:dialledNumber(dialled)}:{})};
    // Paul, 2026-10-20: "after a teammate works the call, they own it". The FIRST recorded outcome
    // claims the follow-up; opening a card claims nothing. Set once and never overwritten, so a
    // second caller covering a callback appends history without stealing ownership. This is the
    // CALL owner only: r.owner (the sending sales owner) and commission attribution are untouched.
    return {...previous,revision:previous.revision+1,records:previous.records.map(r=>r.id===id?{...r,callOutcome:outcome,nextCallAt:entry.nextCallAt,callOwner:r.callOwner||callerIdentity,callOwnerAt:r.callOwnerAt||at,callHistory:[...(r.callHistory||[]),entry],...(outcome==='connected'?{status:'human_reply_hold'}:outcome==='wrong_number'?{status:'call_research_hold'}:{})}:r)};
  }
  if(action==='suppress') {
    email=String(email||'').toLowerCase();
    if(!previous.records.some(r=>r.recipient===email&&(actor==='all'||r.owner===actor)))throw Error('Forbidden');
    // From the dialer after a call (it sends the number dialled), the opt-out is also written to the
    // card's call history, so it counts as that call's outcome. An exclusion made anywhere else (no
    // number dialled) stays a suppression only and is never counted as a call attempt.
    const d=dialledNumber(dialled),stamp=new Date().toISOString();
    return {...previous,revision:previous.revision+1,suppressions:[...new Set([...previous.suppressions,email])],records:previous.records.map(r=>r.recipient===email?{...r,status:'suppressed',...(d?{callHistory:[...(r.callHistory||[]),{outcome:'suppress',notes:String(notes||'').slice(0,4000),at:stamp,caller:callerIdentity,nextCallAt:null,dialled:d}]}:{})}:r)};
  }
  throw Error('Unknown action');
}

// Call access is separate from sales ownership and commission permissions.
export function canUseCallQueue(rep) {
  // Milton, 2026-10-22, on the Spearhead page: "I am ready to call but no leads." He was seeing
  // zero accounts while Paul saw twenty-one. ownerFor() returns null for anyone who is not Paul or
  // Madison, and his rep record carries role 'rep' rather than 'caller', so the queue refused him
  // and the page rendered the refusal as an empty list.
  //
  // Access now also follows the signed caller plan. That is deliberate: a hand-set role field was
  // already mis-provisioned once for this same person, and tying the call queue to the agreement
  // that says he is a caller is harder to get wrong than remembering to set a flag.
  return !!ownerFor(rep) || rep?.role === 'caller' || hasCallerPlan(rep?.email);
}
// The pool is a free-for-all until somebody works a lead. After that it is still VISIBLE to the
// whole team, with the owner and the history on the card, but it stops being offered as unclaimed
// work to anyone except the person who owns the follow-up.
export function sharedCallState(state, viewer=null) {
  const s=visibleState(state,'all');
  const me=String(viewer||'').toLowerCase();
  return {revision:s.revision,updatedAt:s.updatedAt,workerFresh:s.workerFresh,viewer:me||null,
    // A lead who booked a call is off every list, owned or not (api/_booked-leads.js); the record stays. So is a person
    // who said no or opted out (Paul, 2026-10-30: "not only being removed from our view").
    records:s.records.filter(r=>(r.callReady||r.callOwner)&&!r.booking&&r.status!=='suppressed'&&!(s.suppressions||[]).includes(r.recipient)).map(r=>{
      const callOwner=r.callOwner||null;
      const mine=!!callOwner&&String(callOwner).toLowerCase()===me;
      return {...r,callQueue:'shared',salesOwner:r.owner,callOwner,callOwnerAt:r.callOwnerAt||null,
        // claimed: somebody owns the follow-up. unclaimed work is what a caller should be handed next.
        claimed:!!callOwner,mine,
        // A paused campaign's unworked cards are nobody's next call (api/_campaign-pause.js).
        unclaimed:!!r.callReady&&!callOwner&&!campaignPaused(r),
        // An owned card on a paused campaign keeps its owner, history and promised time, but is not due work:
        // it sits in the Paused area (PM, 2026-10-27: "Milton shouldn't start tomorrow on old REP callbacks").
        dueForMe:!!r.callReady&&mine&&!campaignPaused(r),
        pausedFollowUp:!!r.callReady&&mine&&campaignPaused(r)};
    })};
}

// The queue payload is 7.9 MB uncompressed: 2 MB of email bodies on events, 900 KB of draft copy,
// 730 KB of send receipts, 550 KB of creation logs. Today and the scoreboard read none of it; they
// count sends, replies and callable rows. Paul, 2026-10-22: "its deathly slow between tabs".
//
// This strips what those pages never read and keeps every field they do, so a count on a slim
// page is the same count the Inbox shows. The Inbox and the dialer still take the full record,
// because they show the mail itself.
export const SLIM_EVENT = e => ({ id: e.id, kind: e.kind, at: e.at, from: e.from, to: e.to, subject: e.subject });
export function slimState(state, now = Date.now()) {
  // No page reads assignments (234 KB) or the creation log; the worker owns both.
  const { sends, creations, assignments, ...rest } = state;
  // Receipts are read for "today" only; three ET days covers a page left open across midnight.
  const day = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
  const since = day(now - 2 * 86400000);
  return { ...rest,
    sends: (sends || []).filter(s => s && s.status === 'verified' && String(s.day || '') >= since).map(s => ({ status: s.status, day: s.day, sender: s.sender })),
    records: (state.records || []).map(r => {
      const { bodyText, followupBodies, followupSubjects, source, emailVerification: ev, sendWindow: sw, prospectTimezone, creations: _c, ...keep } = r;
      return { ...keep,
        // The Inbox opens the draft and the mail on demand through ?record=<id>; this says there is one.
        hasDraft: !!bodyText,
        emailVerification: ev ? { status: ev.status ?? null, reason: ev.reason ?? null, checkedAt: ev.checkedAt ?? null } : null,
        sendWindow: sw ? { nextOpenAt: sw.nextOpenAt ?? null, reason: sw.reason ?? null, timeZone: sw.timeZone ?? null } : null,
        events: (r.events || []).map(SLIM_EVENT) };
    }) };
}

// Paul, 2026-10-31: "i can probably realistically do 20 dials a day on my end, so the rest should go to the team". A caller
// with a cap gets no more never-called people once they have called that many for the first time today (Eastern); their
// own callbacks and follow-ups are never limited, and every card they leave stays in the team's pool.
export const DAILY_NEW_CAP = Object.freeze({ 'hello@gostaffify.com': 20 });
const etDay = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
/** How many people this caller called for the first time today: rows whose first call is theirs, today. */
export function newCalledToday(records, email, now = Date.now()) {
    const me = String(email || '').toLowerCase(), day = etDay(now);
    return (records || []).filter(r => { const h = ((r && r.callHistory) || [])[0]; return !!h && String(h.caller || '').toLowerCase() === me && !!h.at && etDay(Date.parse(h.at)) === day; }).length;
}
/** The call rows with the viewer's daily cap applied, and { cap, used } for the dialer to say so. */
export function capNewPeople(records, email, now = Date.now()) {
    const cap = DAILY_NEW_CAP[String(email || '').toLowerCase()];
    if (!cap) return { records, dailyNew: null };
    const used = newCalledToday(records, email, now);
    return { dailyNew: { cap, used }, records: used < cap ? records : records.map(r => (r.unclaimed && !((r.callHistory || []).length) ? { ...r, unclaimed: false, capReached: true } : r)) };
}
