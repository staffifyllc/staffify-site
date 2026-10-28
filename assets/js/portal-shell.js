/* Shared sales navigation. All destinations use the existing authenticated routes. */
(()=>{
 const header=document.querySelector('.topbar');if(!header)return;
 const current=location.pathname, old=header.querySelector('nav'), nav=document.createElement('nav');
 nav.className='portal-nav';nav.setAttribute('aria-label','Sales workspace');
 const make=(title,href,id)=>{const a=document.createElement('a');a.textContent=title;a.href=href;if(id)a.id=id;const path=href.split('?')[0];if((path===current&&(!href.includes('?')||location.search.includes('view=replies')))||(path==='/campaigns/industries/'&&current.startsWith('/campaigns/industries/'))){a.className='active';a.setAttribute('aria-current','page');}return a;};
 // Spearhead sits in the top row rather than under More: it is a named list of 21 accounts worked
 // one at a time by hand, so it is a destination somebody opens on purpose, not a report they go
 // looking for. Next to Calls because that is the work it belongs to. Labelled "Spearhead" because
 // the full "Spearhead accounts" crowds the bar at laptop width; the page's own title still says it.
 for(const args of [['Today','/hub/','navHub'],['Campaigns','/campaigns/industries/'],['Inbox','/outreach-review/?view=replies'],['Calls','/dialer/'],['Spearhead','/spearhead/'],['Performance','/scoreboard/'],['Pipeline','/pipeline/'],['Commissions','/commissions/']])nav.append(make(...args));
 const more=document.createElement('details');more.className='portal-more';const summary=document.createElement('summary');summary.textContent='More';more.append(summary);const menu=document.createElement('div');menu.className='portal-menu';
 for(const args of [['My day','/my-day/','navDay'],['Campaigns (old view)','/campaigns/'],['Lost deals','/lost-deals/'],['Activity','/activity/'],['Enterprise accounts','/campaigns/enterprise/'],['Website signups','/website-leads/'],['Training','/training/sales/'],['Applicants','/careers/sales/inbox/'],['Talent Console ↗','https://recruiting.gostaffify.com/dashboard'],['Legacy campaign report','/campaigns/legacy/'],['Founder pilot','/pilot/','navPilot']])menu.append(make(...args));
 more.append(menu);nav.append(more);if(old)old.replaceWith(nav);else header.append(nav);
 // My inbox (assets/js/rep-inbox.js). Paul, 2026-10-27: "he should have an area where he can check his
 // inbox". Everyone's Inbox is their own mailbox, with a red count on it (Paul, 2026-10-28: "it should put
 // a little 1 or 2 red notification above the inbox"); an owner's outreach reply console moves under More
 // as "Outreach replies". Checked on load and every two minutes.
 let mineLink=null;
 async function inboxBadge(){try{const r=await fetch('/api/rep-inbox/?view=count',{credentials:'same-origin',cache:'no-store'});if(!r.ok)return;const j=await r.json();if(!j||!j.mailbox)return;
  if(!mineLink){if(j.owner)menu.prepend(make('Outreach replies','/outreach-review/?view=replies'));{mineLink=[...nav.querySelectorAll('a')].find(a=>a.textContent==='Inbox')||null;if(mineLink){mineLink.href='/inbox/';if(current==='/inbox/'){mineLink.className='active';mineLink.setAttribute('aria-current','page');}else{mineLink.classList.remove('active');mineLink.removeAttribute('aria-current');}}}}
  if(!mineLink)return;let b=mineLink.querySelector('.portal-badge');
  if(j.unread){if(!b){b=document.createElement('span');b.className='portal-badge';mineLink.append(b);}b.textContent=j.unread>=50?'50+':String(j.unread);b.setAttribute('aria-label',j.unread+' unread');}else if(b)b.remove();
 }catch{}}
 // Outreach paused (an owner only): a red bar on every page until the mailbox is reconnected.
 (async()=>{try{const r=await fetch('/api/outreach-connect/?action=paused',{credentials:'same-origin',cache:'no-store'});if(!r.ok)return;const j=await r.json();if(!j||!j.paused||!(j.mailboxes||[]).length)return;
  const bar=document.createElement('div');bar.className='portal-alert';bar.setAttribute('role','alert');
  bar.append(document.createTextNode('Outreach is paused: no new emails or follow-ups go out until '+j.mailboxes.map(m=>m.email).join(', ')+' '+(j.mailboxes.length===1?'is':'are')+' reconnected. '));
  for(const m of j.mailboxes){const a=document.createElement('a');a.href=m.reconnect;a.textContent='Reconnect '+m.email;bar.append(a,document.createTextNode(' '));}
  header.after(bar);}catch{}})();
 inboxBadge();const inboxTimer=setInterval(()=>{if(document.visibilityState!=='hidden')inboxBadge();},120000);if(inboxTimer&&inboxTimer.unref)inboxTimer.unref();
 document.addEventListener('click',e=>{if(!more.contains(e.target))more.open=false;});document.addEventListener('keydown',e=>{if(e.key==='Escape'){more.open=false;summary.focus();}});
 const logo=header.querySelector('img');if(logo&&!logo.closest('a')){const a=make('','/hub/');a.setAttribute('aria-label','Staffify home');logo.replaceWith(a);a.append(logo);}
 header.classList.add('portal-header');
 // Hub activity: one heartbeat a minute while a used tab is visible. See assets/js/hub-activity.js.
 if(document.head&&!document.querySelector('script[src^="/assets/js/hub-activity.js"]')){const s=document.createElement('script');s.src='/assets/js/hub-activity.js?v=20261023';s.defer=true;document.head.append(s);}
 // The shift bar and the phone-link gate. See assets/js/hub-shift.js.
 if(document.head&&!document.querySelector('script[src^="/assets/js/hub-shift.js"]')){const s=document.createElement('script');s.src='/assets/js/hub-shift.js?v=20261024';s.defer=true;document.head.append(s);}
 // The idle prompt: after 10 quiet minutes on a running shift, ask "Still on your shift?". See assets/js/hub-nudge.js.
 if(document.head&&!document.querySelector('script[src^="/assets/js/hub-nudge.js"]')){const s=document.createElement('script');s.src='/assets/js/hub-nudge.js?v=20261027';s.defer=true;document.head.append(s);}
 const content=document.querySelector('main,#app,.wrap,.page,.shell');if(content){if(!content.id)content.id='portal-content';const skip=make('Skip to content','#'+content.id);skip.className='portal-skip';document.body.prepend(skip);}
 if(location.hostname==='127.0.0.1'||location.hostname==='localhost'){const note=document.createElement('aside');note.className='portal-preview';note.textContent='Design preview · Sample or saved data. ';note.append(make('Open live Staffify','https://www.gostaffify.com'+location.pathname+location.search));document.body.prepend(note);}
})();
