import {withCallPhones} from './_outreach-call-phones.js';
import {hubspotRequest} from './_outreach-hubspot.js';
import { redis, requireAccess, adminAuthorized, SITE, readBody } from './_auth.js';
import {config,access,gmail,compactMessage} from './_outreach-gmail.js';
import {KEY,ownerFor,visibleState,mergeSnapshot,controlState,canUseCallQueue,sharedCallState,slimState} from './_outreach-queue.js';
import {enrolInNurture} from './_nurture-enrol.js';
import {scheduleCallbackTask} from './_callback-task.js';
import {markBad} from './_bad-numbers.js';
import {ATTEMPTS} from './_number-research.js';
const CAS = `local raw=redis.call('GET',KEYS[1]); local rev=0; if raw then rev=cjson.decode(raw).revision or 0 end; if rev~=tonumber(ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1`;
export default async function handler(req,res) {
  res.setHeader('Cache-Control','private, no-store');
  try {
    const rep=await requireAccess(req);const calls=req.query?.view==='calls';const slim=req.query?.view==='slim'||calls;const owner=calls&&canUseCallQueue(rep)?'all':ownerFor(rep);
    const view=s=>calls?sharedCallState(s,rep.email):visibleState(s,owner);
    if(!owner)return res.status(401).json({error:'Sign in with your Staffify account'});
    const state=await redis.get(KEY);
    if(req.method==='GET'){
      const crm=async(path,body)=>{const response=await hubspotRequest('https://api.hubapi.com'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+process.env.HUBSPOT_TOKEN,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined},{redis});if(!response.ok)throw Error('CRM unavailable');return response.json();};
      // One full record, for a page that lists slim rows and opens the mail on demand. Scoped by the
      // same view as the list, so nobody reads a thread outside what their list would show. No phone
      // ladder: a body does not need a number.
      if(req.query?.record){const id=String(req.query.record);const row=view(state).records.find(r=>r.id===id);
       if(!row)return res.status(404).json({error:'That record is not in your view of the queue'});return res.status(200).json({record:row});}
      const decorated=await withCallPhones(view(state),{redis,crm});
      // view=slim: the same rows and the same callReady, without the mail bodies. See slimState.
      return res.status(200).json(slim?slimState(decorated):decorated);
    }
    if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
    const machine=adminAuthorized(req);
    if(!machine&&req.headers.origin!==SITE)return res.status(403).json({error:'Invalid origin'});
    const body=readBody(req);
    if(calls&&!['call-outcome','suppress'].includes(body.action))return res.status(403).json({error:'Caller access is limited to call outcomes and exclusions'});
    if(calls&&!sharedCallState(state,rep.email).records.some(r=>body.action==='suppress'?r.recipient===String(body.email||'').toLowerCase():r.id===body.id))return res.status(409).json({error:'This prospect is no longer in the call queue'});
    // A caller action is the one write a HUMAN makes here, and typing call notes takes longer than
    // a minute. The outreach worker rewrites this key every minute and saves up to sixteen times a
    // run, so a whole-queue revision check guaranteed the caller lost the race and could never
    // record the call. For these actions the meaningful conflict is the RECORD, which controlState
    // re-validates on every attempt (still due, not suppressed, not paused), so re-read and
    // re-apply rather than bouncing the person who is on the phone.
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
          let nurture=null;
          if(body.action==='call-outcome'&&body.outcome==='timing') {
            const row=(fresh?.records||[]).find(r=>r.id===body.id);
            if(row)nurture=await enrolInNurture({redis,email:row.recipient,name:row.verifiedFirstName||'',
              company:row.company||'',caller:rep.email,campaignId:row.campaignId||''});
          }
          // A callback becomes a CRM task with a reminder, owned by the caller. Same rule as the
          // nurture above: only after the save landed, and it can never fail the save.
          let callbackTask=null;
          if(body.action==='call-outcome'&&body.outcome==='callback'&&body.nextCallAt) {
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
          return res.status(200).json({...(slim?slimState(view(candidate)):view(candidate)),...(nurture?{nurture}:{}),...(callbackTask?{callbackTask}:{}),...(wrongNumber?{wrongNumber}:{})});
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
