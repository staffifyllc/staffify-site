// A public business listing corroborates ownership; it does not prove who answers or line activity.
const digits=s=>String(s||'').replace(/\D/g,'');
const comparable=s=>{const n=digits(s);return n.length===11&&n[0]==='1'?n.slice(1):n;};
export function listedPhone(page,phone){
 const wanted=comparable(phone);if(wanted.length<10||wanted.length>15)return false;
 const raw=(page.text||'')+' '+(page.html||'').replace(/<(script|style)[\s\S]*?<\/\1>/gi,'');
 const normalized=raw.replace(/[\u2010-\u2015\u2212]/g,'-').replace(/&(?:nbsp|ndash|mdash);/g,' ');
 const candidates=[...normalized.matchAll(/(?:\+?\d[\d ().-]{7,}\d)/g)].map(m=>comparable(m[0]));
 return candidates.includes(wanted);
}
export async function checkBusinessPhone({phone,website,fetchSite,now=new Date().toISOString()}){
 const result={phone:phone||null,checkedAt:now,status:'needs_confirmation',sourceUrl:null,detail:'CRM number has not been corroborated on the business website. Do not assume this is the owner’s direct line.'};
 if(!phone){result.status='missing';result.detail='No phone number in CRM';return result;}
 if(!website)return result;
 try{
  const first=await fetchSite(website);const pages=[first];
  if(!listedPhone(first,phone)){
   const links=[...(first.html||'').matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m=>{try{return new URL(m[1],first.url);}catch{return null;}}).filter(u=>u&&u.origin===new URL(first.url).origin&&/contact|about/i.test(u.pathname));
   for(const url of [...new Set(links.map(u=>u.href))].slice(0,2)){try{const p=await fetchSite(url);pages.push(p);if(listedPhone(p,phone))break;}catch{}}
  }
  const match=pages.find(p=>listedPhone(p,phone));
  if(match)return {...result,status:'business_listed',sourceUrl:match.url,detail:'This number is published on the business website. Business contact, not a confirmed personal direct dial; current line activity is not guaranteed.'};
  return {...result,sourceUrl:first.url};
 }catch{return {...result,detail:'Business website could not be checked. Number remains unconfirmed.'};}
}
