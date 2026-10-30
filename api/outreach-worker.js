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
import {HIRING_DRIP_ID,hiringDripStop} from './_hiring-drip-copy.js';
import {hiringSupply} from './_hiring-drip.js';
import {dripDeps} from './_hiring-drip-live.js';
import {getRecord} from './_hiring-intent.js';
// Nothing is drafted or sent to a lead whose email or company booked a Discovery call, even one that reached
// the queue after the booking (api/_booked-leads.js). An unreadable booking list holds the row: fail closed.
// A Hiring now row also stops on its own card (a caller reached them, a booking, a closed posting, a changed address),
// and any read that fails holds that row (crm_hold) instead of failing the tick for every campaign.
const hiringCanDraft=async row=>{try{const card=await getRecord(redis,row.hiringId);if(hiringDripStop(card)||String(card.contact.email||'').toLowerCase()!==row.recipient)return false;return await crmCanDraft(row);}catch{return false;}};
const canDraft=async row=>{if(row.booking)return false;try{if(await bookedIdentity(redis,{email:row.recipient,domain:row.agencyKey}))return false;}catch{return false;}return row.campaignId===HIRING_DRIP_ID?hiringCanDraft(row):crmCanDraft(row);};
// New Hiring now cards with a verified owner email join the drip a few a tick (api/_hiring-drip.js).
const drip=dripDeps(redis);
export default makeWorker({hiringSupply:(state,cfg)=>hiringSupply({state,cfg,redis,...drip}),dealSupply:supplyDealFollowups,maintain:()=>maintainClients({redis}),redis,KEY,config,access,gmail,history,headers,messageText,mime,compactMessage,assertDraft,supply,canDraft,suppress,eligible,quota,dayKey,classify,followup,reconcileThread,callReady,randomUUID,cronSecret:()=>process.env.CRON_SECRET});
