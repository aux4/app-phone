#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const port = Number(process.env.PHONE_PORT || 8787);
const host = process.env.PHONE_HOST || '0.0.0.0';
const secret = process.env.PHONE_SERVICE_SECRET;
if (!secret || secret.length < 32) throw new Error('PHONE_SERVICE_SECRET must be a random value of at least 32 characters');
const calls = new Map();
const signals = new Map();
const users = new Map();
const now = () => Date.now();
const json = (res, status, value) => { const data = JSON.stringify(value); res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'}); res.end(data); };
const auth = req => { const value = req.headers.authorization || ''; const supplied = Buffer.from(value.replace(/^Bearer\s+/i,'')); const expected = Buffer.from(secret); return supplied.length === expected.length && timingSafeEqual(supplied, expected); };
const read = req => new Promise((resolve,reject)=>{ let data=''; req.on('data', chunk=>{ data += chunk; if(data.length>256*1024) reject(new Error('request too large')); }); req.on('end',()=>{ try{resolve(data?JSON.parse(data):{});}catch{reject(new Error('invalid JSON'));} }); req.on('error',reject); });
const clean = call => { if(now()-call.updatedAt>60_000 || (call.status==='ringing' && now()-call.createdAt>45_000)) { call.status='ended'; call.updatedAt=now(); } for(const [id,s] of signals) if(s.callId===call.id && now()-s.createdAt>30_000) signals.delete(id); };
const member = (call, id) => call.participants.find(p=>p.id===id);
const visible = (call, id) => { clean(call); const p=member(call,id); if(!p || p.status==='declined' || p.status==='left') return false; return {id:call.id,target:call.target,title:call.title,status:call.status,createdAt:call.createdAt,updatedAt:call.updatedAt,participants:call.participants.map(({id,name,status,joinedAt})=>({id,name,status,joinedAt}))}; };
const request = async (req,res) => {
  if(req.method==='GET' && req.url==='/health') return json(res,200,{ok:true,provider:'local-webrtc'});
  if(!auth(req)) return json(res,401,{error:'unauthorized'});
  try {
    const body=await read(req); const action=body.action; const actor=body.actor;
    if(!actor || typeof actor.id!=='string' || actor.id.length>512) return json(res,400,{error:'actor required'});
    users.set(actor.id,{id:actor.id,name:String(actor.name||actor.id).slice(0,160)});
    if(action==='list') { const out=[]; for(const call of calls.values()){const item=visible(call,actor.id); if(item) out.push(item);} return json(res,200,{calls:out}); }
    if(action==='start') {
      if(!Array.isArray(body.userIds)||body.userIds.length<1||body.userIds.length>8) return json(res,400,{error:'choose one to eight users'});
      const ids=[actor.id,...body.userIds.filter(x=>typeof x==='string')].filter((x,i,a)=>a.indexOf(x)===i); if(ids.length>8) return json(res,400,{error:'up to eight participants'});
      const call={id:randomUUID(),target:body.channelId?{type:'channel',id:String(body.channelId)}:{type:'users',ids:body.userIds},title:String(body.title||'Audio call').slice(0,120),status:'ringing',createdAt:now(),updatedAt:now(),participants:ids.map(id=>({id,name:users.get(id)?.name||id,status:id===actor.id?'joined':'ringing',joinedAt:id===actor.id?now():null}))}; calls.set(call.id,call); return json(res,201,{call:visible(call,actor.id)});
    }
    if(!['accept','decline','leave','heartbeat','signal','poll'].includes(action)) return json(res,400,{error:'unknown action'});
    const call=calls.get(String(body.callId)); if(!call) return json(res,404,{error:'call not found'}); const p=member(call,actor.id); if(!p) return json(res,403,{error:'not invited'});
    if(action==='accept'){if(p.status==='declined'||p.status==='left') return json(res,403,{error:'invitation closed'});p.status='joined';p.joinedAt=now();call.status='active';call.updatedAt=now();return json(res,200,{call:visible(call,actor.id)});}
    if(action==='decline'||action==='leave'){p.status=action==='decline'?'declined':'left';call.updatedAt=now();if(call.participants.filter(x=>x.status==='joined').length===0)call.status='ended';return json(res,200,{ok:true,call:visible(call,actor.id)});}
    if(action==='heartbeat'){if(p.status!=='joined') return json(res,403,{error:'call is not active'});p.lastSeen=now();call.updatedAt=now();return json(res,200,{call:visible(call,actor.id)});}
    if(p.status!=='joined') return json(res,403,{error:'join the call first'});
    if(action==='poll'){const pending=[...signals.entries()].filter(([,s])=>s.callId===call.id&&s.to===actor.id).map(([id,s])=>{signals.delete(id);return {from:s.from,signal:s.signal,id}});return json(res,200,{call:visible(call,actor.id),signals:pending});}
    if(typeof body.to!=='string'||!member(call,body.to)||member(call,body.to).status!=='joined') return json(res,403,{error:'recipient is not in this call'});
    if(typeof body.signal!=='object'||JSON.stringify(body.signal).length>64*1024)return json(res,400,{error:'invalid signal'});
    signals.set(randomUUID(),{callId:call.id,from:actor.id,to:body.to,signal:body.signal,createdAt:now()}); const pending=[...signals.values()].filter(s=>s.callId===call.id&&s.to===actor.id).map(s=>s.signal); for(const [id,s] of signals) if(s.callId===call.id&&s.to===actor.id) signals.delete(id); return json(res,200,{call:visible(call,actor.id),signals:pending});
  } catch(error) { return json(res,400,{error:error.message||'bad request'}); }
};
createServer(request).listen(port,host,()=>console.log(`local phone provider listening on ${host}:${port}`));
