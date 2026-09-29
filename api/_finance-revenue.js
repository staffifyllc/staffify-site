import {getAccessToken,getRealmId} from './_qbo.js';
export function reportIncome(report){
 const row=(report.Rows?.Row||[]).find(r=>r.group==='Income');
 const raw=row?.Summary?.ColData?.[1]?.value;
 if(raw==null||raw===''||!Number.isFinite(Number(raw)))throw Error('QuickBooks income total missing');
 return {amount:Number(raw),currency:report.Header?.Currency||'USD',basis:report.Header?.ReportBasis,start:report.Header?.StartPeriod,end:report.Header?.EndPeriod};
}
export async function monthlyRevenue(){
 const end=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const start=end.slice(0,7)+'-01',realm=await getRealmId(),token=await getAccessToken();
 const params=new URLSearchParams({start_date:start,end_date:end,accounting_method:'Accrual',minorversion:'70'});
 const response=await fetch('https://quickbooks.api.intuit.com/v3/company/'+encodeURIComponent(realm)+'/reports/ProfitAndLoss?'+params,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('QuickBooks revenue report unavailable');
 return {connected:true,...reportIncome(await response.json()),source:'QuickBooks Profit and Loss'};
}
