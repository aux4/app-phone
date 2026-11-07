import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const parse = value => typeof value === 'string' ? JSON.parse(value || '{}') : (value || {});
const fail = message => { throw Object.assign(new Error(message), { publicMessage: message }); };
const serviceUrl = () => { const raw=process.env.PHONE_SERVICE_URL || 'http://127.0.0.1:8787'; const url=new URL(raw); if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) fail('Invalid phone provider URL.'); if(url.hostname!=='127.0.0.1'&&url.hostname!=='::1'&&url.hostname!=='localhost'&&!process.env.PHONE_ALLOW_REMOTE) fail('Phone provider must be local.'); return url; };
const post = (url, body) => new Promise((resolve,reject)=>{ const data=JSON.stringify(body); const fn=url.protocol==='https:'?httpsRequest:httpRequest; const req=fn(new URL(url),{method:'POST',headers:{authorization:`Bearer ${process.env.PHONE_SERVICE_SECRET||''}`,'content-type':'application/json','content-length':Buffer.byteLength(data)},timeout:5000},res=>{let out='';res.on('data',c=>out+=c);res.on('end',()=>{try{const parsed=JSON.parse(out); if(res.statusCode>=400) reject(new Error(parsed.error||'phone provider error')); else resolve(parsed);}catch{reject(new Error('phone provider returned invalid data'));}})}); req.on('timeout',()=>req.destroy(new Error('phone provider timeout')));req.on('error',reject);req.end(data); });
const chatDir = async (home) => { try { const registry=JSON.parse(await readFile(join(home,'global.aux4'),'utf8')); return registry.profiles?.find(x=>x.name==='platform:app')?.commands?.find(x=>x.name==='chat')?.ref?.dir || null; } catch { return null; } };
const chatMembers = async (principal, channelId) => {
  const home=process.env.PHONE_CHAT_REGISTRY_HOME || process.env.AUX4_HOME || join(homedir(),'.aux4.config'); const dir=await chatDir(home); if(!dir) fail('Chat is not installed on this VM.');
  return new Promise((resolveResult,reject)=>{ const child=spawn('aux4',['platform','app','chat','channel-view','--principal',JSON.stringify(principal),'--params',JSON.stringify({channelId,id:channelId}),'--body','{}','--query','{}'],{cwd:resolve(dir),env:{...process.env,CHAT_FILES_REGISTRY_HOME:home},stdio:['ignore','pipe','ignore']}); let out=''; child.stdout.on('data',chunk=>{out+=chunk;if(out.length>65536)child.kill();}); child.on('error',reject); child.on('close',code=>{if(code!==0)return reject(new Error('Conversation membership could not be verified.'));try{const value=JSON.parse(out);if(value.error) return reject(new Error('Conversation membership could not be verified.'));const members=(value.members||[]).map(x=>typeof x==='string'?x:(x.id||x.userId)).filter(Boolean);resolveResult(members);}catch{reject(new Error('Conversation membership could not be verified.'));}}); });
};
export async function phoneAction(action, principalValue, bodyValue, queryValue={}) {
  const principal=parse(principalValue); const body=parse(bodyValue); const id=principal.sub||principal.id; if(typeof id!=='string'||!id.trim()||id.length>512) fail('Sign in with your aux4 account to use Phone.');
  if(!process.env.PHONE_SERVICE_SECRET||process.env.PHONE_SERVICE_SECRET.length<32) fail('Phone provider is not configured.');
  const actor={id,name:String(principal.name||principal.preferred_username||principal.email||id).slice(0,160)};
  if(action==='contacts'){ const result=await post(serviceUrl(),{action:'list',actor}); return {selfId:id,people:usersFromCalls(result.calls||[],id)}; }
  if(action==='list'){ const result=await post(serviceUrl(),{action:'list',actor}); const calls=[]; for(const call of result.calls||[]){ if(call.target?.type==='channel'){ try{const members=await chatMembers(principal,call.target.id); if(!members.includes(id)) continue; await post(serviceUrl(),{action:'sync',actor,callId:call.id,allowedMembers:members});}catch{continue;} } calls.push(call); } return {selfId:id,people:[...usersFromCalls(result.calls||[],id)],calls}; }
  if(action==='start'&&body.channelId){ const members=await chatMembers(principal,String(body.channelId)); if(!members.includes(id)) fail('You are not a member of this conversation.'); body.userIds=members.filter(x=>x!==id).slice(0,7); body.allowedMembers=members; await post(serviceUrl(),{action:'register',actor,registerIds:members}); }
  if(action!=='start'&&body.callId && body.channelId){ const members=await chatMembers(principal,String(body.channelId)); if(!members.includes(id)) fail('You are not a member of this conversation.'); body.allowedMembers=members; }
  if(action==='start'&&(!Array.isArray(body.userIds)||body.userIds.some(x=>typeof x!=='string'||x.length>512||x===id))) fail('Choose valid call participants.');
  const payload={action};
  for(const key of ['callId','channelId','title','userIds','to','signal','allowedMembers','registerIds','cursor']) if(Object.hasOwn(body,key)) payload[key]=body[key];
  payload.actor=actor;
  return post(serviceUrl(),payload);
}
const usersFromCalls=(calls,self)=>{const map=new Map();for(const call of calls)for(const p of call.participants||[])if(p.id!==self)map.set(p.id,{id:p.id,name:p.name,status:p.status});return [...map.values()];};
if(import.meta.url===`file://${process.argv[1]}`){const [action,principal,body,query]=process.argv.slice(2); phoneAction(action,principal,body,query).then(value=>process.stdout.write(JSON.stringify(value))).catch(error=>{process.stderr.write(`${error.publicMessage||error.message}\n`);process.exit(1);});}
