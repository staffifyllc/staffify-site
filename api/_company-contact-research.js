export const repFit=text=>/real[ -]estate.{0,70}(photograph|videograph|media)|(?:property|architectural) photography/i.test(text||'');
export function companyHost(url){return new URL(url.startsWith('http')?url:'https://'+url).hostname.replace(/^www\./,'').toLowerCase();}
export function publishedEmail(page,domain){
 if(companyHost(page.url)!==domain)return null;
 const raw=String(page.html||'').replace(/&#64;|&commat;/g,'@');
 const addresses=[...new Set((raw.match(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)||[]).map(e=>e.toLowerCase()))];
 return addresses.find(e=>e.split('@')[1]===domain&&!/^(noreply|no-reply|privacy|abuse|support@wix)/.test(e))||null;
}
export function ownerOnSite(page){
 const match=String(page.text||'').match(/(?:[Ff]ounder|[Oo]wner)\s*[:,-]\s*([A-Z][a-z'-]+\s+[A-Z][a-z'-]+)\b/);
 return match?match[1]:null;
}
export function knownCompany(row,state){
 const domain=companyHost(row.website||row.domain),name=String(row.name||'').trim().toLowerCase();
 return [...(state.records||[]),...(state.assignments||[])].some(r=>r.agencyKey===domain||String(r.company||'').trim().toLowerCase()===name||String(r.recipient||r.email||'').split('@')[1]===domain);
}
