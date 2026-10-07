import {timingSafeEqual} from 'node:crypto';
import {redis} from './_auth.js';
import {config} from './_outreach-gmail.js';
import {KEY} from './_outreach-queue.js';
import {outreachReport} from './_outreach-report.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');const expected=process.env.OUTREACH_REPORT_TOKEN;const supplied=String(req.headers.authorization||'').replace(/^Bearer /,'');
 if(!expected||Buffer.byteLength(supplied)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return res.status(401).json({error:'Unauthorized'});
 if(req.method!=='GET')return res.status(405).json({error:'Read only'});
 try{const [state,cfg,health,lastRun,leadPreparation]=await Promise.all([redis.get(KEY),config(),redis.get('outreach:cloud:health'),redis.get('outreach:cloud:last-run'),redis.get('staffify:lead-prep:last-run')]);if(!state)throw Error('Queue unavailable');return res.status(200).json({...outreachReport({state,config:cfg,health,lastRun,validated:process.env.OUTREACH_WORKER_VERIFIED==='true'}),leadPreparation});}catch{return res.status(503).json({error:'Current outreach activity unavailable'});}
}
