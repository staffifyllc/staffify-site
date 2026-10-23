// Stable call order: callbacks that have come due first, then corroborated numbers, then the oldest fourth-email handoff.
export function orderCallQueue(records,{campaign,owner='all',search='',research=false}={}){
 // A vendor direct dial counts as dialable. It sorts BELOW a number published on the business's
 // own site, because that one is corroborated and this one is a vendor's claim.
 // EVERY status the phone ladder can hand a caller, or the card never reaches them. On 2026-10-22
 // the ladder gained site_main (a main line published on their own site) and crm_unconfirmed (a CRM
 // number not found on their site), and this list did not: the six Spearhead numbers pulled off
 // company websites that day were filtered out of the queue they had just been found for.
 const DIALABLE=['business_listed','available','vendor_direct','site_main','crm_unconfirmed'];
 const candidate=r=>DIALABLE.includes(r.callContact?.phoneStatus)&&!!r.callContact?.phone;
 const time=r=>{const n=Date.parse(r.nextCallAt||r.lastSentAt||'');return Number.isFinite(n)?n:Number.MAX_SAFE_INTEGER;};
 // Work offered to THIS caller: anything nobody has worked yet, plus the follow-ups they own.
 // A lead another teammate claimed stays visible on the board but is never handed out as work.
 // Records without the claim fields (the non-shared view, or older data) fall back to callReady.
 const offered=r=>('unclaimed' in r||'dueForMe' in r)?(r.unclaimed||r.dueForMe):r.callReady;
 const now=Date.now();
 const dueCallback=r=>r.callOutcome==='callback'&&Date.parse(r.nextCallAt||'')<=now;
 return records.filter(r=>(!campaign||campaign==='all'||r.campaignId===campaign)&&offered(r)&&(owner==='all'||r.owner===owner)&&(research?!candidate(r):candidate(r))&&(!search||[r.company,r.recipient,r.callContact?.phone].join(' ').toLowerCase().includes(search.toLowerCase())))
 // A callback that has come due goes first, ahead of everything. Somebody asked to be called at
 // that time, and the caller promised; Paul, 2026-10-22: "a task time to call them back that
 // reminds the sales person." The queue is the reminder that works even when the CRM's does not.
 .sort((a,b)=>Number(dueCallback(b))-Number(dueCallback(a))||(dueCallback(a)&&dueCallback(b)?time(a)-time(b):0)||Number(b.callContact?.phoneStatus==='business_listed')-Number(a.callContact?.phoneStatus==='business_listed')||Number(!!b.nextCallAt)-Number(!!a.nextCallAt)||time(a)-time(b)||String(a.id).localeCompare(String(b.id)));
}
