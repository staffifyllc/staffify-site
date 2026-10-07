const FREE=/^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|protonmail|proton)\./i;
const MEDIA=/real[ -]estate.{0,50}(photograph|videograph|media)|(?:property|architectural) photography/i;
export function recoveredIdentity(evidence,email,company=''){
 const host=new URL(evidence.url).hostname.replace(/^www\./,'');const domain=email.split('@')[1];
 if(/(^|\.)(facebook|linkedin|instagram|yelp|google|youtube|apollo|zoominfo|rocketreach)\./i.test(host))return null;
 if(!MEDIA.test(evidence.text))return null;
 if(host!==domain&&!evidence.text.toLowerCase().includes(email.toLowerCase())&&!evidence.html.toLowerCase().includes('mailto:'+email.toLowerCase()))return null;
 const meta=evidence.html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i);
 const title=evidence.html.match(/<title[^>]*>([^<]+)<\/title>/i);
 const name=company||meta?.[1]||title?.[1]?.split(/\s[|–—]\s/)[0];
 if(!name||name.length<3||name.length>150||/^(home|welcome|contact|untitled)$/i.test(name.trim()))return null;
 return {company:name.trim(),domain:evidence.url,evidence:{url:evidence.url,checkedAt:new Date().toISOString(),identity:host===domain?'business_email_domain':'published_exact_email'}};
}
export async function recoverExisting(item,{redis,siteReader,fetcher=fetch}={}){
 const email=String(item.email).toLowerCase();const cache='staffify:recovery:v1:'+email;
 const cached=await redis.get(cache);if(cached)return {...cached,cached:true};
 const candidates=[];if(item.domain)candidates.push(item.domain);
 const domain=email.split('@')[1];if(!FREE.test(domain))candidates.push('https://'+domain);
 for(const url of [...new Set(candidates)]){try{const evidence=await siteReader(url),match=recoveredIdentity(evidence,email,item.company);if(match){await redis.set(cache,match,{ex:30*86400});return match;}}catch{}}
 if(!process.env.EXISTING_LEAD_RESEARCH_TOKEN)throw Error('Existing-lead search connection missing');
 const r=await fetcher('https://campaign-dashboard-green.vercel.app/api/existing-lead-research',{method:'POST',headers:{Authorization:'Bearer '+process.env.EXISTING_LEAD_RESEARCH_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({email}),signal:AbortSignal.timeout(50000)});
 if(!r.ok)throw Error('Existing-lead search unavailable ('+r.status+')');
 const data=await r.json();
 for(const candidate of data.results||[]){try{const evidence=await siteReader(candidate.url),match=recoveredIdentity(evidence,email,item.company);if(match){await redis.set(cache,match,{ex:30*86400});return match;}}catch{}}
 const noMatch={unmatched:true,checkedAt:new Date().toISOString()};await redis.set(cache,noMatch,{ex:30*86400});return noMatch;
}
