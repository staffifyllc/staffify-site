// Stable call order: due callbacks first, then the oldest fourth-email handoff.
export function orderCallQueue(records,{campaign,owner='all',search='',research=false}={}){
 const candidate=r=>['business_listed','available'].includes(r.callContact?.phoneStatus)&&!!r.callContact?.phone;
 const time=r=>{const n=Date.parse(r.nextCallAt||r.lastSentAt||'');return Number.isFinite(n)?n:Number.MAX_SAFE_INTEGER;};
 return records.filter(r=>(!campaign||campaign==='all'||r.campaignId===campaign)&&r.callReady&&(owner==='all'||r.owner===owner)&&(research?!candidate(r):candidate(r))&&(!search||[r.company,r.recipient,r.callContact?.phone].join(' ').toLowerCase().includes(search.toLowerCase())))
 .sort((a,b)=>Number(b.callContact?.phoneStatus==='business_listed')-Number(a.callContact?.phoneStatus==='business_listed')||Number(!!b.nextCallAt)-Number(!!a.nextCallAt)||time(a)-time(b)||String(a.id).localeCompare(String(b.id)));
}
