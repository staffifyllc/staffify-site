// The call order, decided by what happened on the last call.
// ------------------------------------------------------------------
// Paul, 2026-10-27: "every time he logs in, it just shows one out of 784 contacts. So it's not like
// keeping any memory of who he's called ... The people that he's calling, they need to be moving to
// the back or wherever they need to move based on the outcome of these calls, because he's just
// going to keep calling the same people over and over."
//
// The order used to put any card with a next-call time AHEAD of cards nobody had called, so every
// no-answer from yesterday came back on top the next day. Milton set most no-answers to "tomorrow",
// worked about 33 dials a day, and spent most of each shift on the same 25 people while 784 callable
// leads waited. Now each card's place comes from its last outcome:
//   1. callbacks that have come due      a person asked to be called then; oldest promise first
//   2. "not now" that has come due       they said later, and later is here
//   3. leads nobody has called yet       numbers published on their own website first, then the
//                                        rest; oldest fourth email first (a new number found after
//                                        a wrong number counts as new: nobody has rung it)
//   4. no answer and voicemail           at the back: fewest tries first, then longest since tried
// Wrong number, not interested and conversations never reach this list: the server's callReady
// keeps them out. Nothing here changes an outcome or a callback time; it only sets the order.
const DIALABLE=['business_listed','available','vendor_direct','site_main','crm_unconfirmed'];
const ms=s=>{const n=Date.parse(s||'');return Number.isFinite(n)?n:null;};
const attempts=r=>(r.callHistory||[]).filter(c=>c&&c.at&&(c.outcome==='no_answer'||c.outcome==='voicemail')).length;
const lastTried=r=>Math.max(0,...(r.callHistory||[]).map(c=>ms(c&&c.at)||0));

/** Which part of the queue a card is in, from its last outcome. */
export function queueGroup(r,now=Date.now()){
 const due=ms(r.nextCallAt)!==null&&ms(r.nextCallAt)<=now;
 if(r.callOutcome==='callback'&&due)return 'callback';
 if(r.callOutcome==='timing'&&due)return 'later';
 if(r.callOutcome==='no_answer'||r.callOutcome==='voicemail')return 'retry';
 return 'new';
}
const RANK={callback:0,later:1,new:2,retry:3};

/** How the offered queue splits, for the bar: callbacks due, new leads, and people to try again. */
export function queueMix(list,now=Date.now()){
 const m={callback:0,later:0,new:0,retry:0};for(const r of list)m[queueGroup(r,now)]++;return m;
}

export function orderCallQueue(records,{campaign,owner='all',search='',research=false,industry='',now=Date.now()}={}){
 // Paul, 2026-10-23: a queue opened from an industry on the Campaigns page must be THAT industry.
 const inIndustry=r=>!industry||industry==='all'||(r.industry&&r.industry.key===industry);
 // EVERY status the phone ladder can hand a caller, or the card never reaches them. On 2026-10-22
 // the ladder gained site_main (a main line published on their own site) and crm_unconfirmed (a CRM
 // number not found on their site), and this list did not: the six Spearhead numbers pulled off
 // company websites that day were filtered out of the queue they had just been found for.
 const candidate=r=>DIALABLE.includes(r.callContact?.phoneStatus)&&!!r.callContact?.phone;
 // Work offered to THIS caller: anything nobody has worked yet, plus the follow-ups they own.
 // A lead another teammate claimed stays visible on the board but is never handed out as work.
 // Records without the claim fields (the non-shared view, or older data) fall back to callReady.
 const offered=r=>('unclaimed' in r||'dueForMe' in r)?(r.unclaimed||r.dueForMe):r.callReady;
 const listed=r=>Number(r.callContact?.phoneStatus==='business_listed');
 const sent=r=>ms(r.lastSentAt)??Number.MAX_SAFE_INTEGER;
 const due=r=>ms(r.nextCallAt)??Number.MAX_SAFE_INTEGER;
 const within=(a,b,g)=>{
  if(g==='callback'||g==='later')return due(a)-due(b);
  // A number published on the business's own website is corroborated; a vendor or CRM number is a claim.
  if(g==='new')return listed(b)-listed(a)||sent(a)-sent(b);
  return attempts(a)-attempts(b)||lastTried(a)-lastTried(b)||listed(b)-listed(a);
 };
 return records.filter(r=>(!campaign||campaign==='all'||r.campaignId===campaign)&&inIndustry(r)&&offered(r)&&(owner==='all'||r.owner===owner)&&(research?!candidate(r):candidate(r))&&(!search||[r.company,r.recipient,r.callContact?.phone].join(' ').toLowerCase().includes(search.toLowerCase())))
  .map(r=>({r,g:queueGroup(r,now)}))
  .sort((a,b)=>RANK[a.g]-RANK[b.g]||within(a.r,b.r,a.g)||String(a.r.id).localeCompare(String(b.r.id)))
  .map(x=>x.r);
}
