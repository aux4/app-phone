import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const parse = value => typeof value === 'string' ? JSON.parse(value || '{}') : (value || {});
const fail = message => { throw Object.assign(new Error(message), { publicMessage: message }); };
const serviceUrl = () => { const raw=process.env.PHONE_SERVICE_URL || 'http://127.0.0.1:8787'; const url=new URL(raw); if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) fail('Invalid phone provider URL.'); if(url.hostname!=='127.0.0.1'&&url.hostname!=='::1'&&url.hostname!=='localhost'&&!process.env.PHONE_ALLOW_REMOTE) fail('Phone provider must be local.'); return url; };
const post = (url, body) => new Promise((resolve,reject)=>{ const data=JSON.stringify(body); const fn=url.protocol==='https:'?httpsRequest:httpRequest; const req=fn(new URL(url),{method:'POST',headers:{authorization:`Bearer ${process.env.PHONE_SERVICE_SECRET||''}`,'content-type':'application/json','content-length':Buffer.byteLength(data)},timeout:5000},res=>{let out='';res.on('data',c=>out+=c);res.on('end',()=>{try{const parsed=JSON.parse(out); if(res.statusCode>=400) reject(new Error(parsed.error||'phone provider error')); else resolve(parsed);}catch{reject(new Error('phone provider returned invalid data'));}})}); req.on('timeout',()=>req.destroy(new Error('phone provider timeout')));req.on('error',reject);req.end(data); });
export async function phoneAction(action, principalValue, bodyValue, queryValue={}) {
  const principal=parse(principalValue); const body=parse(bodyValue); const id=principal.sub||principal.id; if(typeof id!=='string'||!id.trim()||id.length>512) fail('Sign in with your aux4 account to use Phone.');
  if(!process.env.PHONE_SERVICE_SECRET||process.env.PHONE_SERVICE_SECRET.length<32) fail('Phone provider is not configured.');
  const actor={id,name:String(principal.name||principal.preferred_username||principal.email||id).slice(0,160)};
  if(action==='start'&&body.channelId){ if(!process.env.PHONE_CHAT_AUTHZ_URL) fail('Channel calling is unavailable until Chat is connected.'); const authz=await post(new URL(process.env.PHONE_CHAT_AUTHZ_URL),{action:'channel-members',principal,channelId:String(body.channelId)}); if(authz.authorized!==true||!Array.isArray(authz.members)||!authz.members.includes(id)) fail('You are not a member of this conversation.'); body.userIds=authz.members.filter(x=>x!==id).slice(0,7); }
  if(action==='start'&&(!Array.isArray(body.userIds)||body.userIds.some(x=>typeof x!=='string'||x.length>512||x===id))) fail('Choose valid call participants.');
  const payload={action};
  for(const key of ['callId','channelId','title','userIds','to','signal']) if(Object.hasOwn(body,key)) payload[key]=body[key];
  payload.actor=actor;
  return post(serviceUrl(),payload);
}
if(import.meta.url===`file://${process.argv[1]}`){const [action,principal,body,query]=process.argv.slice(2); phoneAction(action,principal,body,query).then(value=>process.stdout.write(JSON.stringify(value))).catch(error=>{process.stderr.write(`${error.publicMessage||error.message}\n`);process.exit(1);});}
