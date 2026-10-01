import {redis,readBody} from './_auth.js';
import {KEY} from './_outreach-queue.js';
import {config} from './_outreach-gmail.js';
import {draftBlockReason} from './_outreach-crm.js';
import {site} from './_outreach-supply.js';
import {verifyEmail} from './_outreach-verification.js';
import {isOptedOut} from './_optout.js';
import {clientCheck} from './_client-guard.js';
import {makeLeadPrep} from './_outreach-lead-prep-core.js';
async function hubspot(path,body,method='POST'){const r=await fetch('https://api.hubapi.com'+path,{method,headers:{Authorization:'Bearer '+process.env.HUBSPOT_TOKEN,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('CRM unavailable ('+r.status+')');return r.json();}
export default makeLeadPrep({redis,readBody,config,draftBlockReason,site,verifyEmail,isOptedOut,clientCheck,hs:hubspot,KEY});
