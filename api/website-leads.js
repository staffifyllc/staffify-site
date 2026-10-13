import {redis,requireAccess} from './_auth.js';
import {ownerFor} from './_outreach-queue.js';
import {websiteLead} from './_website-leads.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Read-only endpoint'});
 try{
  if(!ownerFor(await requireAccess(req)))return res.status(401).json({error:'Sign in to the Staffify Sales Hub to view captured leads.'});
  const emails=await redis.zrange('subscribers:by_date',0,-1),rows=[];
  for(let i=0;i<emails.length;i+=20){const batch=await Promise.all(emails.slice(i,i+20).map(async email=>{const [rec,nurture,suppressed]=await Promise.all([redis.hgetall('subscriber:'+email),redis.hgetall('softyes:'+email),redis.sismember('unsubscribed:set',email)]);return rec?websiteLead({...rec,email},nurture||{},!!suppressed):null;}));rows.push(...batch.filter(Boolean));}
  return res.json({checkedAt:new Date().toISOString(),rows:rows.sort((a,b)=>Date.parse(b.signedUpAt)-Date.parse(a.signedUpAt)),evidence:'Send timestamps come from the website email ledger. They do not confirm inbox delivery. Older nurture cycles may not have retained their full history.'});
 }catch{return res.status(503).json({error:'Subscriber records could not be loaded. Please retry.'});}
}
