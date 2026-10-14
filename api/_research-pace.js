// Compare provider usage, not local attempt counters, within one billing cycle.
export function researchPace(history=[],now=Date.now()){
 const samples=history.filter(r=>r.budget&&Number.isFinite(r.budget.used)&&Number.isFinite(Date.parse(r.budget.checkedAt||r.startedAt))).map(r=>({at:Date.parse(r.budget.checkedAt||r.startedAt),b:r.budget})).filter(r=>r.at<=now&&now-r.at<=86400000).sort((a,b)=>a.at-b.at);
 const last=samples.at(-1);if(!last)return {status:'unknown'};
 const first=samples.find(r=>r.b.renewal===last.b.renewal),hours=(last.at-first.at)/3600000;
 const required=last.b.requiredDailyTarget||Math.ceil(last.b.remaining/last.b.days);
 if(hours<3||last.b.used<first.b.used)return {status:'measuring',requiredDailyTarget:required};
 const dailyRate=Math.round((last.b.used-first.b.used)*24/hours);
 return {status:last.b.remaining<=0?'complete':dailyRate<required*.8?'behind':'on_pace',dailyRate,requiredDailyTarget:required,measuredHours:Math.round(hours*10)/10};
}
