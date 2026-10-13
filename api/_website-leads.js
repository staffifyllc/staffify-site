const touches=[['day2_sent_at',7,"Start with inbox. Here's the math."],['day6_sent_at',14,'Why most first hires fail (and what works)'],['day12_sent_at',21,'60% off editing. Same quality.'],['day21_sent_at',28,"60 founder-hours, gone. Here's where they went."],['day45_sent_at',35,"Last one. Then I'm out."]];
const iso=v=>v&&Number.isFinite(Number(v))?new Date(Number(v)).toISOString():null;
export function websiteLead(rec,nurture={},suppressed=false){
 const source=String(rec.source||'unknown');const category=/test/i.test(source)?'test':/discovery-call-booked/.test(source)?'booking':'website';
 const events=[];
 if(rec.playbook_sent_at)events.push({at:iso(rec.playbook_sent_at),subject:'The 10 highest-ROI delegations, inside',type:'Playbook',evidence:'Recorded sent; delivery not independently confirmed'});
 for(const [key,day,subject] of touches)if(nurture[key])events.push({at:iso(nurture[key]),subject,type:'Nurture email',evidence:'Recorded sent; subject is the current template title'});
 events.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const state=suppressed?'Unsubscribed':nurture.graduated_at?'Stopped: '+(nurture.graduated_reason||'engaged'):rec.decision?'Decision recorded: '+rec.decision:nurture.cool_off_until?'Nurture cooldown':nurture.enrolled_at?'Nurture enrolled':'Not enrolled';
 const next=touches.find(([key])=>!nurture[key]);
 const nextAt=state==='Nurture enrolled'&&next?iso(Number(nurture.enrolled_at)+next[1]*86400000):null;
 return {email:rec.email,name:rec.first_name||'',source,category,signedUpAt:iso(rec.signed_up_at),state,events,nextAt,nextSubject:nextAt?next[2]:null,cycle:Number(nurture.cycle_count||0),cooldownUntil:iso(nurture.cool_off_until)};
}
