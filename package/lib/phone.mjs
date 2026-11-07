import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
const parse=value=>typeof value==='string'?JSON.parse(value||'{}'):(value||{});
const fail=message=>{throw new Error(message);};
export const publicActions=new Set(['contacts','list','start','accept','decline','leave','heartbeat','poll','signal']);
export async function providerRequest(input) {
  const url=new URL(process.env.PHONE_SERVICE_URL||'http://127.0.0.1:8787');
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!['127.0.0.1','[::1]','localhost'].includes(url.hostname))fail('Phone provider must use a loopback address.');
  const secret=process.env.PHONE_SERVICE_SECRET;
  if(!secret||secret.length<32)fail('Phone provider is not configured.');
  const response=await fetch(url,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(5000)});
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>2097152)fail('Phone provider response too large.');chunks.push(chunk);}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!response.ok||data.error)fail(data.error||'Phone service unavailable.');return data;
}
export async function chatCommand(action,principal,channelId) {
  const home=process.env.PHONE_CHAT_REGISTRY_HOME||process.env.AUX4_HOME||join(homedir(),'.aux4.config');
  let registry;try{registry=JSON.parse(await readFile(join(home,'global.aux4'),'utf8'));}catch{return null;}
  const dir=registry.profiles?.find(p=>p.name==='platform:app')?.commands.find(c=>c.name==='chat')?.ref?.dir;
  if(!dir)return null;
  const {stdout}=await exec('aux4',['platform','app','chat',action,'--principal',JSON.stringify(principal),'--params',JSON.stringify(channelId?{channelId}:{}),'--body','{}','--query','{}'],{cwd:resolve(dir),env:{...process.env,CHAT_FILES_REGISTRY_HOME:home},timeout:10000,maxBuffer:2097152});
  const data=JSON.parse(stdout);if(!Array.isArray(data))fail('Conversation membership could not be verified.');return data;
}
// Dependencies are injectable for authorization tests; HTTP never controls them.
export async function phoneAction(action,principalValue,bodyValue,queryValue={},deps={}) {
  if(!publicActions.has(action))fail('Unknown phone action.');
  const principal=parse(principalValue),body=parse(bodyValue),id=principal.sub||principal.id;
  if(typeof id!=='string'||!id.trim()||id.length>512)fail('Sign in with your aux4 account to use Phone.');
  const actor={id,name:String(principal.name||principal.preferred_username||principal.email||id).slice(0,160),email:String(principal.email||'')};
  const send=input=>(deps.provider||providerRequest)({...input,actor});
  const chat=(command,channelId)=>(deps.chat||chatCommand)(command,principal,channelId);
  const authorize=async call=>{
    if(call.target?.type!=='channel')return undefined;
    let members;
    try{members=await chat('channel-users',call.target.id);}catch{}
    if(!members?.some(p=>p.id===id)){
      await send({action:'revoke',callId:call.id});fail('Conversation unavailable.');
    }
    return members;
  };
  if(action==='contacts'||action==='start') {
    // Existing Chat directory is optional. Standalone Phone registers users on
    // their first verified SSO request; no browser may register another identity.
    const people=await chat('users');
    if(people)await send({action:'register',users:people});
  }
  if(action==='contacts')return send({action:'contacts'});
  if(action==='list') {
    const result=await send({action:'list'}),calls=[];
    for(const call of result.calls) {
      try{
        const channelMembers=await authorize(call);
        const current=channelMembers?(await send({action:'sync',callId:call.id,channelMembers})).call:call;
        calls.push(current);
      }catch{/* A missing or revoked channel is not disclosed. */}
    }
    return {selfId:id,calls};
  }
  if(action==='start') {
    let channelMembers;
    if(body.channelId){channelMembers=await chat('channel-users',String(body.channelId));if(!channelMembers?.some(p=>p.id===id))fail('Conversation unavailable.');await send({action:'register',users:channelMembers});}
    return send({action:'start',userIds:body.userIds,channelId:body.channelId?String(body.channelId):undefined,channelMembers,title:body.title});
  }
  if(typeof body.callId!=='string')fail('Choose a call.');
  const {call}=await send({action:'get',callId:body.callId});
  const channelMembers=await authorize(call);
  // Authority is resolved above; never forward actor, allowedMembers, registerIds
  // or channelId from the browser. Stored call target decides authorization.
  return send({action,callId:call.id,channelMembers,to:body.to,signal:body.signal,cursor:body.cursor});
}
if(import.meta.url===`file://${process.argv[1]}`){
  const [action,principal,body,query]=process.argv.slice(2);
  phoneAction(action,principal,body,query).then(result=>process.stdout.write(JSON.stringify(result))).catch(error=>{
    process.stdout.write(JSON.stringify({statusCode:403,headers:{'Content-Type':'application/json'},body:JSON.stringify({error:error.message})}));
  });
}
