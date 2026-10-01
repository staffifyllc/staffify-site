import {createHash} from 'node:crypto';
export const VERIFICATION_TTL=7*86400000;
export function verificationKey(email){return 'staffify:email-verification:'+createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');}
export function resultFrom(body,email,now=Date.now()){
 const risky=body?.catch_all===true||body?.catchall===true||body?.disposable===true||/catch.?all|unknown|risky|invalid|undeliverable/i.test(String(body?.status||''));
 const same=!body?.email||String(body.email).trim().toLowerCase()===email;
 const valid=body?.verified===true&&!body?.error&&!risky&&same;
 return {email,source:'findymail',status:valid?'verified':body?.verified===false||risky?'undeliverable':'unconfirmed',provider:typeof body?.provider==='string'?body.provider:null,checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+(valid?VERIFICATION_TTL:30*86400000)).toISOString()};
}
export async function verifyEmail(email,{redis,fetcher=fetch,key=process.env.FINDYMAIL_KEY,now=Date.now()}={}){
 email=String(email||'').trim().toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return {email,status:'undeliverable',source:'syntax',checkedAt:new Date(now).toISOString()};
 const k=verificationKey(email),cached=await redis.get(k);
 if(cached?.email===email&&Date.parse(cached.expiresAt)>now)return {...cached,cached:true};
 const unavailable=reason=>({email,source:'findymail',status:'unavailable',reason,checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+15*60000).toISOString()});
 if(!key)return unavailable('Findymail connection missing');
 // Serialize paid lookups across workers and bulk recovery. Uncertain requests cool down.
 if(!await redis.set(k+':attempt',{at:new Date(now).toISOString()},{nx:true,ex:900}))return unavailable('Verification already running or awaiting retry');
 let result;
 try{
  const response=await fetcher('https://app.findymail.com/api/verify',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({email}),signal:AbortSignal.timeout(25000)});
  const body=await response.json();
  result=!response.ok||body?.error?unavailable('Verification service unavailable ('+response.status+')'):resultFrom(body,email,now);
 }catch{result=unavailable('Verification could not be completed');}
 await redis.set(k,result);return result;
}
export async function verificationGate(row,redis){const result=await verifyEmail(row.recipient,{redis});row.emailVerification=result;return result.status==='verified';}
