import {redis,readBody} from './_auth.js';
import {slackNotify} from './_slack.js';
import {ready,token,hash,parseBuyer,RESERVE,checkoutBody,stripe,retrieveSession,fulfil,STANDARD,INTRO} from './_talent-checkout.js';
const cookieName='sf_talent_checkout';
const decode=v=>typeof v==='string'?JSON.parse(v):v;
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
 const enabled=ready();
 if(!enabled)return res.status(req.method==='GET'?200:503).json({enabled:false,standard:STANDARD,intro:INTRO,error:'Online payment is being connected. Email hello@gostaffify.com to arrange onboarding; interviews start after payment.'});
 const found=(req.headers.cookie||'').match(/(?:^|;\s*)sf_talent_checkout=([a-f0-9]{48})(?:;|$)/);
 const visitor=found?.[1]||token();
 if(!found)res.setHeader('Set-Cookie',cookieName+'='+visitor+'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000');
 try{
 const pointer='talent:current:'+hash(visitor);
 let id=await redis.get(pointer),o=id?decode(await redis.get('talent:order:'+id)):null;
 if(req.method==='GET'){
  if(!o)return res.status(200).json({enabled:true,standard:STANDARD,intro:INTRO});
  if(o.sessionId){const s=await retrieveSession(o.sessionId);const paid=await fulfil(o,s,{redis,notify:slackNotify});return res.status(200).json({enabled:true,amount:o.amount,candidate:o.candidate,status:paid?'paid':s.status==='expired'?'expired':'unpaid',test:s.livemode===false});}
  return res.status(200).json({enabled:true,amount:o.amount,candidate:o.candidate,status:'review'});
 }
 if(!['https://www.gostaffify.com','https://gostaffify.com'].includes(req.headers.origin))return res.status(403).json({error:'Please use the Staffify website.'});
 const b=readBody(req)||{};if(b.website)return res.status(400).json({error:'Unable to start checkout.'});
 // Limit provider session creation and storage without trusting user-supplied prices.
 const rate='talent:rate:'+hash((req.headers['x-forwarded-for']||'').split(',')[0]);const n=await redis.incr(rate);if(n===1)await redis.expire(rate,3600);if(n>30)return res.status(429).json({error:'Please try again later or contact Staffify.'});
 if(b.action==='review'){
  const buyer=parseBuyer(b);
  if(o&&await redis.get('talent:paid:'+o.id))return res.status(409).json({error:'This checkout has already been paid. Contact Staffify for another hire.'});
  if(o&&(o.email!==buyer.email||o.candidate!==buyer.candidate))return res.status(409).json({error:'You already have an initial checkout in progress. Resume it, or end that checkout before starting another.'});
  if(!o){const proposed={...buyer,id:token(),createdAt:Date.now()};id=await redis.eval(RESERVE,['talent:offer-email:'+hash(buyer.email),'talent:offer-visitor:'+hash(visitor),'talent:order:'+proposed.id,pointer],[JSON.stringify(proposed)]);o=decode(await redis.get('talent:order:'+id));}
  return res.status(200).json({amount:o.amount,candidate:o.candidate,status:'review'});
 }
 if(!o)return res.status(400).json({error:'Please review your onboarding plan first.'});
 if(b.action==='cancel'){
  if(o.sessionId){const s=await retrieveSession(o.sessionId);if(s.status==='complete')return res.status(409).json({error:'Payment has already been submitted. Check payment status instead.'});if(s.status==='open')await stripe('checkout/sessions/'+o.sessionId+'/expire',{},'expire-'+o.id);}
  await redis.del(pointer);return res.status(200).json({status:'cancelled'});
 }
 if(b.action!=='pay'||b.accept!==true)return res.status(400).json({error:'Review and accept the onboarding terms.'});
 if(o.createdAt+86400000<=Date.now())return res.status(409).json({error:'This checkout has expired. End it and start a new checkout at the standard fee.'});
 // Stripe idempotency key and immutable order recover safely after network/storage failures.
 const session=o.sessionId?await retrieveSession(o.sessionId):await stripe('checkout/sessions',checkoutBody(o),'talent-'+o.id);
 if(!o.sessionId){o.sessionId=session.id;await redis.set('talent:order:'+o.id,o);}
 if(session.status!=='open'||!session.url?.startsWith('https://checkout.stripe.com/'))return res.status(409).json({error:'This checkout is no longer open. Check payment status or end it before starting another.'});
 return res.status(200).json({url:session.url});
 }catch(e){return res.status(503).json({error:e.message?.startsWith('Please ')?e.message:'Checkout could not be completed. Your payment status has not been changed. Please retry or contact hello@gostaffify.com.'});}
}
