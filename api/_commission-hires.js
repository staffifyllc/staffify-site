import {createHash} from 'node:crypto';
const norm=x=>String(x||'').toLowerCase().replace(/[^a-z0-9]/g,'');
async function rows(table,select){
 if(!process.env.TALENT_CLIENTS_URL||!process.env.TALENT_CLIENTS_KEY)throw Error('Talent Console connection missing');
 const out=[];for(let offset=0;offset<10000;offset+=500){const r=await fetch(process.env.TALENT_CLIENTS_URL.replace(/\/$/,'')+'/rest/v1/'+table+'?select='+encodeURIComponent(select)+'&limit=500&offset='+offset,{headers:{apikey:process.env.TALENT_CLIENTS_KEY,Authorization:'Bearer '+process.env.TALENT_CLIENTS_KEY},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Talent '+table+' read failed: '+r.status);const page=await r.json();out.push(...page);if(page.length<500)return out;}throw Error('Talent data incomplete');
}
export async function hirePrompts({redis,accounts,read=rows,now=new Date().toISOString()}){
 const enabledKey='finance:hire-prompts:enabled';await redis.set(enabledKey,now,{nx:true});const enabledAt=await redis.get(enabledKey);
 const [hires,placements,clients,manual,snapshot,overrides]=await Promise.all([
 read('applicant_hires','applicant_id,role_id,hired_at'),
 read('placements','id,applicant_id,client_id,client_name,role_id,role_title,status,started_at'),
 read('snapshot_clients','id,name,name_override,business_name,business_name_override,sales_rep_email,contact_email,stripe_email'),
 read('manual_roles','id,title,client_name,role_kind'),read('snapshot_roles','id,title,client_name'),read('role_overrides','role_id,client_id')]);
 const confirmed=await redis.hgetall('finance:hire-confirmations:v1')||{};const prompts=[];
 for(const h of hires){
  const role=manual.find(r=>r.id===h.role_id)||snapshot.find(r=>r.id===h.role_id);
  const ps=placements.filter(p=>p.applicant_id===h.applicant_id&&p.role_id===h.role_id&&p.status!=='ended');const p=ps.length===1?ps[0]:null;
  const clientId=p?.client_id||overrides.find(o=>o.role_id===h.role_id)?.client_id;
  let matches=clientId?clients.filter(c=>c.id===clientId):clients.filter(c=>[c.name,c.name_override,c.business_name,c.business_name_override].some(n=>norm(n)&&norm(n)===norm(role?.client_name||p?.client_name)));
  const client=matches.length===1?matches[0]:null;
  const names=[role?.client_name,p?.client_name,client?.name,client?.name_override,client?.business_name,client?.business_name_override].filter(Boolean).map(norm);
  const accountMatches=accounts.filter(a=>(a.clientEmail&&[client?.contact_email,client?.stripe_email].filter(Boolean).some(e=>e.toLowerCase()===a.clientEmail.toLowerCase()))||[a.name,a.qboName].filter(Boolean).some(n=>names.includes(norm(n))));const account=accountMatches.length===1?accountMatches[0]:null;
  // Fresh-start accounts show their existing hires; other old placements remain historical.
  if(!account&&h.hired_at<enabledAt)continue;
  if(account&&h.hired_at.slice(0,10)<account.since)continue;
  const id=createHash('sha256').update(h.applicant_id+'|'+h.role_id+'|'+h.hired_at).digest('hex').slice(0,24);
  const prior=confirmed[id];const confirmation=typeof prior==='string'?JSON.parse(prior):prior;
  prompts.push({id,roleId:h.role_id,roleTitle:role?.title||p?.role_title||'Role needs matching',clientName:account?.name||role?.client_name||p?.client_name||'Client needs matching',talentClientId:client?.id||null,customerId:account?.customerId||null,rep:account?.rep||null,talentSalesRep:client?.sales_rep_email||null,source:account?.source||'',hiredAt:h.hired_at,roleKind:hires.some(other=>other.role_id===h.role_id&&other.hired_at<h.hired_at)?'needs_review':role?.role_kind||'needs_review',state:confirmation?'confirmed':'needs_confirmation',confirmation:confirmation||null,roleUrl:'https://recruiting.gostaffify.com/roles/'+encodeURIComponent(h.role_id)});
 }
 return {connected:true,enabledAt,checkedAt:now,prompts};
}
