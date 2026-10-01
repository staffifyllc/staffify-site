// Owner-authorized machine summary. No payroll, invoice, CRM, or timer writes.
import {redis} from './_auth.js';
import {financeMachine} from './_finance-access.js';
import {api,ORG_ID} from './_hubstaff.js';
import {getAccessToken,getRealmId} from './_qbo.js';
export const config={maxDuration:60};
async function pages(path,key){let rows=[],users=[],cursor='';for(let i=0;i<40;i++){const r=await api(path+(path.includes('?')?'&':'?')+'page_limit=500'+(cursor?'&page_start_id='+encodeURIComponent(cursor):''));if(!r.ok)throw Error('Hubstaff unavailable');rows.push(...(r.data[key]||[]));users.push(...(r.data.users||[]));cursor=r.data.pagination?.next_page_start_id;if(!cursor)return {rows,users};}throw Error('Incomplete Hubstaff pagination');}
export async function income(now=new Date()){
 const end=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(now),start=end.slice(0,7)+'-01';
 const realm=await getRealmId(),token=await getAccessToken();const headers={Authorization:'Bearer '+token,Accept:'application/json'};
 const base='https://quickbooks.api.intuit.com/v3/company/'+encodeURIComponent(realm);
 const c=await fetch(base+'/companyinfo/'+encodeURIComponent(realm),{headers,redirect:'error',signal:AbortSignal.timeout(15000)});if(!c.ok)throw Error('QBO identity unavailable');const company=(await c.json()).CompanyInfo?.CompanyName;if(company?.trim().toLowerCase()!=='staffify')throw Error('QBO company mismatch');
 const r=await fetch(base+'/reports/ProfitAndLoss?'+new URLSearchParams({start_date:start,end_date:end,accounting_method:'Accrual',minorversion:'70'}),{headers,redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('QBO report unavailable');const report=await r.json(),h=report.Header||{},row=report.Rows?.Row?.find(x=>x.group==='Income'),v=row?.Summary?.ColData?.[1]?.value;
 const noData=h.Option?.some(x=>x.Name==='NoReportData'&&x.Value==='true');const amount=v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):noData?0:null;
 if(amount===null||h.ReportBasis!=='Accrual'||h.Currency!=='USD'||h.StartPeriod!==start||h.EndPeriod!==end)throw Error('QBO report incomplete');
 return {amount,currency:'USD',basis:'Accrual',start,end,company,asOf:now.toISOString(),noReportData:!!noData};
}
async function workforce(){const now=new Date(),stop=now.toISOString(),start=new Date(now-6*86400000).toISOString(),day=stop.slice(0,10),prefix='/organizations/'+ORG_ID;
 const [events,members,projects,daily]=await Promise.all([pages(prefix+'/tracking_states?'+new URLSearchParams({'occurred[start]':start,'occurred[stop]':stop}),'tracking_states'),pages(prefix+'/members?include=users','members'),pages(prefix+'/projects','projects'),pages(prefix+'/activities/daily?'+new URLSearchParams({'date[start]':day,'date[stop]':day,'time_zone':'UTC'}),'daily_activities')]);
 return {checkedAt:stop,day,timeZone:'UTC',events:events.rows.map(({id,user_id,project_id,type,occurred_at,project_type})=>({id,user_id,project_id,type,occurred_at,project_type})),users:members.users.map(({id,name,first_name,last_name,email})=>({id,name:name||[first_name,last_name].filter(Boolean).join(' '),email})),projects:projects.rows.map(({id,name})=>({id,name})),daily:daily.rows.map(({user_id,project_id,tracked,date})=>({user_id,project_id,tracked,date}))};
}
export default async function handler(req,res){res.setHeader('Cache-Control','private, no-store');if(req.method!=='GET'||!financeMachine(req))return res.status(401).json({error:'Unauthorized'});
 const kind=req.query?.view==='revenue'?'revenue':'workforce',key='hq:summary:'+kind;
 try{const cached=await redis.get(key);if(cached&&Date.now()-Date.parse(cached.checkedAt)<(kind==='revenue'?300000:30000))return res.status(200).json(cached);
 const data=kind==='revenue'?{revenue:await income(),checkedAt:new Date().toISOString()}:await workforce();await redis.set(key,data,{ex:kind==='revenue'?600:90});return res.status(200).json(data);
 }catch{return res.status(503).json({error:kind==='revenue'?'QuickBooks report unavailable':'Hubstaff clock feed unavailable'});}}
