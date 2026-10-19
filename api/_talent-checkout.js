import {createHash,createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
export const STANDARD=249900, INTRO=209900, TERMS='talent-2026-10-19';
export const CANDIDATES={'hazel-m':'Hazel M.','jedno-p':'Jedno P.','arnold-d-l':'Arnold D. L.','nancy-chi-t':'Nancy Chi T.',both:'Hazel M. and Jedno P.'};
export const hash=s=>createHash('sha256').update(s).digest('hex');
export const token=()=>randomBytes(24).toString('hex');
export const ready=()=>process.env.TALENT_CHECKOUT_ENABLED==='true'&&!!process.env.STRIPE_SECRET_KEY&&!!process.env.STRIPE_TALENT_WEBHOOK_SECRET;
export function parseBuyer(b){
 const clean=(v,n)=>typeof v==='string'?v.trim().slice(0,n):'';
 const r={name:clean(b.name,120),email:clean(b.email,253).toLowerCase(),company:clean(b.company,160),phone:clean(b.phone,40),candidate:clean(b.candidate,30),notes:clean(b.notes,350),terms:TERMS};
 if(!r.name||!r.company||!/^\S+@[^\s@]+\.[^\s@]+$/.test(r.email)||!CANDIDATES[r.candidate]||b.accept!==true)throw Error('Please complete your details and accept the onboarding terms.');
 if(r.phone&&(!/^\+?[0-9 ().-]+$/.test(r.phone)||r.phone.replace(/\D/g,'').length<7||r.phone.replace(/\D/g,'').length>15))throw Error('Please enter a valid phone number or leave it blank.');
 return r;
}
// A single atomic reservation binds the introductory offer to both browser and email.
// Cookie deletion alone cannot reissue an email's introductory offer. No fingerprinting.
export const RESERVE=`
local prior=redis.call('GET',KEYS[4])
if prior then return prior end
local order=cjson.decode(ARGV[1])
if redis.call('EXISTS',KEYS[1])==0 and redis.call('EXISTS',KEYS[2])==0 then order.amount=209900 else order.amount=249900 end
redis.call('SET',KEYS[1],'1')
redis.call('SET',KEYS[2],'1')
local encoded=cjson.encode(order)
redis.call('SET',KEYS[3],encoded)
redis.call('SET',KEYS[4],order.id,'EX',31536000)
return order.id`;
export async function stripe(path,body,idempotency){
 const r=await fetch('https://api.stripe.com/v1/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+process.env.STRIPE_SECRET_KEY,...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(idempotency?{'Idempotency-Key':idempotency}:{})},body:body?new URLSearchParams(body):undefined,signal:AbortSignal.timeout(15000)});
 const j=await r.json();if(!r.ok)throw Error('Payment provider unavailable. Please retry this checkout.');return j;
}
export function checkoutBody(o){return {
 mode:'payment','payment_method_types[0]':'card',customer_email:o.email,client_reference_id:o.id,
 'line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(o.amount),'line_items[0][price_data][product_data][name]':'Staffify onboarding — one hiring search','line_items[0][price_data][product_data][description]':'Role planning, fit review, interview coordination and onboarding support. Staffing costs are separate. Candidate availability is confirmed.','line_items[0][quantity]':'1',
 'metadata[talent_order]':o.id,'metadata[terms]':TERMS,'payment_intent_data[metadata][talent_order]':o.id,
 success_url:'https://www.gostaffify.com/browse-talent/checkout/?result=return',cancel_url:'https://www.gostaffify.com/browse-talent/checkout/?result=cancel',
 expires_at:String(Math.floor(o.createdAt/1000)+86400),'consent_collection[terms_of_service]':'required',
 'custom_text[terms_of_service_acceptance][message]':'I agree to the Staffify [onboarding terms](https://www.gostaffify.com/browse-talent/checkout/#terms).',
};}
export function verifiedPayment(o,s){
 const pi=s.payment_intent,c=pi?.latest_charge;
 return s.id===o.sessionId&&s.client_reference_id===o.id&&s.metadata?.talent_order===o.id&&s.mode==='payment'&&s.status==='complete'&&s.payment_status==='paid'&&s.currency==='usd'&&s.amount_total===o.amount&&pi?.status==='succeeded'&&pi.amount_received===o.amount&&pi.currency==='usd'&&pi.metadata?.talent_order===o.id&&c?.paid===true&&!c.refunded&&!c.disputed&&c.amount_refunded===0&&/^(sk|rk)_(live|test)_/.test(process.env.STRIPE_SECRET_KEY||'')&&s.livemode===/^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY||'');
}
export const retrieveSession=id=>stripe('checkout/sessions/'+encodeURIComponent(id)+'?expand%5B%5D=payment_intent.latest_charge');
export function validSignature(raw,header,secret,now=Date.now()){
 if(!secret||typeof header!=='string')return false;const pairs=header.split(',').map(x=>x.split('='));const t=pairs.find(x=>x[0]==='t')?.[1];if(!/^\d+$/.test(t||'')||Math.abs(now/1000-Number(t))>300)return false;
 const expected=createHmac('sha256',secret).update(t+'.'+raw).digest();return pairs.filter(x=>x[0]==='v1'&&/^[a-f0-9]{64}$/i.test(x[1])).some(x=>timingSafeEqual(expected,Buffer.from(x[1],'hex')));
}
export async function fulfil(o,s,{redis,notify}){
 if(!verifiedPayment(o,s))return false;
 // Separate payment evidence from sales status; do not mark won, hired or booked.
 await redis.set('talent:paid:'+o.id,{sessionId:s.id,paymentIntent:s.payment_intent.id,amount:o.amount,currency:'usd',verifiedAt:Date.now(),mode:s.livemode?'live':'test'});
 // Test-mode payments never enter the live sales queue or notify staff.
 if(!s.livemode)return true;
 const id='lead:talent:'+o.id;
 await redis.hsetnx(id,'status','new');await redis.hsetnx(id,'owner','');
 const fields={id,name:o.name,email:o.email,company:o.company,phone:o.phone,source:'talent-marketplace-paid',created_at:String(o.createdAt),note:'VERIFIED ONBOARDING PAYMENT $'+(o.amount/100).toFixed(2)+' USD. Candidate shortlist: '+CANDIDATES[o.candidate]+'. Interview scheduling requested; not booked. '+o.notes,payment_reference:s.payment_intent.id};
 for(const [field,value] of Object.entries(fields))await redis.hsetnx(id,field,value);
 await redis.zadd('leads:by_date',{score:o.createdAt,member:id});
 if(await redis.set('talent:alert-lock:'+o.id,'1',{nx:true,ex:60})){
  if(!await redis.get('talent:alerted:'+o.id)){const result=await notify('Paid Staffify onboarding: '+o.company+' — $'+(o.amount/100).toFixed(2)+' USD. Shortlist: '+CANDIDATES[o.candidate]+'. Confirm availability and arrange interviews. Sales queue: https://www.gostaffify.com/campaigns/');if(result?.ok)await redis.set('talent:alerted:'+o.id,'1');}
 }
 return true;
}
