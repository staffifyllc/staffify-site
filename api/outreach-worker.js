import {supplyDealFollowups} from './_deal-followups.js';
import {maintainClients} from './_outreach-maintenance.js';
import {randomUUID} from 'node:crypto';
import {redis} from './_auth.js';
import {KEY} from './_outreach-queue.js';
import {config,access,gmail,history,headers,messageText,mime,compactMessage,assertDraft} from './_outreach-gmail.js';
import {supply} from './_outreach-supply.js';
import {canDraft as crmCanDraft,suppress} from './_outreach-crm.js';
import {bookedIdentity} from './_booked-leads.js';
import {eligible,quota,dayKey,classify,followup,reconcileThread,callReady} from './_outreach-policy.js';
import {makeWorker} from './_outreach-worker-core.js';
import {HIRING_DRIP_ID,hiringDripStop,dripWait} from './_hiring-drip-copy.js';
import {hiringSupply} from './_hiring-drip.js';
import {dripDeps} from './_hiring-drip-live.js';
import {getRecord,laneFor} from './_hiring-intent.js';
import {takeStops,doneStops} from './_outreach-stops.js';
import {stopHiringCards} from './_hiring-calls.js';
import {mailboxFor,ROUTE_TO} from './_rep-email.js';
import {kickLink} from '../lib/unsubscribe-token.js';
import {isOptedOut} from './_optout.js';
// Nothing is drafted or sent to a lead whose email or company booked a Discovery call, even one that reached
// the queue after the booking (api/_booked-leads.js). An unreadable booking list holds the row: fail closed.
// A Hiring now row also stops on its own card (a caller reached them, a booking, a closed posting, a changed address),
// and any read that fails holds that row (crm_hold) instead of failing the tick for every campaign.
// Paul, 2026-10-30: "I would also like for the rep to be copied and get a version if people are responding". A reply
// goes to the sending inbox (so this worker still sees it and stops the sequence), to hello@, and to the Hub inbox of
// the caller who works the card, read fresh at each draft so a card claimed later copies its caller from then on.
// The caller is the card's owner, else the caller its sector goes to (law and insurance: Milton), so a first email to an
// unworked card still copies the person who will call it. Paul's own login is hello@, already on the list.
const hiringReplyTo=(row,card)=>{const who=String(card.callOwner||laneFor(card)||'').toLowerCase();const box=who&&who!==ROUTE_TO?mailboxFor({email:who}):null;return [row.sender,ROUTE_TO,box].filter(Boolean);};
const hiringCanDraft=async row=>{try{const card=await getRecord(redis,row.hiringId);if(hiringDripStop(card)||dripWait(card,row)||String(card.contact.email||'').toLowerCase()!==row.recipient)return false;row.replyTo=hiringReplyTo(row,card);return await crmCanDraft(row);}catch{return false;}};
const canDraft=async row=>{if(row.booking)return false;try{if(await bookedIdentity(redis,{email:row.recipient,domain:row.agencyKey}))return false;}catch{return false;}return row.campaignId===HIRING_DRIP_ID?hiringCanDraft(row):crmCanDraft(row);};
// The last look before a send: the card, and the stop list, read again after the Gmail and Findymail round trips.
const lastCheck=async row=>{if(row.campaignId!==HIRING_DRIP_ID)return true;try{const card=await getRecord(redis,row.hiringId);return !hiringDripStop(card)&&!await isOptedOut({email:row.recipient});}catch{return false;}};
// New Hiring now cards with a verified owner email join the drip a few a tick (api/_hiring-drip.js).
const drip=dripDeps(redis);
// Someone this worker stops (a "not interested" or unsubscribe reply, an exclusion in the email queue) leaves the call
// list too: their Hiring now card is suppressed before the stop list and CRM writes. Paul, 2026-10-30: "removed from our
// view, but removed from any automated contact as well".
// The CRM half may not find a contact (a person never enrolled through it); that is reported on the row, never thrown,
// or one such row would fail every tick from here on. A stop-list write that fails still throws, so it is retried.
const stopEverywhere=async(row,reason)=>{try{await stopHiringCards(redis,{id:row.hiringId||null,email:row.recipient},{why:row.stopped&&row.stopped.why||(row.replyMessageId?'They replied to our email asking to stop':'Excluded in the email queue'),by:row.stopped&&row.stopped.by||'email worker'});}catch{/* the card is re-checked against the stop list whenever it opens */}
 try{return await suppress(row,reason);}catch(e){const m=String(e&&e.message||e);if(/Global suppression write failed/.test(m))throw e;row.crmStopError=m.slice(0,120);
 if(/CRM contact (?:missing|ambiguous)/.test(m))return;row.crmRetryAt=new Date(Date.now()+15*60000).toISOString();return {retry:true};}};
export default makeWorker({unsubscribeLink:row=>{try{return kickLink(row.recipient);}catch{return undefined;}},lastCheck,stops:{take:()=>takeStops(redis),done:n=>doneStops(redis,n)},hiringSupply:(state,cfg)=>hiringSupply({state,cfg,redis,...drip}),dealSupply:supplyDealFollowups,maintain:()=>maintainClients({redis}),redis,KEY,config,access,gmail,history,headers,messageText,mime,compactMessage,assertDraft,supply,canDraft,suppress:stopEverywhere,eligible,quota,dayKey,classify,followup,reconcileThread,callReady,randomUUID,cronSecret:()=>process.env.CRON_SECRET});
