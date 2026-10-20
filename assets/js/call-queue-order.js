// Stable call order: due callbacks first, then the oldest fourth-email handoff.
export function orderCallQueue(records,{campaign,owner='all',search='',research=false}={}){
 // A vendor direct dial counts as dialable. It sorts BELOW a number published on the business's
 // own site, because that one is corroborated and this one is a vendor's claim.
 const candidate=r=>['business_listed','available','vendor_direct'].includes(r.callContact?.phoneStatus)&&!!r.callContact?.phone;
 const time=r=>{const n=Date.parse(r.nextCallAt||r.lastSentAt||'');return Number.isFinite(n)?n:Number.MAX_SAFE_INTEGER;};
 // Work offered to THIS caller: anything nobody has worked yet, plus the follow-ups they own.
 // A lead another teammate claimed stays visible on the board but is never handed out as work.
 // Records without the claim fields (the non-shared view, or older data) fall back to callReady.
 const offered=r=>('unclaimed' in r||'dueForMe' in r)?(r.unclaimed||r.dueForMe):r.callReady;
 return records.filter(r=>(!campaign||campaign==='all'||r.campaignId===campaign)&&offered(r)&&(owner==='all'||r.owner===owner)&&(research?!candidate(r):candidate(r))&&(!search||[r.company,r.recipient,r.callContact?.phone].join(' ').toLowerCase().includes(search.toLowerCase())))
 .sort((a,b)=>Number(b.callContact?.phoneStatus==='business_listed')-Number(a.callContact?.phoneStatus==='business_listed')||Number(!!b.nextCallAt)-Number(!!a.nextCallAt)||time(a)-time(b)||String(a.id).localeCompare(String(b.id)));
}
