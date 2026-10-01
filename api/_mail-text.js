const decode=data=>Buffer.from(data,'base64url').toString('utf8');
export function htmlText(html){
 const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',rsquo:'’',lsquo:'‘',rdquo:'”',ldquo:'“',ndash:'–',mdash:'—',hellip:'…'};
 return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<blockquote\b[\s\S]*|<div[^>]*class=["']gmail_quote[\s\S]*/i,'').replace(/<br\s*\/?\s*>|<\/(?:p|div|li|tr|h[1-6])\s*>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(m,e)=>{if(e[0]!=='#')return entities[e.toLowerCase()]??m;const n=e[1].toLowerCase()==='x'?parseInt(e.slice(2),16):parseInt(e.slice(1),10);return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):m;}).replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function extract(p){
 if(!p||p.filename||(p.headers||[]).some(h=>h.name.toLowerCase()==='content-disposition'&&/^attachment\b/i.test(h.value)))return '';
 const parts=p.parts||[];
 if(p.mimeType==='multipart/alternative'){
  const plain=parts.find(x=>x.mimeType==='text/plain'&&x.body?.data&&!x.filename);
  if(plain){const text=extract(plain);if(text.trim())return text;}
  for(const x of parts.filter(x=>x!==plain)){const text=extract(x);if(text.trim())return text;}
  return '';
 }
 if(p.body?.data&&p.mimeType==='text/plain')return decode(p.body.data);
 if(p.body?.data&&p.mimeType==='text/html')return htmlText(decode(p.body.data));
 return parts.map(extract).filter(Boolean).join('\n');
}
export function messageText(message){return extract(message.payload).split(/\nOn .{0,200}wrote:|-----Original Message-----/mi)[0].trim();}
