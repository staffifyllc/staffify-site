(function(){
 const app=document.getElementById('app');let data,view=null;
 const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=x=>'$'+Number(x||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 // Signed flat trial plans, published by the ledger. Keyed by the handle written on a client
 // account, so a rep who is not Paul or Madison is named from his own agreement.
 const plans=()=>data.plans||{};
 const reps=()=>['paul','madison'].concat(Object.keys(plans()));
 const rep=x=>x==='paul'?'Paul':x==='madison'?'Madison':plans()[x]?.name||String(x||'');
 const teamNames=()=>{const n=reps().map(rep);return n.length<3?n.join(' & '):n.slice(0,-1).join(', ')+' & '+n.at(-1);};
 function render(){
  const rows=data.accounts.filter(a=>view==='all'||a.rep===view),sum=k=>rows.reduce((n,a)=>n+(a[k]||0),0);
  app.innerHTML='<p class="section-label" style="margin-top:0">STAFFIFY · PRIVATE WORKSPACE</p><h1>Your work. Rewarded.</h1><p class="sub">Commissions, client payments, and the next payroll. All in one place.</p><div class="fresh">QBO checked '+esc(new Date(data.updatedAt).toLocaleString())+(data.stale?' · Outdated: refresh needs attention':' · Cloud sync every 5 minutes')+'</div><div class="filters"><label>View <select id="owner"><option value="all">Shared · '+esc(teamNames())+'</option><option value="paul">Paul only</option><option value="madison">Madison only</option>'+Object.entries(plans()).map(([h,p])=>'<option value="'+esc(h)+'">'+esc(p.name)+' only</option>').join('')+'</select></label> <button class="btn small" id="refresh">Refresh view</button> <button class="btn small" id="export-payroll">Export payroll review</button></div>'
  +reps().filter(r=>view==='all'||view===r).map(r=>{
   const own=data.accounts.filter(a=>a.rep===r),total=k=>own.reduce((n,a)=>n+(a[k]||0),0),plan=plans()[r];
   // A flat trial plan is not a percentage plan with a different number in it. Printing a rate for
   // a flat rep, or a residual column he cannot earn, would misstate his signed terms.
   const terms=plan
    ?money(plan.onboardingCommission)+' for every onboarding fee Staffify collects in full'+(plan.capped?'':', with no cap')+'. No percentage, no lead-source split, and no hourly residual during the trial. Base pay of '+money(plan.weeklyBase)+' a week for '+plan.weeklyHours+' hours is owed for hours worked and is not a commission.'
    :(r==='paul'?'All leads: 30%.':'Business-generated: 20%. Self-generated: 30%.')+' Fifth and later qualifying placements that month: 35%. Residual: $1 per Hubstaff hour.';
   const band=plan
    ?'<div class="kpi"><b>'+money(total('placementEarned'))+'</b><span>Commission on collected fees¹</span></div><div class="kpi"><b>'+money(total('placementPending'))+'</b><span>Commission awaiting collection</span></div><div class="kpi"><b>'+money(total('placementCashEligible'))+'</b><span>Cleared · review for payroll</span></div><div class="kpi"><b>'+money(plan.biweeklyBase)+'</b><span>Base pay per two weeks</span></div>'
    :'<div class="kpi"><b>'+money(total('placementEarned'))+'</b><span>Placement earnings¹</span></div><div class="kpi"><b>'+money(total('residualEarned'))+'</b><span>Collected residuals¹</span></div><div class="kpi"><b>'+money(total('residualPending'))+'</b><span>Residuals awaiting collection</span></div><div class="kpi"><b>'+money(total('placementCashEligible')+total('residualCashEligible'))+'</b><span>Cleared · review for payroll</span></div>';
   // Zero with no explanation reads as a broken screen. Say which step is outstanding.
   const empty=plan&&!own.length?'<div class="hold">No client account is attributed to '+esc(plan.name)+' yet, so every figure here is zero. Assign the account under Assign a client account below and the fee appears here from the QBO invoice.</div>':'';
   const trial=plan?'<p class="rules-note">Trial '+esc(plan.trialStart)+' to '+esc(plan.trialEnd)+' · '+esc(plan.source)+'</p>':'';
   return '<section class="panel"><div class="ph"><h2>'+esc(rep(r))+'’s commissions</h2></div><div class="pl"><p>'+terms+'</p>'+empty+'<div class="band4">'+band+'</div>'+trial+'</div></section>';
  }).join('')
  +'<section class="panel"><div class="ph"><h2>Next payroll</h2><span>Every other Thursday</span></div><div class="pl"><div class="payroll-note"><div class="payroll-icon" aria-hidden="true">▦</div><div><strong>'+esc(data.payroll?.nextPayroll?new Date(data.payroll.nextPayroll+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric'}):'Schedule loading')+'</strong><small>Cleared funds only · Wednesday, 11:59 PM ET cutoff</small></div></div><details><summary>How payroll eligibility works</summary><p>Hubstaff confirms hours. QuickBooks confirms the client payment. Funds must then be verified cleared. Late or failed payments move to a later payroll.</p><p>Clearance verification and payroll submission are not connected yet. The export is a review worksheet; reconcile prior rep payouts before paying.</p></details></div></section>'
  +(!data.hubstaffConnected?'<div class="hold">Hubstaff hours could not be verified. Generic service lines remain held.</div>':'')
  +(data.talent?.connected?'<section class="panel"><div class="ph"><h2>New hires to review</h2></div><div class="pl"><p>Confirm the salesperson and role for each hire.</p>'+(data.talent.prompts.filter(p=>view==='all'||p.rep===view).map(p=>'<div class="hire-row"><div class="hire-copy"><a href="'+esc(p.roleUrl)+'" target="_blank" rel="noopener">'+esc(p.roleTitle)+'</a><small>'+esc(p.clientName)+' · '+esc(p.hiredAt.slice(0,10))+'</small><small>'+esc(p.rep?rep(p.rep):'Unassigned')+' · '+esc(p.roleKind==='replacement'?'Replacement':p.roleKind==='new_role'?'New role':'Confirm role type')+'</small></div><div class="hire-actions">'+(p.state==='confirmed'?'<span class="badge">Confirmed</span>':p.customerId&&p.rep&&p.source&&(data.canEdit||p.rep===data.viewer)?(p.roleKind==='needs_review'?'<select id="hire-kind-'+esc(p.id)+'" aria-label="Placement type"><option value="">New role or replacement?</option><option value="new_role">New paid role</option><option value="replacement">Replacement</option></select>':'')+'<button class="btn small" data-confirm-hire="'+esc(p.id)+'">Confirm credit</button>':'Assign client below')+'</div></div>').join('')||'<p>No hires waiting in this fresh-start scope.</p>')+'</div></section>':'<div class="hold">Talent hire feed: '+esc(data.talent?.error||'not yet connected')+'</div>')
  +(data.missing.length?'<div class="hold">'+data.missing.map(esc).join('<br>')+'</div>':'')
  +'<p class="section-label">Client accounts</p>'
  +rows.map(a=>'<section class="panel"><div class="ph"><h2>'+esc(a.contactName?a.contactName+' · '+a.name:a.name)+'</h2><span>'+esc(rep(a.rep))+' · '+(plans()[a.rep]?'Flat fee per collected onboarding fee':a.source==='self'?'Rep-generated':a.source==='house'?'Business-generated':'Lead source not recorded')+'</span></div><div class="pl"><p class="rules-note">Tracking since '+esc(a.since)+' · Billed as '+esc(a.qboName||a.name)+' · Customer '+esc(a.customerId)+'</p><p><b>'+money(a.placementEarned)+'</b> placement earnings · <b>'+money(a.residualEarned)+'</b> residual earned · <b>'+money(a.residualPending)+'</b> residual pending</p>'
  +'<p>'+ (a.trackedHours==null?'Hubstaff hours awaiting matching':a.trackedHours+' tracked hours · '+a.unlinkedHours+' hours not yet matched to an invoice')+'</p>'
  +(data.canEdit?'<button class="btn small" data-edit="'+esc(a.customerId)+'">Edit salesperson / lead source</button>':'')
  +'<details><summary>Invoices, hours & payment trail ('+a.invoices.length+')</summary>'
  +(a.invoices.length?a.invoices.map(i=>'<div class="prow" style="display:block"><b>Invoice '+esc(i.number)+' · '+esc(i.date)+' · '+esc(i.status)+'</b><p>'+money(i.collected)+' collected / '+money(i.total)+' billed · '+money(i.balance)+' outstanding · '+esc(i.currency)+'</p><p>'+i.hours+' Hubstaff hours matched to this invoice · '+money(i.residualEarned)+' residual earned · '+money(i.residualPending)+' awaiting collection</p><p>Placement commission: '+money(i.placementEarned)+(i.rate!=null?' at '+Number(i.rate.toFixed(2))+'%':i.flatFee!=null?' · flat '+money(i.flatFee)+' once this fee is collected in full':' · lead source needed')+'</p>'
  +(i.holds.length?'<p class="hold">'+i.holds.map(esc).join(' · ')+'</p>':'')
  +'<p><b>'+esc(i.cashStatus||'Settlement not checked')+'</b> · '+(i.payrollDate?'Earliest payroll: '+esc(i.payrollDate):'Not payroll eligible')+'</p><p>'+i.receipts.map(p=>'Payment '+esc(p.id)+' · '+esc(p.date)+' · '+money(p.amount)).join('<br>')+'</p><details><summary>Invoice line evidence</summary>'+i.lines.map(l=>'<p>'+esc(l.item)+' · Qty '+esc(l.quantity)+' · '+money(l.amount)+'<br>'+esc(l.description)+'</p>').join('')+'</details></div>').join(''):'<p>No invoices in this tracking period. Nothing is counted as earned.</p>')+'</details></div></section>').join('')
  +(data.canEdit?'<details class="panel" id="assignment"><summary style="padding:20px">Assign a client account</summary><form id="assign" class="pl"><label>QBO client <select name="customerId" required>'+data.customers.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.name)+'</option>').join('')+'</select></label><label> Salesperson <select name="rep"><option value="paul">Paul</option><option value="madison">Madison</option>'+Object.entries(plans()).map(([h,p])=>'<option value="'+esc(h)+'">'+esc(p.name)+'</option>').join('')+'</select></label><label> Lead source <select name="source"><option value="">Not recorded</option><option value="house">Business-generated</option><option value="self">Rep-generated</option></select></label><label> Track invoices from <input name="since" type="date" required></label><p>Changing the salesperson changes this account’s attribution. The previous assignment is retained in an audit log.</p><button class="btn" type="submit">Save assignment</button><p id="save-status"></p></form></details>':'')
  +'<p class="rules-note">¹ Collected earnings are not necessarily cleared or paid to the rep. Prior payouts require reconciliation. Only your assigned fresh-start accounts are included.</p><details class="panel"><summary style="padding:20px">Commission rules</summary><div class="pl">'+Object.values(plans()).map(p=>esc(p.name)+': flat '+money(p.onboardingCommission)+' per onboarding fee collected in full, no cap, no residual, on a signed trial agreement. ').join('')+'Paul: 30%. Madison: 20% business-generated, 30% self-generated. Fifth and later paid placements in a calendar month earn 35%. Both: $1 per Hubstaff hour matched to an invoice, after the entire invoice is paid and funds are verified cleared. Biweekly Thursday payroll; Wednesday end-of-day Eastern cutoff. Dated service lines are matched to a unique Hubstaff project/day with one staff member; ambiguous matches remain in review. Placement earnings follow applied payments, net of configured card fees. Unknown billing units, refunds and credits require review. No bank payouts are initiated here.</div></details>';
  document.getElementById('owner').value=view;document.getElementById('owner').onchange=e=>{view=e.target.value;render();};document.getElementById('refresh').onclick=load;
  document.getElementById('export-payroll').onclick=()=>{const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';const records=[['Salesperson','Client','Invoice','Hubstaff hours','Client collected','Invoice outstanding','Cash status','Placement earned before prior payouts','Residual earned before prior payouts','Earliest payroll','Review status']];for(const a of rows)for(const i of a.invoices)records.push([rep(a.rep),a.contactName?a.contactName+' / '+a.name:a.name,i.number,i.hours,i.collected,i.balance,i.cashStatus,i.placementEarned,i.residualEarned,i.payrollDate||'',i.payrollDate?'Reconcile prior rep payouts before payroll':'HOLD - not payroll eligible']);const url=URL.createObjectURL(new Blob([records.map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='staffify-payroll-review-'+(data.payroll?.nextPayroll||'pending')+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  document.querySelectorAll('[data-confirm-hire]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const r=await fetch('/api/account-commissions/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'confirm-hire',id:b.dataset.confirmHire,kind:document.getElementById('hire-kind-'+b.dataset.confirmHire)?.value})});const j=await r.json();if(!r.ok)throw Error(j.error);data=j;render();}catch(e){b.textContent=e.message;b.disabled=false;}});
  const form=document.getElementById('assign');if(form){form.elements.since.value=new Date().toISOString().slice(0,10);form.onsubmit=async e=>{e.preventDefault();const status=document.getElementById('save-status');status.textContent='Saving…';try{const r=await fetch('/api/account-commissions/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});const j=await r.json();if(!r.ok)throw Error(j.error);data=j;render();}catch(e){status.textContent=e.message;}};
  document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{const a=data.accounts.find(a=>a.customerId===b.dataset.edit);document.getElementById('assignment').open=true;for(const k of ['customerId','rep','source','since'])form.elements[k].value=a[k];form.scrollIntoView({behavior:'smooth'});});}
 }
 async function load(){try{const r=await fetch('/api/account-commissions/',{cache:'no-store'});if(!r.headers.get('content-type')?.includes('application/json'))throw Error('The financial service is temporarily unavailable. Please refresh shortly.');const j=await r.json();if(!r.ok)throw Error(j.error||'Sign in to view commissions');data=j;if(view===null)view=(j.canEdit?'all':j.viewer)||'paul';render();}catch(e){app.innerHTML='<h1>Clients & commissions</h1><p>'+esc(e.message)+'</p><a href="/hub/">Sign in to the Hub</a>';}}
 // A caller is not an owner and must not see this ledger, but they are not a stranger either.
 // Before falling through to the owner view (and its correct refusal), ask whether this session
 // has a trial plan of its own and render that instead.
 async function callerView(){
  try{
   const r=await fetch('/api/my-commissions/',{cache:'no-store'});
   if(!r.ok)return false;
   const d=await r.json();
   if(!d||!d.plan)return false;
   const money=n=>'$'+Number(n||0).toLocaleString();
   const p=d.plan;
   // Client names come from QBO, so they are escaped like any other stored text.
   const rows=(d.credited||[]).map(c=>
     `<tr><td>${esc(c.client||'—')}${c.invoice?' <small>Invoice '+esc(c.invoice)+'</small>':''}</td><td>${esc(c.funds||(c.status==='cleared'?'Funds cleared':'Awaiting client payment'))}${c.earliestPayroll?'<br><small>Earliest payroll '+esc(c.earliestPayroll)+'</small>':''}</td><td style="text-align:right">${c.amount?money(c.amount):c.awaiting?'<small>'+money(c.awaiting)+' pending</small>':'—'}</td></tr>`).join('')
     || '<tr><td colspan="3">No onboarding fees credited yet.</td></tr>';
   app.innerHTML=`
     <h1>Your pay</h1>
     <p>${esc(p.name)} &middot; trial ${esc(p.trialStart)} to ${esc(p.trialEnd)} &middot; ${esc(p.schedule)}</p>
     ${d.ledger?`<p class="rules-note">${d.ledger.readable?'Figures as of '+esc(new Date(d.ledger.updatedAt||Date.now()).toLocaleString())+'. The finance ledger is refreshed from QuickBooks by the office, so a payment taken today may not appear here yet.':'The finance ledger could not be read just now.'}</p>`:''}
     <section>
       <h2>Your plan</h2>
       <ul>
         <li><strong>${money(p.weeklyBase)}</strong> a week, <strong>${money(p.biweeklyBase)}</strong> every two weeks.</li>
         <li><strong>${money(p.onboardingCommission)}</strong> for each separate qualifying onboarding fee, once the funds have cleared.</li>
         <li>No residuals during the trial.</li>
         <li>First payday and payroll cutoff: ${esc(p.firstPayday||'not set yet')}${p.payrollCutoff?' / '+esc(p.payrollCutoff):''}.</li>
       </ul>
     </section>
     <section>
       <h2>What makes a fee qualify</h2>
       <ul>${(p.eligibility||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>
     </section>
     <section>
       <h2>Your onboarding fees</h2>
       <table><thead><tr><th>Client</th><th>Status</th><th style="text-align:right">Commission</th></tr></thead><tbody>${rows}</tbody></table>
       <p>Commission on collected fees: <strong>${money((d.totals||{}).commissionCleared)}</strong>${(d.totals||{}).awaitingCollection?` &middot; ${money(d.totals.awaitingCollection)} awaiting collection`:''}${(d.totals||{}).clearedForPayroll?` &middot; ${money(d.totals.clearedForPayroll)} cleared and ready for payroll review`:''}</p>
     </section>
     ${(d.notes||[]).length?`<section><h2>Worth knowing</h2><ul>${d.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></section>`:''}`;
   return true;
  }catch{return false;}
 }
 app.innerHTML='<h1>Clients &amp; commissions</h1><p>Loading…</p>';
 callerView().then(shown=>{ if(shown)return; load();setInterval(()=>{if(!document.getElementById('assignment')?.open&&!document.querySelector('details[open]'))load();},60000); });
})();
