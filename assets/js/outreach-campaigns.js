const app=document.getElementById('app');
const el=(tag,value)=>{const e=document.createElement(tag);e.textContent=value;return e;};
async function get(url){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error('Sign in to the Hub or retry: campaign data unavailable');return r.json();}
function preview(c){const box=el('details','');box.className='card';box.style.margin='18px 0';box.append(el('summary','Preview campaign emails · '+c.kind),el('p',c.note));if(!c.variants.length){box.append(el('p','No recipient copy is available for your account.'));return box;}const choice=el('select','');choice.setAttribute('aria-label',c.name+' preview recipient');choice.style.margin='12px 0';for(const [i,v] of c.variants.entries()){const o=el('option',v.label);o.value=i;choice.append(o);}const messages=el('div','');function draw(){messages.replaceChildren();for(const step of c.variants[Number(choice.value)].steps){const part=el('section','');part.style.margin='24px 0';const body=el('div',step.body);body.style.whiteSpace='pre-wrap';body.style.lineHeight='1.7';part.append(el('h3',step.title),el('p','Subject: '+step.subject),body);messages.append(part);}}choice.onchange=draw;box.append(choice,messages);draw();return box;}
async function load(){try{const [state,cloud,previews,results]=await Promise.all([get('/api/outreach-queue/'),get('/api/outreach-connect/'),get('/api/campaign-previews/'),get('/api/campaign-performance/').catch(e=>({error:e.message,campaigns:[]}))]);app.replaceChildren(el('h1','Campaigns'),el('p','Your campaigns, results, and the next conversation.'));
 const score=el('section','');score.className='card';score.style.margin='18px 0';score.append(el('h2','Campaign results'),el('p','Compare responses before increasing volume. A draft is not a send, and a reply is not a sale.'));
 if(results.error)score.append(el('p',results.error));
 const evidence=el('details','');evidence.append(el('summary','How results are counted'));const table=el('table','');table.style.width='100%';table.style.textAlign='left';const header=el('tr','');for(const label of ['Campaign','Recorded sends','People reached','Human replies','Reply rate'])header.append(el('th',label));table.append(header);
 for(const c of results.campaigns){const row=el('tr','');for(const value of [c.name,c.recordedSends,c.contactsReached,c.humanReplyContacts,c.humanReplyRate===null?'No sample':c.humanReplyRate+'%'+(c.missingSendHistory?' · partial history':'')]){const cell=el('td',value);cell.style.padding='10px 6px';row.append(cell);}table.append(row);const detail=el('details','');detail.append(el('summary',c.name+' · Evidence & limits'),el('p',c.coverage+' · '+c.comparison),el('p',c.replyDefinition),el('p',c.optOutHolds+' opt-out holds · '+c.bounceHolds+' bounce holds · '+c.autoReplyHolds+' automatic-reply holds'),el('p','Meetings: '+c.meetingEvidence+' · Revenue conversions: '+c.revenueEvidence));evidence.append(detail);}
 const scroll=el('div','');scroll.className='table-scroll';scroll.append(table);score.append(scroll,evidence,el('p',results.notes||''),el('p','Latest saved snapshot: '+(results.snapshot?.at?new Date(results.snapshot.at).toLocaleString():'Pending first cloud snapshot')));
 const hist=el('details','');hist.append(el('summary','Daily history and message revisions'));for(const h of results.history||[]){hist.append(el('h3',new Date(h.at).toLocaleDateString()+' · Revision '+h.revision));for(const c of h.campaigns)hist.append(el('p',c.name+': '+c.recordedSends+' recorded sends, '+c.contactsReached+' reached, '+c.humanReplyContacts+' human replies'));}score.append(hist);app.append(score);


 const companyPrep=cloud.companyPreparation;
 if(companyPrep){
  const source=el('section','');source.className='card';source.append(el('h2','Saved companies → verified contacts'));
  source.append(el('p',`${companyPrep.totalCompanies||0} companies already researched · ${companyPrep.nextOffset||0} processed · ${companyPrep.status}`));
  const b=companyPrep.budget;if(b)source.append(el('p',`${b.remaining} included searches remaining · ${b.dailyTarget}/day target · Resets ${b.renewal}`));
  source.append(el('p',`Latest cloud run: ${companyPrep.searched||0} searches · ${companyPrep.emailsFound||0} emails found · ${companyPrep.staged||0} added for verification`));
  if(companyPrep.reason)source.append(el('p',companyPrep.reason));
  const records=el('details','');records.append(el('summary','Recent companies and outcomes'));
  const seen=new Set();for(const run of cloud.companyPreparationHistory||[])for(const r of run.records||[]){if(seen.has(r.domain)||seen.size>=40)continue;seen.add(r.domain);const p=el('p',`${r.company} · ${r.email||r.domain} · ${r.verificationOutcome||r.reason}`);const row=state.records.find(x=>x.recipient===r.email);if(row)p.append(el('span',` · Campaign: ${row.status} · ${row.verifiedSentTouches||0} confirmed sends`));records.append(p);}
  source.append(records,el('p','Existing companies first. Email addresses must pass verification, client, reply and suppression checks before enrollment.'),el('p','Last checked: '+new Date(companyPrep.finishedAt||companyPrep.startedAt).toLocaleString()));app.append(source);
 }
 const prep=cloud.leadPreparation;
 const intake=el('section','');intake.className='card';intake.append(el('h2','Existing-lead preparation'));
 if(!prep)intake.append(el('p','Waiting for a recorded cloud run.'));
 else{
  const stale=!prep.finishedAt||Date.now()-Date.parse(prep.finishedAt)>15*60000;
  intake.append(el('p',(stale?'Needs attention: preparation overdue':prep.status)+' · Checked '+new Date(prep.finishedAt||prep.startedAt).toLocaleString()),el('p','Existing records first. Research and email verification run every five minutes in the cloud. Verification is not enrollment or sending.'));
  const inv=prep.inventory;
  if(inv)intake.append(el('p',`${inv.total} recovered records · ${inv.reviewed} reviewed · ${inv.pending} due for review`));
  intake.append(el('p',`Latest run: ${prep.scanned||0} scanned · ${prep.recovered||0} identities recovered · ${prep.verified||0} verified · ${prep.imported||0} CRM contacts created · ${prep.held||0} held`));
  const holds=el('details','');holds.append(el('summary','Why records are waiting or excluded'));
  for(const [reason,count] of Object.entries(inv?.outcomes||prep.reasons||{}))holds.append(el('p',`${count} · ${reason}`));intake.append(holds);
  const history=el('details','');history.append(el('summary','Recent cloud runs'));
  for(const run of (cloud.leadPreparationHistory||[]).slice(0,24))history.append(el('p',`${new Date(run.startedAt).toLocaleString()} · ${run.status} · ${run.scanned||0} scanned · ${run.verified||0} verified · ${run.held||0} held`));
  intake.append(history);
 }
 app.append(intake);
 for(const c of state.campaigns||[]){const rows=state.records.filter(r=>r.campaignId===c.id);const card=el('section','');card.className='card';card.append(el('h2',c.name),el('p',c.description));const recent=cloud.lastRun?.finishedAt&&Date.now()-Date.parse(cloud.lastRun.finishedAt)<5*60000;const running=['staffify-agency-outreach','staffify-tobit-outreach'].includes(c.id)&&cloud.enabled&&cloud.draftingEnabled&&cloud.sendingEnabled&&cloud.health?.ok&&recent&&cloud.lastRun.status!=='error';const health=el('p',running?'Running in the cloud':'Needs attention');health.className=running?'campaign-health good':'campaign-health warning';card.append(health);
 const counts=el('div','');counts.className='campaign-counts';for(const [value,label] of [[rows.length,'Prospects'],[rows.filter(r=>r.callReady).length,'Ready for a call'],[rows.filter(r=>r.status==='human_reply_hold').length,'Reply holds']]){const item=el('div','');item.append(el('strong',value),el('span',label));counts.append(item);}card.append(counts);
 const rules=el('details','');rules.append(el('summary','Schedule & automation details'),el('p','Latest worker: '+(cloud.lastRun?.finishedAt?new Date(cloud.lastRun.finishedAt).toLocaleString():'Not available')),el('p',`${c.maxEmails} emails maximum · At least ${c.minimumSpacingHours} hours apart · ${c.sendWindow}`),el('p','Preparation and reply checks run in the cloud. People handle replies and calls.'));card.append(rules);

 for(const [label,url] of [['Outreach, results & settings','/outreach-review/'],['Call workspace & scripts','/dialer/']]){const a=el('a',label);a.href=url+'?campaign='+encodeURIComponent(c.id);a.className='btn';a.style.margin='12px';card.append(a);}const proof=previews.campaigns.find(p=>p.id===c.id);if(proof)card.append(preview(proof));app.append(card);}
 for(const proof of previews.campaigns.filter(p=>!(state.campaigns||[]).some(c=>c.id===p.id))){const card=el('section','');card.className='card';card.style.margin='20px 0';card.append(el('h2',proof.name),preview(proof));if(proof.id==='website-playbook'){const link=el('a','Website signup activity');link.href='/website-leads/';card.append(link);}app.append(card);}
 const enterprise=el('a','Enterprise Direct & Tier 2 · Separate account workspace');enterprise.href='/campaigns/enterprise/';enterprise.className='btn';app.append(enterprise,el('p','Enterprise research and planning have their own workspace. Enterprise emails are not enrolled in the agency worker.'));
 }catch(e){app.replaceChildren(el('h1','Campaigns'),el('p',e.message));}}
load(); // Keep previews open while the operator reads them; reload for fresh data.
