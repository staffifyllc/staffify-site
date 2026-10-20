const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){
 const r=await fetch('/api/milton-hub/',{cache:'no-store'}),d=await r.json();
 if(!r.ok){$('status').textContent=d.error;$('login').hidden=r.status!==401;$('mount').innerHTML='';return;}
 if(!$('workspace')){$('mount').innerHTML=d.workspaceHTML;bind();}
 $('status').textContent='Milton · Your private workspace';$('workspace').hidden=false;$('login').hidden=true;$('admin').hidden=!d.admin;
 $('payroll').textContent=d.payrollNote;
 $('paymentStatus').textContent=d.paymentDataFresh?'Payment evidence updated '+new Date(d.checkedAt).toLocaleString():'Payment evidence is awaiting refresh. No unverified commission is marked eligible.';
 $('rows').innerHTML=d.rows.length?'<table><thead><tr><th>Client</th><th>Status</th><th>Eligible</th></tr></thead><tbody>'+d.rows.map(x=>'<tr><td>'+esc(x.client)+'</td><td>'+esc(x.status)+'</td><td>$'+esc(x.commission)+'</td></tr>').join('')+'</tbody></table>':'<p>No onboarding fees have been attributed yet.</p>';
 $('updateList').innerHTML=d.updates.map(u=>'<p><strong>'+esc(u.title)+'</strong><br>'+esc(u.body)+'</p>').join('');
 document.querySelectorAll('[data-module]').forEach(b=>{b.disabled=!!d.training[b.dataset.module];b.textContent=b.disabled?'Reviewed':'Mark reviewed';});
}
async function post(body){const r=await fetch('/api/milton-hub/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error);await load();}
function bind(){document.querySelectorAll('[data-module]').forEach(b=>b.onclick=()=>post({action:'complete-training',module:b.dataset.module}).catch(e=>$('status').textContent=e.message));
$('credit').onsubmit=e=>{e.preventDefault();const b=Object.fromEntries(new FormData(e.target));post({...b,action:'attribute',confirmDistinctFee:true}).catch(e=>$('status').textContent=e.message);};
}
load().catch(()=>$('status').textContent='Unable to load your workspace. Please retry.');
setInterval(()=>load().catch(()=>{$('status').textContent='Refresh failed. Displayed data may be outdated.';}),60000);
