const HUB='https://www.gostaffify.com/outreach-review/';
const age=(v,now)=>v&&Number.isFinite(Date.parse(v))?now-Date.parse(v):Infinity;
export function incidents({cfg,run,health,prep},now=Date.now()){
 if(!cfg.enabled)return [];
 const issues=[];
 if(age(run?.finishedAt,now)>15*60000)issues.push({id:'worker-overdue',title:'Outreach checks are overdue',impact:'Sending and reply checks may not be progressing.',action:'Check the cloud worker schedule and execution logs.'});
 else if(run?.status==='error')issues.push({id:'worker-error',title:'Outreach worker failed',impact:'This run did not finish. The next scheduled run will retry safe operations.',action:'Open the Hub and inspect the last-run failure.'});
 const failed=(health?.accounts||[]).filter(a=>!a.ok).map(a=>a.email).sort();
 if(failed.length)issues.push({id:'mailbox-access',title:'Mailbox connection needs attention',impact:'New introductions are paused because complete mailbox history is unavailable.',action:'Reconnect the affected mailboxes in the Hub.',accounts:failed});
 if(cfg.draftingEnabled!==false){
 if(age(prep?.finishedAt||prep?.startedAt,now)>20*60000)issues.push({id:'prep-overdue',title:'Lead preparation is overdue',impact:'The existing-contact queue is not being refreshed.',action:'Check the lead-preparation schedule and execution logs.'});
 else if(['error','provider_unavailable'].includes(prep?.status))issues.push({id:'prep-error',title:'Lead preparation is blocked',impact:'New eligible contacts may not reach the outreach queue.',action:'Check CRM access and Findymail availability or remaining credits in the Hub.'});
 }
 if(run?.dealFollowupError)issues.push({id:'deal-followups',title:'Deal follow-up preparation failed',impact:'Existing-deal follow-ups may be delayed.',action:'Check the CRM integration and worker failure details.'});
 return issues;
}
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function alertText(issue,recovery=false){
 if(recovery)return ':white_check_mark: *Staffify recovered*\n'+escape(issue.title)+' has cleared.\n<'+HUB+'|Open Sales Hub>';
 return ':warning: *Staffify needs attention*\n*'+escape(issue.title)+'*\n*Impact:* '+escape(issue.impact)+'\n*Next step:* '+escape(issue.action)+(issue.accounts?.length?'\n*Mailboxes:* '+issue.accounts.map(escape).join(', '):'')+'\n<'+HUB+'|Open Sales Hub>';
}
export async function checkAlerts({redis,notify,snapshot,now=Date.now()}){
 const key='staffify:alerts:incidents',previous=await redis.get(key)||{},active=incidents(snapshot,now),current={},deliveries=[];
 for(const issue of active){const old=previous[issue.id]||{},entry={...old,issue,count:(old.count||0)+1,firstSeen:old.firstSeen||now};
 if(entry.count>=2&&(!old.deliveredAt||now-old.deliveredAt>=6*3600000)){const result=await notify(alertText(issue));deliveries.push({id:issue.id,...result});if(result.ok)entry.deliveredAt=now;}current[issue.id]=entry;
 }
 if(snapshot.cfg.enabled){for(const [id,old] of Object.entries(previous))if(!current[id]&&old.deliveredAt){const result=await notify(alertText(old.issue,true));deliveries.push({id,recovery:true,...result});if(!result.ok)current[id]=old;}}
 else Object.assign(current,previous);
 await redis.set(key,current);const status={checkedAt:new Date(now).toISOString(),active:active.map(i=>({id:i.id,title:i.title})),deliveries};await redis.set('staffify:alerts:last-run',status);return status;
}
