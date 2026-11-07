import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {phoneAction} from '../package/lib/phone.mjs';
import {LocalCallProvider} from '../package/lib/local-provider.mjs';
const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'phone-chat-'));
const chat=resolve(import.meta.dirname,'../../app-agent-chat-AIP-013/package');
const old={CHAT_DB:process.env.CHAT_DB,PHONE_CHAT_REGISTRY_HOME:process.env.PHONE_CHAT_REGISTRY_HOME};
try{
 process.env.CHAT_DB=join(root,'chat.db');process.env.PHONE_CHAT_REGISTRY_HOME=root;
 await writeFile(join(root,'global.aux4'),JSON.stringify({profiles:[{name:'platform:app',commands:[{name:'chat',ref:{dir:chat}}]}]}));
 const invoke=async(user,action,body={})=>JSON.parse((await exec('aux4',['platform','app','chat',action,'--principal',JSON.stringify({sub:user,name:user}),'--params','{}','--body',JSON.stringify(body),'--query','{}'],{cwd:chat,env:process.env,timeout:15000})).stdout);
 await invoke('alice','users');await invoke('bob','users');
 const created=await invoke('alice','dm-create',{userId:'bob'});
 const provider=new LocalCallProvider();const deps={provider:input=>provider.execute(input.action,input)};
 const contacts=await phoneAction('contacts',{sub:'alice'}, {},{},deps);assert.equal(contacts.people.some(p=>p.id==='bob'),true);
 const result=await phoneAction('start',{sub:'alice'},{channelId:created.channelId||created.id},{},deps);assert.equal(result.call.participants.length,2);
 const accepted=await phoneAction('accept',{sub:'bob'},{callId:result.call.id},{},deps);assert.equal(accepted.call.status,'active');
 console.log('PASS: actual registered Chat CLI directory, DM membership, Phone start and accept with derived channel');
}finally{for(const [key,value]of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;await rm(root,{recursive:true,force:true});}
