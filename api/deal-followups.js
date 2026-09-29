import {redis,requireAccess} from './_auth.js';
import {ownerFor} from './_outreach-queue.js';
import {DEAL_QUEUE} from './_deal-followups.js';
export default async function handler(req,res){res.setHeader('Cache-Control','private, no-store');if(req.method!=='GET')return res.status(405).json({error:'Read only'});const who=await requireAccess(req),owner=ownerFor(who);if(!owner)return res.status(401).json({error:'Sign in'});const queue=await redis.get(DEAL_QUEUE);return res.status(200).json({updatedAt:queue?.updatedAt||null,rows:(queue?.rows||[]).filter(r=>owner==='all'||r.owner===owner).map(r=>({id:r.id,name:r.properties.dealname,stage:r.stage,owner:r.owner||'Unassigned',status:r.status||'Awaiting check',reason:r.reason,recordId:r.recordId,checkedAt:r.checkedAt}))});}
