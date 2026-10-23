import {researchPace} from './_research-pace.js';
const HUB='https://www.gostaffify.com/outreach-review/';
const age=(v,now)=>v&&Number.isFinite(Date.parse(v))?now-Date.parse(v):Infinity;
export function incidents({cfg,run,health,prep,companyPrep,companyHistory},now=Date.now()){
 if(!cfg.enabled)return [];
 const issues=[];
 if(age(run?.finishedAt,now)>15*60000)issues.push({id:'worker-overdue',title:'Outreach checks are overdue',impact:'Sending and reply checks may not be progressing.',action:'Check the cloud worker schedule and execution logs.'});
 else if(run?.status==='error')issues.push({id:'worker-error',title:'Outreach worker failed',impact:'This run did not finish. The next scheduled run will retry safe operations.',action:'Open the Hub and inspect the last-run failure.'});
 const failed=(health?.accounts||[]).filter(a=>!a.ok).map(a=>a.email).sort();
 if(failed.length)issues.push({id:'mailbox-access',title:'Mailbox connection needs attention',impact:'New introductions are paused because complete mailbox history is unavailable.',action:'Reconnect the affected mailboxes in the Hub.',accounts:failed});
 if(cfg.draftingEnabled!==false){
 if(companyPrep&&age(companyPrep.finishedAt||companyPrep.startedAt,now)>30*60000)issues.push({id:'company-prep-overdue',title:'Saved-company research is overdue',impact:'Previously researched companies are not progressing toward verified contacts.',action:'Check the cloud company-research schedule and the Campaigns page.'});
 else if(['error','needs_attention'].includes(companyPrep?.status))issues.push({id:'company-prep-error',title:'Saved-company research is blocked',impact:companyPrep.reason||'Company research did not complete.',action:'Check the research connection and included search balance in Campaigns.'});
 
 const pace=researchPace(companyHistory,now);
 if(pace.status==='behind')issues.push({id:'research-pace',title:'Included search usage is behind pace',impact:`Provider usage is running at ${pace.dailyRate}/day; ${pace.requiredDailyTarget}/day is needed before renewal.`,action:'Check saved-company outcomes and remaining research capacity in Campaigns.'});
 if(companyPrep?.existingPoolExhausted&&companyPrep?.budget?.remaining>0)issues.push({id:'research-pool-exhausted',title:'Saved-company research list is exhausted',impact:'Included searches remain but the existing list has been processed.',action:'Review unresolved companies and the next qualified prospect pool before renewal.'});
 if(age(prep?.finishedAt||prep?.startedAt,now)>20*60000)issues.push({id:'prep-overdue',title:'Lead preparation is overdue',impact:'The existing-contact queue is not being refreshed.',action:'Check the lead-preparation schedule and execution logs.'});
 else if(['error','provider_unavailable','retrying'].includes(prep?.status))issues.push({id:'prep-error',title:'Lead preparation is blocked',impact:'New eligible contacts may not reach the outreach queue.',action:'Check CRM access and Findymail availability or remaining credits in the Hub.'});
 }
 if(run?.dealFollowupError)issues.push({id:'deal-followups',title:'Deal follow-up preparation failed',impact:'Existing-deal follow-ups may be delayed.',action:'Check the CRM integration and worker failure details.'});
 return issues;
}
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function alertText(issue,recovery=false){
 if(recovery)return ':white_check_mark: *Staffify recovered*\n'+escape(issue.title)+' has cleared.\n<'+HUB+'|Open Sales Hub>';
 return ':warning: *Staffify needs attention*\n*'+escape(issue.title)+'*\n*Impact:* '+escape(issue.impact)+'\n*Next step:* '+escape(issue.action)+(issue.accounts?.length?'\n*Mailboxes:* '+issue.accounts.map(escape).join(', '):'')+'\n<'+HUB+'|Open Sales Hub>';
}
// Cadence. On 2026-10-22 Findymail flapped between "retrying" and fine every half hour and this
// posted "blocked" / "recovered" twenty times in a day into the channel Paul reads leads in. Paul,
// 2026-10-23: "a shit show with irrelevant information". So: an incident is reported once it has
// held for thirty minutes, it is repeated at most once a day while it stands, and that quiet period
// is remembered PAST a recovery, so a thing that clears and re-trips an hour later says nothing new.
export const SETTLE_MS=30*60000, REMIND_MS=24*3600000;
export async function checkAlerts({redis,notify,snapshot,now=Date.now()}){
 const key='staffify:alerts:incidents',quietKey='staffify:alerts:quiet';
 const previous=await redis.get(key)||{},quiet=await redis.get(quietKey)||{},active=incidents(snapshot,now),current={},deliveries=[];
 for(const issue of active){const old=previous[issue.id]||{},entry={...old,issue,count:(old.count||0)+1,firstSeen:old.firstSeen||now};
 if(now-entry.firstSeen>=SETTLE_MS&&(!quiet[issue.id]||now-quiet[issue.id]>=REMIND_MS)){const result=await notify(alertText(issue));deliveries.push({id:issue.id,...result});if(result.ok){entry.deliveredAt=now;quiet[issue.id]=now;}}current[issue.id]=entry;
 }
 // A recovery is only news for an incident somebody was told about.
 if(snapshot.cfg.enabled){for(const [id,old] of Object.entries(previous))if(!current[id]&&old.deliveredAt){const result=await notify(alertText(old.issue,true));deliveries.push({id,recovery:true,...result});if(!result.ok)current[id]=old;}}
 else Object.assign(current,previous);
 await redis.set(key,current);await redis.set(quietKey,quiet);const status={checkedAt:new Date(now).toISOString(),active:active.map(i=>({id:i.id,title:i.title})),deliveries};await redis.set('staffify:alerts:last-run',status);return status;
}
