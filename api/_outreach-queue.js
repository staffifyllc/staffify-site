import {callReady} from './_outreach-policy.js';
export const KEY = 'staffify:outreach-review:v1';
export const SENDERS = ['paul@trystaffify.com','paul@staffifyhq.com','hello@gostaffify.com','paul@hirestaffify.com','madison@gostaffify.com','madison@staffifyhq.com','madison@trystaffify.com','madison@hirestaffify.com','madison.sterling@trystaffify.com'];
export function ownerFor(rep) {
  if (rep?.role === 'admin') return 'all';
  if (SENDERS.slice(4).includes(rep?.email?.toLowerCase())) return 'Madison';
  if (SENDERS.slice(0,4).includes(rep?.email?.toLowerCase())) return 'Paul';
  return null;
}
export function visibleState(state, owner) {
  const s=state || {revision:0,records:[],assignments:[],suppressions:[],pausedOwners:[],updatedAt:null};
  const records=s.records.filter(r=>owner==='all'||r.owner===owner).map(r=>({...r,callReady:callReady(r)&&!s.pausedOwners?.includes(r.owner)&&!s.suppressions?.includes(r.recipient)}));
  return {...s,records,assignments:s.assignments.filter(r=>owner==='all'||r.owner===owner),suppressions:owner==='all'?s.suppressions:s.suppressions.filter(e=>records.some(r=>r.recipient===e)),workerFresh:!!(s.queueUpdatedAt||s.updatedAt) && Date.now()-Date.parse(s.queueUpdatedAt||s.updatedAt)<90*60*1000};
}
export function mergeSnapshot(previous, incoming, now=new Date().toISOString()) {
  if (!Array.isArray(incoming.records)||!Array.isArray(incoming.assignments)||incoming.records.length>10000) throw Error('Invalid snapshot');
  const assignments=previous?.assignments?.length?previous.assignments:incoming.assignments;
  const assignment=new Map(assignments.map(a=>[String(a.email).toLowerCase(),a.owner]));
  const agencyOwners=new Map(assignments.map(a=>[a.agencyKey,a.owner]));
  const suppressed=new Set([...(previous?.suppressions||[]),...(incoming.suppressions||[])].map(e=>String(e).toLowerCase()));
  const ids=new Set();
  const records=incoming.records.map(r=>{
    if(!r.id||ids.has(r.id)||!SENDERS.includes(r.sender)||!['Paul','Madison'].includes(r.owner))throw Error('Invalid record');
    ids.add(r.id);
    const recipient=String(r.recipient||'').toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))throw Error('Invalid recipient');
    const owner=assignment.get(recipient)||agencyOwners.get(r.agencyKey)||r.owner;
    const ownershipHold=owner==='Madison'&&!SENDERS.slice(4).includes(r.sender);
    return {...r,recipient,owner,status:suppressed.has(recipient)?'suppressed':ownershipHold?'reserved_for_madison_external':r.status};
  });
  return {revision:(previous?.revision||0)+1,records,assignments,suppressions:[...suppressed],pausedOwners:previous?.pausedOwners||[],updatedAt:now,mailboxes:incoming.mailboxes||[],lastWorkerError:incoming.lastWorkerError||null};
}
export function controlState(previous, {action,owner,email}, actor) {
  if (!previous) throw Error('Queue not initialized');
  if (action==='pause'||action==='resume') {
    if(!['Paul','Madison'].includes(owner)||(actor!=='all'&&actor!==owner))throw Error('Forbidden');
    const paused=new Set(previous.pausedOwners||[]);action==='pause'?paused.add(owner):paused.delete(owner);
    return {...previous,pausedOwners:[...paused],revision:previous.revision+1};
  }
  if(action==='suppress') {
    email=String(email||'').toLowerCase();
    if(!previous.records.some(r=>r.recipient===email&&(actor==='all'||r.owner===actor)))throw Error('Forbidden');
    return {...previous,revision:previous.revision+1,suppressions:[...new Set([...previous.suppressions,email])],records:previous.records.map(r=>r.recipient===email?{...r,status:'suppressed'}:r)};
  }
  throw Error('Unknown action');
}
