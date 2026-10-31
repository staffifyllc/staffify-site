import {withCallPhones} from './_outreach-call-phones.js';
import {hubspotRequest} from './_outreach-hubspot.js';
import { redis, requireAccess, adminAuthorized, SITE, readBody } from './_auth.js';
import {config,access,gmail,compactMessage} from './_outreach-gmail.js';
import {KEY,ownerFor,visibleState,mergeSnapshot,controlState,canUseCallQueue,sharedCallState,slimState,capNewPeople} from './_outreach-queue.js';
import {enrolInNurture} from './_nurture-enrol.js';
import {scheduleCallbackTask} from './_callback-task.js';
import {markBad} from './_bad-numbers.js';
import {ATTEMPTS} from './_number-research.js';
import {listTasks,addTask,completeTask} from './_rep-tasks.js';
import {classified} from './_campaigns-model.js';
import {recordActivity} from './_hub-activity.js';
import {gateFor,withheldNumbers} from './_shift.js';
import {poolPaused} from './_campaign-pause.js';
import {INDUSTRY_KEY} from './_campaign-industry.js';
import {hiringCallRows,getRecord} from './_hiring-intent.js';
import {HIRING_DRIP_ID} from './_hiring-drip-campaign.js';
import {isHiringId,saveHiringOutcome,saveHiringContactEmail,stopHiringCards} from './_hiring-calls.js';
import {optOutEverywhere} from './_optout.js';
const CAS = `local raw=redis.call('GET',KEYS[1]); local rev=0; if raw then rev=cjson.decode(raw).revision or 0 end; if rev~=tonumber(ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1`;
export default async function handler(req,res) {
  res.setHeader('Cache-Control','private, no-store');
  try {
    const rep=await requireAccess(req);const calls=req.query?.view==='calls';const slim=req.query?.view==='slim'||calls;const owner=calls&&canUseCallQueue(rep)?'all':ownerFor(rep);
    const view=s=>calls?sharedCallState(s,rep.email):visibleState(s,owner);
    if(!owner)return res.status(401).json({error:'Sign in with your Staffify account'});
    const state=await redis.get(KEY);
    const crm=async(path,body)=>{const response=await hubspotRequest('https://api.hubapi.com'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+process.env.HUBSPOT_TOKEN,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined},{redis});if(!response.ok)throw Error('CRM unavailable');return response.json();};
    // The list a page reads: the queue for this viewer and, on the calls view, the caller's tasks,
    // the Hiring now cards and the shift gate. The dialer gets this same answer back after a save.
    const listView=async(s=state)=>{
      const decorated=await withCallPhones(view(s),{redis,crm});
      // view=slim: the same rows and the same callReady, without the mail bodies. See slimState.
      const out=slim?slimState(decorated):decorated;
      // The caller's own tasks ride along with the call view, so the dialer's follow-up list is
      // one read: callbacks from the records, tasks from here.
      if(calls){
       // Each card carries the industry the Campaigns page shows for it, so a queue opened from an
       // industry there is that industry here. Same classifier, same stated overrides.
       const stated=(await redis.hgetall(INDUSTRY_KEY).catch(()=>null))||{};
       out.records=classified(out.records,stated).map(({r,v})=>({...r,industry:v&&v.key?{key:v.key,label:v.label,source:v.source}:null}));
       // A card from a paused industry (real estate media) is out of the unworked pool on any campaign;
       // one a caller already owns stays theirs (api/_campaign-pause.js).
       out.records=out.records.map(r=>!poolPaused(r)?r:r.unclaimed?{...r,unclaimed:false,pausedFromPool:true}:r.dueForMe?{...r,dueForMe:false,pausedFollowUp:true}:r);
       // Hiring now (api/_hiring-intent.js): call-first cards from their own store, in the same shape, so
       // the shift gate below, the holds, the search and the outcome buttons treat them like any card.
       // A hiring store that cannot be read costs the hiring cards, never the rest of the queue.
       // Each card carries its Hiring now drip row's state, so the caller sees the emails going out (api/_hiring-drip-copy.js).
       const drips=new Map(((s&&s.records)||[]).filter(r=>r.campaignId===HIRING_DRIP_ID&&r.hiringId).map(r=>[r.hiringId,{status:r.status,sentTouches:r.sentTouches||0,lastSentAt:r.lastSentAt||null,nextEligibleAt:r.nextEligibleAt||null,replyReceivedAt:r.replyReceivedAt||null,sender:r.sender||null,copied:!!r.lastSentCopied}]));
       out.records=[...(await hiringCallRows(redis,rep.email).catch(()=>[])).map(r=>drips.has(r.id)?{...r,drip:drips.get(r.id)}:r),...out.records];
       // A caller's daily cap on new people (Paul: 20), after every card is in, so it counts all campaigns.
       {const capped=capNewPeople(out.records,rep.email);out.records=capped.records;out.dailyNew=capped.dailyNew;}
       // A task for someone who said no is not work any more: their card left the list, so the task goes with it.
       const closed=async t=>{if(!t||!t.recordId)return false;if(isHiringId(t.recordId)){const c=await getRecord(redis,t.recordId).catch(()=>null);return !!c&&['suppressed','excluded'].includes(c.status);}
        const row=((s&&s.records)||[]).find(x=>x.id===t.recordId);return !!row&&(row.status==='suppressed'||((s&&s.suppressions)||[]).includes(row.recipient));};
       const tasks=await listTasks(redis,rep.email);
       out.tasks=(await Promise.all(tasks.map(async t=>(await closed(t))?null:t))).filter(Boolean);
       // An owner (Paul) is not a caller: the dialer opens on their own follow-ups and keeps the team's pool
       // one click away (Paul, 2026-10-27: "if my guys are already doing it I shouldn't be").
       out.viewerOwner=!!ownerFor(rep);
       // The shift gate, here too: a caller off shift gets the queue in its real order, but every
       // number reads "withheld" until the shift is running. An unreadable shift reads as off.
       const g=await gateFor(redis,rep,ownerFor);
       out.shiftGate=g;
       if(!g.allowed)out.records=withheldNumbers(out.records);
      }
      return out;
    };
    if(req.method==='GET'){
      // One full record, for a page that lists slim rows and opens the mail on demand. Scoped by the
      // same view as the list, so nobody reads a thread outside what their list would show. No phone
      // ladder: a body does not need a number.
      if(req.query?.record){const id=String(req.query.record);const row=view(state).records.find(r=>r.id===id);
       if(!row)return res.status(404).json({error:'That record is not in your view of the queue'});
       if(calls&&!(await gateFor(redis,rep,ownerFor)).allowed)return res.status(200).json({record:withheldNumbers([row])[0]});
       return res.status(200).json({record:row});}
      return res.status(200).json(await listView());
    }
    if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
    const machine=adminAuthorized(req);
    if(!machine&&req.headers.origin!==SITE)return res.status(403).json({error:'Invalid origin'});
    const body=readBody(req);
    if(calls&&!['call-outcome','suppress','task-add','task-done','contact-email'].includes(body.action))return res.status(403).json({error:'Caller access is limited to call outcomes, exclusions, their own tasks and an email a prospect gave them'});
    // A rep's own tasks never touch the queue state, so they skip the revision dance below.
    if(body.action==='task-add'){const r=await addTask(redis,{rep,title:body.title,dueAt:body.dueAt,notes:body.notes,recordId:body.id||null,company:body.company||'',recipient:body.recipient||null,campaignId:body.campaignId||null,contactId:body.contactId||null});if(r.ok)await recordActivity(redis,{email:rep.email,kind:'task_added',page:'/dialer/',detail:r.task.company||null});return res.status(r.ok?200:400).json(r);}
    if(body.action==='task-done'){const r=await completeTask(redis,{email:rep.email,id:String(body.taskId||''),done:body.done!==false});if(r.ok&&body.done!==false)await recordActivity(redis,{email:rep.email,kind:'task_done',page:'/dialer/',detail:r.task&&r.task.company||null});return res.status(r.ok?200:404).json(r);}
    // A Hiring now card is saved to its own store (api/_hiring-calls.js), then the dialer gets the same
    // list view back that a reload would give it.
    // An address a Hiring now prospect gave on the call (api/_hiring-calls.js saveHiringContactEmail).
    if(calls&&body.action==='contact-email'){
      if(!isHiringId(body.id))return res.status(400).json({error:'Only a Hiring now card takes an address here'});
      const r=await saveHiringContactEmail(redis,{rep,body});
      if(!r.ok)return res.status(r.status||409).json({error:r.error});
      return res.status(200).json({...await listView(),contactEmail:r.email});
    }
    if(calls&&['call-outcome','suppress'].includes(body.action)&&isHiringId(body.id)){
      const r=await saveHiringOutcome(redis,{rep,body});
      if(!r.ok)return res.status(r.status||409).json({error:r.error});
      return res.status(200).json({...await listView(),...(r.callbackTask?{callbackTask:r.callbackTask}:{}),...(r.wrongNumber?{wrongNumber:r.wrongNumber}:{})});
    }
    // A stop is taken on anyone in the queue a caller can find, not only a card that is due: a no on an early callback,
    // after Connected, or on a finished sequence is still a no (Paul, 2026-10-30).
    if(calls&&!(body.action==='suppress'?(state?.records||[]).some(r=>r.recipient===String(body.email||'').toLowerCase()):sharedCallState(state,rep.email).records.some(r=>r.id===body.id)))return res.status(409).json({error:'This prospect is no longer in the call queue'});
    // A caller action is the one write a HUMAN makes here, and typing call notes takes longer than
    // a minute. The outreach worker rewrites this key every minute and saves up to sixteen times a
    // run, so a whole-queue revision check guaranteed the caller lost the race and could never
    // record the call. For these actions the meaningful conflict is the RECORD, which controlState
    // re-validates on every attempt (still due, not suppressed, not paused), so re-read and
    // re-apply rather than bouncing the person who is on the phone.
    // One-off repair (PM acceptance check, 2026-10-27). The worker's empty-recipient bug (fixed in
    // _outreach-worker-core.js) held Talent network rows as bounces though no address existed and nothing
    // was sent. Machine only, the exact proven predicate, a dry run unless write:true, and refused unless
    // the count matches the one proven. The rows go back to contact research with the old values on them.
    if(body.action==='repair-empty-recipient-bounces'){
      if(!machine)return res.status(403).json({error:'Worker authorization required'});
      const mid=String(body.replyMessageId||''),expected=Number(body.expected);
      if(!/^[0-9a-f]{12,20}$/.test(mid)||!Number.isInteger(expected))return res.status(400).json({error:'replyMessageId and expected count required'});
      const proven=r=>r.campaignId==='staffify-talent-network-outreach'&&r.status==='bounce_hold'&&!r.recipient&&!Number(r.sentTouches||0)&&!Number(r.verifiedSentTouches||0)&&r.replyMessageId===mid;
      for(let attempt=0;attempt<6;attempt++){
        const fresh=attempt?await redis.get(KEY):state;
        const hits=(fresh?.records||[]).filter(proven);
        const report={found:hits.length,expected,bounceHoldTotal:(fresh?.records||[]).filter(r=>r.status==='bounce_hold').length,ids:hits.map(r=>r.id)};
        if(body.write!==true)return res.status(200).json({dry:true,...report});
        if(hits.length!==expected)return res.status(409).json({error:'Count does not match the proven set; nothing changed',...report});
        const at=new Date().toISOString(),ids=new Set(report.ids);
        const candidate={...fresh,revision:(fresh.revision||0)+1,records:fresh.records.map(r=>{if(!ids.has(r.id))return r;const {replyMessageId,replyReceivedAt,...rest}=r;return {...rest,status:'contact_research_hold',bounceHoldCleared:{at,why:'Held by the empty-recipient bug: no address, nothing sent, matched one mailer-daemon message',was:{status:r.status,replyMessageId,replyReceivedAt:replyReceivedAt||null}}};})};
        if(Number(await redis.eval(CAS,[KEY],[String(fresh?.revision||0),JSON.stringify(candidate)]))===1)return res.status(200).json({restored:hits.length,...report});
      }
      return res.status(409).json({error:'The queue is busy; nothing changed. Try again.'});
    }
    const callerAction=['call-outcome','suppress'].includes(body.action);
    if(!callerAction&&body.expectedRevision!==(state?.revision||0))return res.status(409).json({error:'Queue changed; reload before retrying'});
    if(callerAction) {
      for(let attempt=0;attempt<6;attempt++) {
        const fresh=attempt?await redis.get(KEY):state;
        // Re-validated against the freshly read queue, so a lead suppressed or already handled
        // between attempts is refused rather than written over.
        const candidate=controlState(fresh,body,owner,rep.email);
        if(Number(await redis.eval(CAS,[KEY],[String(fresh?.revision||0),JSON.stringify(candidate)]))===1) {
          // "Not now, try me next quarter" is a warm lead with a date on it. The caller just put
          // it in writing, so the drip picks it up from here. Strictly after the disposition is
          // safely saved, and never allowed to fail the save: enrolInNurture swallows its own
          // errors and the gates live inside it.
          // The event log: a call outcome, notes if any were written, a callback if one was set.
          if(body.action==='call-outcome'){const row=(fresh?.records||[]).find(r=>r.id===body.id);const co=row&&row.company||null;
           await recordActivity(redis,{email:rep.email,kind:'call_outcome',page:'/dialer/',detail:[co,body.outcome].filter(Boolean).join(' · ')});
           if(String(body.notes||'').trim())await recordActivity(redis,{email:rep.email,kind:'note_saved',page:'/dialer/',detail:co});
           if(body.outcome==='callback'&&body.nextCallAt)await recordActivity(redis,{email:rep.email,kind:'callback_set',page:'/dialer/',detail:co});}
          if(body.action==='suppress')await recordActivity(redis,{email:rep.email,kind:'suppress',page:'/dialer/',detail:null});
          // Straight onto the global stop list (email and the number they answered on, with the CRM marked do not contact),
          // not a minute later from the worker, and off the call list as a Hiring now card too. Never fails the save.
          let stopped=null;
          if(body.action==='suppress'){const email=String(body.email||'').toLowerCase();
           stopped=await optOutEverywhere({email,phone:String(body.dialled||'').replace(/\D/g,'').length>=10?body.dialled:null,reason:'Not interested / stop on a call',source:'hub-dialer',text:String(body.notes||'').slice(0,200)}).catch(()=>({ok:false}));
           await stopHiringCards(redis,{email},{why:'Not interested / stop on a call',by:rep.email}).catch(()=>{});}
          let nurture=null;
          if(body.action==='call-outcome'&&body.outcome==='timing') {
            const row=(fresh?.records||[]).find(r=>r.id===body.id);
            if(row)nurture=await enrolInNurture({redis,email:row.recipient,name:row.verifiedFirstName||'',
              company:row.company||'',caller:rep.email,campaignId:row.campaignId||''});
          }
          // A callback becomes a CRM task with a reminder, owned by the caller. Same rule as the
          // nurture above: only after the save landed, and it can never fail the save.
          let callbackTask=null;
          if(body.action==='call-outcome'&&(body.outcome==='callback'||body.outcome==='gatekeeper')&&body.nextCallAt) {
            const row=(fresh?.records||[]).find(r=>r.id===body.id);
            if(row)callbackTask=await scheduleCallbackTask({redis,row,rep,nextCallAt:body.nextCallAt,notes:body.notes});
          }
          // A wrong number condemns the NUMBER, not the lead. The dialled number is marked bad for
          // this person only, and only if it really was one we had on file for them, then their
          // research is reset so the background pass looks for a different one.
          let wrongNumber=null;
          if(body.action==='call-outcome'&&body.outcome==='wrong_number'&&body.dialled) {
            const row=(fresh?.records||[]).find(r=>r.id===body.id);
            if(row){
              const e=row.recipient.toLowerCase();
              const [ev,vd,st,cp]=await Promise.all(['staffify:call-phone-evidence:'+row.recipient,'staffify:call-phone-vendor:'+e,'staffify:call-site-phone:'+e,'staffify:call-phone:'+e].map(k=>redis.get(k).catch(()=>null)));
              const known=[ev&&ev.phone,vd&&vd.phone,...((vd&&vd.alternates)||[]),st&&st.phone,...((st&&st.alternates)||[]),cp&&cp.phone,row.phone].filter(Boolean);
              wrongNumber=await markBad(redis,{email:e,phone:body.dialled,known,by:rep.email});
              if(wrongNumber.ok)await redis.del(ATTEMPTS(e)).catch(()=>{});
            }
          }
          // The dialer's whole list comes back, Hiring now cards and shift gate included, as a reload would give it.
          const listed=calls?await listView(candidate):(slim?slimState(view(candidate)):view(candidate));
          return res.status(200).json({...listed,...(nurture?{nurture}:{}),...(callbackTask?{callbackTask}:{}),...(wrongNumber?{wrongNumber}:{}),...(stopped?{optOut:stopped}:{})});
        }
      }
      return res.status(409).json({error:'The queue is busy right now. Your notes are still here; press save again.'});
    }
    let next;
    if(body.action==='refresh-history') {
      if(!machine)return res.status(403).json({error:'Worker authorization required'});
      const row=state.records.find(r=>r.id===body.id);
      const cfg=await config();
      if(!row?.threadId||!cfg.accounts.some(a=>a.email===row.sender&&a.brand==='Staffify'&&a.draftEnabled))return res.status(400).json({error:'Connected Staffify conversation required'});
      const thread=await gmail(await access(row.sender),'threads/'+encodeURIComponent(row.threadId)+'?format=full');
      const messages=new Map((thread.messages||[]).map(m=>[m.id,m]));
      const evidence=m=>{const types=[];const walk=p=>{if(!p||p.filename)return;if(p.body?.data)types.push(p.mimeType);for(const c of p.parts||[])walk(c);};walk(m.payload);return {rootType:m.payload?.mimeType,bodyTypes:types,readerVersion:2};};
      next={...state,revision:state.revision+1,queueUpdatedAt:new Date().toISOString(),records:state.records.map(r=>r.id!==row.id?r:{...r,events:(r.events||[]).map(e=>{const m=messages.get(e.id);return m?{...e,body:compactMessage(m,row.sender).text,bodyMimeEvidence:evidence(m)}:e;})})};
    } else if(body.action==='sync') {
      if(!machine)return res.status(403).json({error:'Worker authorization required'});
      if((await config()).enabled)return res.status(409).json({error:'Hosted worker owns the queue; local snapshot writes are disabled'});
      next=mergeSnapshot(state,body);
    } else next=controlState(state,body,owner,rep.email);
    const saved=await redis.eval(CAS,[KEY],[String(state?.revision||0),JSON.stringify(next)]);
    if(Number(saved)!==1)return res.status(409).json({error:'Queue changed; reload before retrying'});
    return res.status(200).json(slim?slimState(view(next)):view(next));
  } catch(e) {return res.status(503).json({error:'Queue unavailable; no action completed'});}
}
