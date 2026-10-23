/* Shared sales navigation. All destinations use the existing authenticated routes. */
(()=>{
 const header=document.querySelector('.topbar');if(!header)return;
 const current=location.pathname, old=header.querySelector('nav'), nav=document.createElement('nav');
 nav.className='portal-nav';nav.setAttribute('aria-label','Sales workspace');
 const make=(title,href,id)=>{const a=document.createElement('a');a.textContent=title;a.href=href;if(id)a.id=id;const path=href.split('?')[0];if((path===current&&(!href.includes('?')||location.search.includes('view=replies')))||(path==='/campaigns/'&&current.startsWith('/campaigns/')&&!current.includes('/enterprise/'))){a.className='active';a.setAttribute('aria-current','page');}return a;};
 // Spearhead sits in the top row rather than under More: it is a named list of 21 accounts worked
 // one at a time by hand, so it is a destination somebody opens on purpose, not a report they go
 // looking for. Next to Calls because that is the work it belongs to. Labelled "Spearhead" because
 // the full "Spearhead accounts" crowds the bar at laptop width; the page's own title still says it.
 for(const args of [['Today','/hub/','navHub'],['Campaigns','/campaigns/'],['Inbox','/outreach-review/?view=replies'],['Calls','/dialer/'],['Spearhead','/spearhead/'],['Pipeline','/pipeline/'],['Commissions','/commissions/']])nav.append(make(...args));
 const more=document.createElement('details');more.className='portal-more';const summary=document.createElement('summary');summary.textContent='More';more.append(summary);const menu=document.createElement('div');menu.className='portal-menu';
 for(const args of [['My day','/my-day/','navDay'],['Campaigns by industry','/campaigns/industries/'],['Lost deals','/lost-deals/'],['Performance','/scoreboard/'],['Enterprise accounts','/campaigns/enterprise/'],['Website signups','/website-leads/'],['Training','/training/sales/'],['Applicants','/careers/sales/inbox/'],['Talent Console ↗','https://recruiting.gostaffify.com/dashboard'],['Legacy campaign report','/campaigns/legacy/'],['Founder pilot','/pilot/','navPilot']])menu.append(make(...args));
 more.append(menu);nav.append(more);if(old)old.replaceWith(nav);else header.append(nav);
 document.addEventListener('click',e=>{if(!more.contains(e.target))more.open=false;});document.addEventListener('keydown',e=>{if(e.key==='Escape'){more.open=false;summary.focus();}});
 const logo=header.querySelector('img');if(logo&&!logo.closest('a')){const a=make('','/hub/');a.setAttribute('aria-label','Staffify home');logo.replaceWith(a);a.append(logo);}
 header.classList.add('portal-header');
 const content=document.querySelector('main,#app,.wrap,.page,.shell');if(content){if(!content.id)content.id='portal-content';const skip=make('Skip to content','#'+content.id);skip.className='portal-skip';document.body.prepend(skip);}
 if(location.hostname==='127.0.0.1'||location.hostname==='localhost'){const note=document.createElement('aside');note.className='portal-preview';note.textContent='Design preview · Sample or saved data. ';note.append(make('Open live Staffify','https://www.gostaffify.com'+location.pathname+location.search));document.body.prepend(note);}
})();
