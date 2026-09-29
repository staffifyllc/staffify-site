// Private machine bridge for the existing local finance importer; never available to Hub users.
import {redis,readBody} from './_auth.js';
import {financeMachine} from './_finance-access.js';
import {getAccessToken} from './_qbo.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');
 if(req.method!=='POST'||!financeMachine(req))return res.status(401).json({error:'Unauthorized'});
 const b=readBody(req);
 if(b.action==='initialize'){
  if(!process.env.QB_REALM_ID||String(b.realmId)!==process.env.QB_REALM_ID||typeof b.refreshToken!=='string'||b.refreshToken.length<20)return res.status(400).json({error:'Invalid Staffify connection'});
  // Never replace a rotated token or an established authorization.
  const added=await redis.hsetnx('qb:tokens','refresh_token',b.refreshToken);
  if(added)await redis.hset('qb:tokens',{realm_id:process.env.QB_REALM_ID});
  return res.status(200).json({initialized:!!added});
 }
 if(b.action!=='access')return res.status(400).json({error:'Unknown action'});
 try{return res.status(200).json({access_token:await getAccessToken(),realm_id:process.env.QB_REALM_ID});}
 catch{return res.status(503).json({error:'QuickBooks authorization could not be refreshed'});}
}
