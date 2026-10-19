import {redis} from './_auth.js';
import {slackNotify} from './_slack.js';
import {validSignature,stripe,retrieveSession,fulfil} from './_talent-checkout.js';
export const config={api:{bodyParser:false}};
export default async function handler(req,res){
 if(req.method!=='POST')return res.status(405).end();
 if(!process.env.STRIPE_TALENT_WEBHOOK_SECRET||!process.env.STRIPE_SECRET_KEY)return res.status(503).end();
 let raw;try{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>262144)return res.status(413).end();chunks.push(Buffer.from(chunk));}raw=Buffer.concat(chunks).toString('utf8');}catch{return res.status(400).end();}
 if(!validSignature(raw,req.headers['stripe-signature'],process.env.STRIPE_TALENT_WEBHOOK_SECRET))return res.status(400).end();
 try{const event=JSON.parse(raw);if(!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type))return res.status(200).json({received:true});
 const id=event.data?.object?.metadata?.talent_order;if(!/^[a-f0-9]{48}$/.test(id||''))return res.status(200).json({received:true});
 let o=await redis.get('talent:order:'+id);if(typeof o==='string')o=JSON.parse(o);if(!o)return res.status(500).end();
 // Recover the session link if Stripe completed before the create response was stored.
 const s=await retrieveSession(event.data.object.id);
 if(!o.sessionId&&s.client_reference_id===o.id&&s.metadata?.talent_order===o.id){o.sessionId=s.id;await redis.set('talent:order:'+id,o);}
 await fulfil(o,s,{redis,notify:slackNotify});return res.status(200).json({received:true});
 }catch{return res.status(500).end();}
}
