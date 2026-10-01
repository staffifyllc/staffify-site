// Shared pacing across preparation, qualification and send-time CRM checks.
export async function hubspotRequest(url,options,{redis,fetcher=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}={}){
 for(let attempt=0;attempt<4;attempt++){
  const wait=Number(await redis.eval("local n=tonumber(ARGV[1]);local t=math.max(n,tonumber(redis.call('GET',KEYS[1]) or '0'));redis.call('SET',KEYS[1],t+350,'PX',30000);return t-n",['staffify:hubspot:request-slot'],[now()]));
  if(wait>15000)throw Error('CRM unavailable: request queue busy');if(wait>0)await sleep(wait);
  const r=await fetcher(url,{...options,signal:AbortSignal.timeout(15000)});
  if(r.status!==429&&r.status<500)return r;
  if(attempt===3)return r;
  const retry=Number(r.headers.get('retry-after'));await r.text();await sleep(Math.min(10000,Math.max(1500*(attempt+1),Number.isFinite(retry)?retry*1000:0)));
 }
}
