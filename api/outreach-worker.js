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
// Nothing is drafted or sent to a lead whose email or company booked a Discovery call, even one that reached
// the queue after the booking (api/_booked-leads.js). An unreadable booking list holds the row: fail closed.
const canDraft=async row=>{if(row.booking)return false;try{if(await bookedIdentity(redis,{email:row.recipient,domain:row.agencyKey}))return false;}catch{return false;}return crmCanDraft(row);};
export default makeWorker({dealSupply:supplyDealFollowups,maintain:()=>maintainClients({redis}),redis,KEY,config,access,gmail,history,headers,messageText,mime,compactMessage,assertDraft,supply,canDraft,suppress,eligible,quota,dayKey,classify,followup,reconcileThread,callReady,randomUUID,cronSecret:()=>process.env.CRON_SECRET});
