import {dayKey,callReady} from './_outreach-policy.js';
export function outreachReport({state,config,health,lastRun,validated=false},now=Date.now()) {
 const day=dayKey(now), rows=state?.records||[];
 const accounts=(config?.accounts||[]).filter(a=>a.brand==='Staffify'&&a.draftEnabled);
 const checks=new Map((health?.accounts||[]).map(a=>[a.email,a]));
 const unavailable=accounts.filter(a=>checks.get(a.email)?.ok!==true).map(a=>a.email);
 const enabled=new Set(accounts.map(a=>a.email));
 const tracked=rows.filter(r=>enabled.has(r.sender));
 const fresh=!!lastRun?.finishedAt&&now-Date.parse(lastRun.finishedAt)<5*60000;
 const sent=new Set();for(const r of tracked)for(const e of r.events||[])if(e.kind==='sent'&&dayKey(e.at)===day)sent.add(r.sender+':'+e.id);
 const creations=(state?.creations||[]).filter(c=>c.day===day&&c.status==='verified');
 return {day,checkedAt:new Date(now).toISOString(),fresh,mode:!config?.enabled?'paused':config.draftingEnabled===false?'reconciliation':'drafting',validated,accounts:accounts.length,healthy:accounts.length-unavailable.length,unavailable,lastRunAt:lastRun?.finishedAt||null,lastRunStatus:lastRun?.status||'unknown',counts:{newDrafts:creations.filter(c=>c.touch===1).length,followupDrafts:creations.filter(c=>c.touch>1).length,trackedSends:sent.size,pendingDrafts:tracked.filter(r=>r.status==='draft_saved').length,replyHolds:tracked.filter(r=>['human_reply_hold','held_reply'].includes(r.status)).length,callReady:tracked.filter(r=>callReady(r)&&!state.pausedOwners?.includes(r.owner)&&!state.suppressions?.includes(r.recipient)).length},coverage:'Counts cover tracked Staffify outreach only; unavailable mailboxes may be incomplete.',hubUrl:'https://www.gostaffify.com/outreach-review/'};
}
