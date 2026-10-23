// Current hosted Gmail outreach. Uses the same records as Outreach review.
//
// Reads the SLIM queue view: the same rows and the same callReady, without the mail bodies. The
// full payload was 7.9 MB and took four and a half seconds to arrive; this page counts sends and
// callable rows and never shows a body. Paul, 2026-10-22: "its deathly slow between tabs".
(function(){
 let root,timer,busy=false,callsHeld=null;const dayKey=v=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v));
 const el=(tag,value,cls)=>{const n=document.createElement(tag);if(value!==undefined)n.textContent=value;if(cls)n.className=cls;return n;};
 async function get(path){const r=await fetch(path,{cache:'no-store',credentials:'same-origin'});const d=await r.json();if(!r.ok){const e=Error(d.error||'Unable to check outreach');e.status=r.status;throw e;}return d;}
 async function load(){if(!root||busy)return;busy=true;const target=root;try{const [state,cfg]=await Promise.all([get('/api/outreach-queue/?view=slim'),get('/api/outreach-connect/')]);if(root!==target)return;render(state,cfg);}catch(e){if(root===target){target.replaceChildren(el('h2','Outreach status unavailable'),el('p',e.message),el('p','Activity could not be checked. This does not mean zero emails were sent.'));const retry=el('button','Retry');retry.onclick=load;target.append(retry);}}finally{busy=false;}}
 function render(state,cfg){
 const accounts=cfg.accounts.filter(a=>a.brand==='Staffify'&&a.draftEnabled),senders=new Set(accounts.map(a=>a.email)),rows=state.records.filter(r=>senders.has(r.sender)),day=dayKey(Date.now()),events=new Map();
 for(const r of rows)for(const e of r.events||[])if(e.kind==='sent'&&dayKey(e.at)===day)events.set(r.sender+':'+e.id,{...e,owner:r.owner,sender:r.sender,company:r.company,threadId:r.threadId});
 const sends=[...events.values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));const automatic=(state.sends||[]).filter(s=>s.status==='verified'&&s.day===day&&senders.has(s.sender));
 const failed=(cfg.health?.accounts||[]).filter(a=>!a.ok&&senders.has(a.email)),stale=!cfg.lastRun?.finishedAt||Date.now()-Date.parse(cfg.lastRun.finishedAt)>300000;
 const status=!cfg.enabled?'Paused':failed.length?'Reconnect required: '+failed.map(a=>a.email).join(', '):stale?'Needs attention: cloud check overdue':cfg.lastRun?.status==='error'?'Needs attention: '+cfg.lastRun.reason:!cfg.sendingEnabled?'Automatic sending paused':'Running automatically · Computer can be closed';
 root.replaceChildren();root.append(el('div','STAFFIFY · SALES WORKSPACE','eyebrow'),el('h1','Today'),el('p','Outreach progress and the conversations that need you.','sub'),el('p',status,'so-status'));
 const grid=el('div',undefined,'so-grid');for(const [label,value] of [['Paul · sent today',sends.filter(s=>s.owner==='Paul').length],['Madison · sent today',sends.filter(s=>s.owner==='Madison').length],['Replies to handle',StaffifyReplies.queue(rows).length],['Ready to call',rows.filter(r=>r.callReady).length]]){const cell=el(['Replies to handle','Ready to call'].includes(label)?'a':'div',undefined,'so-card');if(label==='Replies to handle'){cell.href='/outreach-review/?view=replies';cell.setAttribute('aria-label',value+' replies to handle. View waiting conversations');}if(label==='Ready to call')cell.href='/dialer/';cell.append(el('strong',String(value)),el('span',label));grid.append(cell);}root.append(grid);
 root.append(el('p',automatic.length+' automatically sent today. Totals above also include tracked manual sends.','so-muted'));
 const actions=el('div',undefined,'so-actions');const open=el('a','Open outreach and communication history');open.href='/outreach-review/';const refresh=el('button','Refresh');refresh.onclick=load;actions.append(open,refresh);root.append(actions);
 // Calls, from Quo. Rendered from the last answer at once so the panel never blanks on a refresh,
 // then refreshed in the background. A Quo failure is shown as a failure, never as zero calls.
 const calls=el('section',undefined,'so-calls');root.append(calls);renderCalls(calls,callsHeld);loadCalls(calls);
 if(sends.length){root.append(el('h3','Latest sends'));for(const s of sends.slice(0,5)){const item=el('p',undefined,'so-receipt');item.append(el('strong',s.company||'Agency'),el('span',s.owner+' · '+new Date(s.at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})+' · '+s.subject));root.append(item);}}else root.append(el('p','No tracked sends recorded today.'));
 const detail=el('details');detail.append(el('summary','Data and daily limits'),el('p','Source: verified Gmail communication records, shared with Outreach review. Tracked Staffify mailboxes only; Foundry and excluded historical mailboxes are not included.'),el('p','Paul: 50 new introductions per Staffify mailbox daily, plus due follow-ups. Madison: 50 new prospect emails per Staffify mailbox daily (200 across four mailboxes), plus due follow-ups. Replies and client correspondence do not count toward new-prospect quotas. No combined daily cap is shown because follow-ups are additional for both owners.'),el('p','Last cloud check: '+(cfg.lastRun?.finishedAt?new Date(cfg.lastRun.finishedAt).toLocaleString():'unavailable')));root.append(detail);
 }
 // Paul, 2026-10-22: "how many calls have been made ... talk times, new calls, follow up calls".
 // Team view where the viewer may read it; a caller who may not (403) is shown his own seat.
 async function loadCalls(node){
  let data=null,err=null;
  try{data=await get('/api/quo-activity/?team=1&days=7');}
  catch(e){if(e.status===403){try{data=await get('/api/quo-activity/?days=7');}catch(e2){err=e2;}}else err=e;}
  if(!node.isConnected)return;
  if(data){callsHeld=data;renderCalls(node,data);}
  else renderCalls(node,null,err);
 }
 const mins=s=>{const m=Math.round((s||0)/60*10)/10;return (Number.isInteger(m)?m:m.toFixed(1))+' min';};
 function renderCalls(node,data,err){
  node.replaceChildren(el('h3','Calls · last 7 days'));
  if(err){node.append(el('p','Quo could not be read: '+err.message,'so-warn'),el('p','No call count is shown. This does not mean zero calls were made.','so-muted'));return;}
  if(!data){node.append(el('p','Checking Quo…','so-muted'));return;}
  const reps=(data.reps||[]).filter(r=>r.dials||r.inboundReturned);
  if(!reps.length){node.append(el('p','No outbound calls recorded in Quo for '+data.window.from+' to '+data.window.to+'.','so-muted'));return;}
  const today=dayKey(Date.now());
  const grid=el('div',undefined,'so-grid so-grid-calls');
  const tot=k=>reps.reduce((n,r)=>n+(r[k]||0),0);
  for(const [label,value] of [['Dials today',reps.reduce((n,r)=>n+((r.byDay||{})[today]?.dials||0),0)],['Dials · 7 days',tot('dials')],['Talk time · 7 days',mins(tot('talkSeconds'))],['New calls / follow-ups',tot('newCalls')+' / '+tot('followUpCalls')]]){const cell=el('div',undefined,'so-card');cell.append(el('strong',String(value)),el('span',label));grid.append(cell);}
  node.append(grid);
  const table=el('table',undefined,'so-table');const head=el('tr');for(const h of ['Rep','Today','Dials','Picked up','Avg answered','Talk time','New','Follow-ups','Numbers'])head.append(el('th',h));table.append(head);
  for(const r of reps){const tr=el('tr');const name=(r.rep&&(r.rep.name||r.rep.email))||'Seat';
   for(const v of [name,(r.byDay||{})[today]?.dials||0,r.dials,r.connected+(r.dials?' ('+r.connectRate+'%)':''),r.avgAnsweredSeconds!=null?r.avgAnsweredSeconds+'s':'—',mins(r.talkSeconds),r.newCalls??'—',r.followUpCalls??'—',r.uniqueNumbers+(r.repeatDials?' · '+r.repeatDials+' repeat':'')])tr.append(el('td',String(v)));
   if(r.truncated)tr.append(el('td','partial: Quo paging stopped','so-warn'));table.append(tr);}
  node.append(table);
  node.append(el('p','Calls placed through Quo. Picked up includes a machine or a front desk answering, so read it with the average answered length. New is the first dial to a number in these seven days; a follow-up is a later dial to the same number.','so-muted so-small'));
  if(data.cached)node.setAttribute('data-cached','1');
 }
 function visible(){if(!document.hidden)load();}
 function mount(node){unmount();root=node;if(!document.getElementById('staffify-outreach-overview-style')){const style=el('style');style.id='staffify-outreach-overview-style';style.textContent='.so-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.so-card{padding:24px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.1);border-radius:16px}.so-card[href]{text-decoration:none;cursor:pointer}.so-card[href]:hover,.so-card[href]:focus-visible{border-color:#5fe0fa;outline:2px solid #5fe0fa}.so-card strong{display:block;font-size:36px;color:#fff}.so-card span,.so-muted,.so-receipt span{color:#9ba1ab}.so-status{color:#5fe0fa}.so-actions{display:flex;gap:20px;align-items:center;margin:24px 0}.so-actions a{color:#5fe0fa}.so-actions button{background:#111418;border:1px solid #40434a;color:#fff;border-radius:8px;padding:8px 14px;cursor:pointer}.so-receipt{padding:12px 0;border-bottom:1px solid #23252a}.so-receipt span{display:block;margin-top:4px}.so-calls{margin:8px 0 28px}.so-calls h3{margin:0 0 12px}.so-grid-calls .so-card strong{font-size:28px}.so-table{width:100%;border-collapse:collapse;margin-top:14px;font-variant-numeric:tabular-nums}.so-table th{text-align:left;font-weight:500;color:inherit;opacity:.65;font-size:12px;letter-spacing:.04em;text-transform:uppercase;padding:6px 10px 6px 0;border-bottom:1px solid rgba(127,127,127,.35)}.so-table td{padding:9px 10px 9px 0;border-bottom:1px solid rgba(127,127,127,.2);color:inherit}.so-warn{color:#ffb86b}.so-small{font-size:13px;margin-top:10px}@media(max-width:750px){.so-grid{grid-template-columns:repeat(2,1fr)}.so-table{display:block;overflow-x:auto}}';document.head.append(style);}root.textContent='Checking current Gmail outreach…';load();timer=setInterval(()=>{if(!document.hidden)load();},30000);document.addEventListener('visibilitychange',visible);}
 function unmount(){clearInterval(timer);document.removeEventListener('visibilitychange',visible);root=null;}
 window.StaffifySalesLive={mount,unmount};
})();
