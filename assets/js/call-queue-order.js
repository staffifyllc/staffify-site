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
const DIALABLE=['business_listed','available','vendor_direct','site_main','listing_main','crm_unconfirmed'];
const ms=s=>{const n=Date.parse(s||'');return Number.isFinite(n)?n:null;};
const attempts=r=>(r.callHistory||[]).filter(c=>c&&c.at&&(c.outcome==='no_answer'||c.outcome==='voicemail')).length;
const lastTried=r=>Math.max(0,...(r.callHistory||[]).map(c=>ms(c&&c.at)||0));

/** Which part of the queue a card is in, from its last outcome. */
export function queueGroup(r,now=Date.now()){
 const due=ms(r.nextCallAt)!==null&&ms(r.nextCallAt)<=now;
 if((r.callOutcome==='callback'||r.callOutcome==='gatekeeper')&&due)return 'callback';   // a gatekeeper callback is a callback
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
 // Hiring now first among new leads: the default work since Paul paused real estate media (2026-10-27).
 // Within it, the card's own priority (LATAM or Philippines in the post, a fresh post, a small board).
 const hire=r=>r.kind==='hiring'?1000+Number(r.hiring&&r.hiring.priority||0):0;
 const within=(a,b,g)=>{
  if(g==='callback'||g==='later')return due(a)-due(b);
  // A number published on the business's own website is corroborated; a vendor or CRM number is a claim.
  if(g==='new')return hire(b)-hire(a)||listed(b)-listed(a)||sent(a)-sent(b);
  return attempts(a)-attempts(b)||lastTried(a)-lastTried(b)||listed(b)-listed(a);
 };
 return records.filter(r=>(!campaign||campaign==='all'||r.campaignId===campaign)&&inIndustry(r)&&offered(r)&&(owner==='all'||r.owner===owner)&&(research?!candidate(r):candidate(r))&&(!search||[r.company,r.recipient,r.callContact?.phone].join(' ').toLowerCase().includes(search.toLowerCase())))
  .map(r=>({r,g:queueGroup(r,now)}))
  .sort((a,b)=>RANK[a.g]-RANK[b.g]||within(a.r,b.r,a.g)||String(a.r.id).localeCompare(String(b.r.id)))
  .map(x=>x.r);
}

// Find any prospect the rep can see, whatever the queue's filters, order or state.
// ------------------------------------------------------------------
// Milton, 2026-10-27: "I dont have a search bar to find that lead". Paul, the same day: "make it so
// we can search by name, company or phone number, any combo of those even just first names".
//
// Every word typed has to match something on the card, and the words can be any mix:
//   a name      the contact's name from HubSpot (`names`, from /api/prospect-names/) or the card's
//               verified first name: "nick", "nick rossi"
//   a company   "realkit", "loft light"
//   a number    three or more digits, against every number on the card: "404", "5181", "313-5871".
//               Three digits are read as an area code first (Paul searched "740" and got nothing,
//               because a number used to need four), then as digits anywhere in the number.
//   an email    "support@realkit"
//   call notes  the last resort, so "nick" still finds a card whose only mention of Nick is a note
// A whole phone number however it is written ("(404) 550-5181", "+1 404 550 5181") is one search.
// Names and companies match from the start of a word, so "jo" finds "Joas" but not "Major".
const digitsOf=s=>String(s||'').replace(/\D/g,'');
const fold=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[\u2018\u2019\u02bc]/g,"'").toLowerCase();
const wordsOf=s=>fold(s).split(/[^a-z0-9@.']+/).filter(Boolean);
const squash=s=>fold(s).replace(/[^a-z0-9]/g,'');
export function searchRecords(records,q,{limit=10,names={}}={}){
 const text=String(q||'').trim();
 if(text.length<2)return [];
 const wholeNumber=/^[\d\s()+.-]+$/.test(text),all=digitsOf(text);
 if(wholeNumber&&all.length<3)return [];
 const tokens=wholeNumber?[{d:all.length>10?all.slice(-10):all}]
  :text.split(/[\s,]+/).filter(Boolean).map(t=>/^[\d()+.-]+$/.test(t)&&digitsOf(t).length>=3?{d:digitsOf(t),t:digitsOf(t)}:{t:fold(t).replace(/[^a-z0-9@.'&_+-]/g,'')})
   // A lone '&' or '-' is not a word to look for ("loft & light").
   .filter(x=>x.d||/[a-z0-9]/.test(x.t||''));
 if(!tokens.length)return [];
 const hits=[];
 for(const r of records||[]){
  const name=[names&&names[r.id],r.verifiedFirstName].filter(Boolean).join(' ');
  const nameWords=wordsOf(name),companyWords=wordsOf(r.company),company=squash(r.company),email=fold(r.recipient);
  const phones=[r.callContact&&r.callContact.phone,r.phone,r.crmPhone].filter(Boolean).map(digitsOf);
  const notes=(r.callHistory||[]).map(h=>String(h.notes||'')).filter(Boolean).reverse();
  let score=0,note=null;const got=new Set();
  const ok=tokens.every(tok=>{
   if(tok.d){
    const want=tok.d.length>10?tok.d.slice(-10):tok.d,tens=phones.map(p=>p.slice(-10));
    if(want.length===3&&tens.some(p=>p.startsWith(want))){score+=5;got.add('number');return true;}
    if(tens.some(p=>p.includes(want))||phones.some(p=>p.includes(tok.d))){score+=4;got.add('number');return true;}
    const n=tok.d.length>=7&&notes.find(x=>digitsOf(x).includes(tok.d));
    if(n){score+=2;got.add('notes');note=note||n;return true;}
    // Not a number on file: digits can still be part of a name or address ("Studio 360", "team360@").
    if(tok.t&&(company.includes(tok.t)||email.includes(tok.t))){score+=1;got.add(company.includes(tok.t)?'company':'email');return true;}
    return false;
   }
   const t=tok.t,ts=squash(t);
   if(nameWords.some(w=>w.startsWith(t))||(ts.length>=3&&squash(name).includes(ts))){score+=5;got.add('name');return true;}   // "obrien", "mary-jane"
   if(companyWords.some(w=>w.startsWith(t))){score+=4;got.add('company');return true;}
   if(ts.length>=3&&company.includes(ts)){score+=3;got.add('company');return true;}
   // An address matches by its parts ("nolan" in nolan@eastsidepics.com), or whole when one is typed.
   if(/[@._+]/.test(t)?email.includes(t):email.split(/[@._+-]+/).some(w=>w.startsWith(t))){score+=2;got.add('email');return true;}
   const n=notes.find(x=>fold(x).includes(t));
   if(n){score+=1;got.add('notes');note=note||n;return true;}
   return false;
  });
  if(!ok)continue;
  const matched=['name','company','number','email','notes'].find(k=>got.has(k));
  hits.push({record:r,name:name||null,matched,note:got.has('notes')?note:null,score});
 }
 const sorted=hits.sort((a,b)=>b.score-a.score||String(a.record.company||'').localeCompare(String(b.record.company||'')));
 const out=sorted.slice(0,limit).map(({score,...h})=>h);
 out.total=sorted.length;   // so the screen can say "10 of 37" instead of implying that is all
 return out;
}
