#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const port = Number(process.env.PHONE_PORT || 8787);
const host = process.env.PHONE_HOST || '0.0.0.0';
const secret = process.env.PHONE_SERVICE_SECRET;
if (!secret || secret.length < 32) throw new Error('PHONE_SERVICE_SECRET must be a random value of at least 32 characters');
const calls = new Map();
const signals = new Map();
let signalSeq = 0;
const users = new Map();
const now = () => Date.now();
const json = (res, status, value) => { const data = JSON.stringify(value); res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'}); res.end(data); };
const auth = req => { const value = req.headers.authorization || ''; const supplied = Buffer.from(value.replace(/^Bearer\s+/i,'')); const expected = Buffer.from(secret); return supplied.length === expected.length && timingSafeEqual(supplied, expected); };
const read = req => new Promise((resolve,reject)=>{ let data=''; req.on('data', chunk=>{ data += chunk; if(data.length>256*1024) reject(new Error('request too large')); }); req.on('end',()=>{ try{resolve(data?JSON.parse(data):{});}catch{reject(new Error('invalid JSON'));} }); req.on('error',reject); });
const clean = call => { const t=now(); for(const participant of call.participants) if(participant.status==='joined'&&participant.lastSeen&&t-participant.lastSeen>30_000) participant.status='left'; if(t-call.updatedAt>60_000 || (call.status==='ringing' && t-call.createdAt>45_000) || call.participants.every(p=>p.status!=='joined')) { call.status='ended'; call.updatedAt=t; } for(const [id,s] of signals) if(s.callId===call.id && (t-s.createdAt>30_000 || !call.participants.some(p=>p.id===s.from&&p.status==='joined') || !call.participants.some(p=>p.id===s.to&&p.status==='joined'))) signals.delete(id); };
const member = (call, id) => call.participants.find(p=>p.id===id);
const visible = (call, id) => { clean(call); const p=member(call,id); if(!p || p.status==='declined' || p.status==='left') return false; return {id:call.id,target:call.target,title:call.title,status:call.status,createdAt:call.createdAt,updatedAt:call.updatedAt,participants:call.participants.map(({id,name,status,joinedAt})=>({id,name,status,joinedAt}))}; };
const request = async (req,res) => {
  if(req.method==='GET' && req.url==='/health') return json(res,200,{ok:true,provider:'local-webrtc'});
  if(!auth(req)) return json(res,401,{error:'unauthorized'});
  try {
    const body=await read(req); const action=body.action; const actor=body.actor;
    if(!actor || typeof actor.id!=='string' || actor.id.length>512) return json(res,400,{error:'actor required'});
    users.set(actor.id,{id:actor.id,name:String(actor.name||actor.id).slice(0,160)});
    if(Array.isArray(body.registerIds)){for(const userId of body.registerIds.slice(0,100))if(typeof userId==='string'&&userId.length<=512)users.set(userId,{id:userId,name:userId});}
    if(action==='list') { const out=[]; for(const call of calls.values()){const item=visible(call,actor.id); if(item) out.push(item);} return json(res,200,{calls:out}); }
    if(action==='register') return json(res,200,{ok:true});
    if(action==='start') {
      if(!Array.isArray(body.userIds)||body.userIds.length<1||body.userIds.length>8) return json(res,400,{error:'choose one to eight users'});
      if(body.userIds.some(id=>!users.has(id))) return json(res,404,{error:'one or more users are unavailable'});
      const ids=[actor.id,...body.userIds.filter(x=>typeof x==='string')].filter((x,i,a)=>a.indexOf(x)===i); if(ids.length>8) return json(res,400,{error:'up to eight participants'});
      const call={id:randomUUID(),target:body.channelId?{type:'channel',id:String(body.channelId)}:{type:'users',ids:body.userIds},title:String(body.title||'Audio call').slice(0,120),status:'ringing',createdAt:now(),updatedAt:now(),seq:0,participants:ids.map(id=>({id,name:users.get(id)?.name||id,status:id===actor.id?'joined':'ringing',joinedAt:id===actor.id?now():null}))}; calls.set(call.id,call); return json(res,201,{call:visible(call,actor.id),selfId:actor.id});
    }
    if(action==='sync'){const call=calls.get(String(body.callId));if(!call)return json(res,404,{error:'call not found'});if(!Array.isArray(body.allowedMembers)||!body.allowedMembers.includes(actor.id))return json(res,403,{error:'not a conversation member'});for(const p of call.participants)if(!body.allowedMembers.includes(p.id)&&p.status==='joined')p.status='left';call.updatedAt=now();clean(call);return json(res,200,{call:visible(call,actor.id)});}
    if(!['accept','decline','leave','heartbeat','signal','poll'].includes(action)) return json(res,400,{error:'unknown action'});
    const call=calls.get(String(body.callId)); if(!call) return json(res,404,{error:'call not found'}); const p=member(call,actor.id); if(!p) return json(res,403,{error:'not invited'});
    if(action==='accept'){clean(call);if(call.status==='ended'||p.status==='declined'||p.status==='left') return json(res,403,{error:'invitation closed'});p.status='joined';p.joinedAt=now();p.lastSeen=now();call.status='active';call.updatedAt=now();return json(res,200,{call:visible(call,actor.id)});}
    if(action==='decline'||action==='leave'){p.status=action==='decline'?'declined':'left';call.updatedAt=now();if(call.participants.filter(x=>x.status==='joined').length===0)call.status='ended';return json(res,200,{ok:true,call:visible(call,actor.id)});}
    if(action==='heartbeat'){if(p.status!=='joined') return json(res,403,{error:'call is not active'});p.lastSeen=now();call.updatedAt=now();return json(res,200,{call:visible(call,actor.id)});}
    if(p.status!=='joined') return json(res,403,{error:'join the call first'});
    if(action==='poll'){const cursor=Number(body.cursor||0);const pending=[...signals.entries()].filter(([,s])=>s.callId===call.id&&s.to===actor.id&&s.seq>cursor).map(([id,s])=>{signals.delete(id);return {seq:s.seq,from:s.from,signal:s.signal}});return json(res,200,{call:visible(call,actor.id),selfId:actor.id,events:pending,cursor:Math.max(cursor,...pending.map(e=>e.seq),call.seq)});}
    if(typeof body.to!=='string'||!member(call,body.to)||member(call,body.to).status!=='joined') return json(res,403,{error:'recipient is not in this call'});
    if(typeof body.signal!=='object'||JSON.stringify(body.signal).length>64*1024)return json(res,400,{error:'invalid signal'});
    const seq=++signalSeq; call.seq=seq; signals.set(randomUUID(),{callId:call.id,from:actor.id,to:body.to,signal:body.signal,seq,createdAt:now()}); return json(res,200,{ok:true,seq});
  } catch(error) { return json(res,400,{error:error.message||'bad request'}); }
};
createServer(request).listen(port,host,()=>console.log(`local phone provider listening on ${host}:${port}`));
