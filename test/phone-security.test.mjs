import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LocalCallProvider} from '../package/lib/local-provider.mjs';
import {phoneAction} from '../package/lib/phone.mjs';
const setup=()=>{
 let time=1000;const provider=new LocalCallProvider({clock:()=>time});let members=[{id:'alice',name:'Alice'},{id:'bob',name:'Bob'}];
 const deps={provider:input=>provider.execute(input.action,input),chat:async action=>action==='channel-users'?members:members};
 const act=(who,action,body={})=>phoneAction(action,{sub:who,name:who},body,{},deps);
 return {provider,act,deps,advance:ms=>time+=ms,members:value=>members=value};
};
test('identity spoofing and directory injection cannot create participants',async()=>{
 const {act,provider}=setup();await act('alice','contacts');
 await assert.rejects(act('alice','start',{userIds:['fake'],registerIds:['fake'],actor:{id:'bob'}}),/available contacts/);
 assert.equal(provider.users.has('fake'),false);
 const {call}=await act('alice','start',{userIds:['bob'],actor:{id:'bob'}});
 assert.equal(call.participants.find(p=>p.status==='joined').id,'alice');
 await assert.rejects(act('eve','accept',{callId:call.id}),/unavailable/);
 await assert.rejects(act('alice','register',{users:[{id:'fake'}]}),/Unknown/);
});
test('channel target derives from stored call; omission and substitution do not bypass revocation',async()=>{
 const {act,members}=setup();const {call}=await act('alice','start',{channelId:'private'});
 await act('bob','accept',{callId:call.id});members([{id:'alice',name:'Alice'}]);
 for(const action of ['poll','signal','heartbeat','accept'])await assert.rejects(act('bob',action,{callId:call.id,channelId:'fake',to:'alice',signal:{type:'offer'}}),/Conversation unavailable/);
 assert.deepEqual((await act('bob','list')).calls,[]);
 assert.equal((await act('alice','list')).calls[0].participants.find(p=>p.id==='bob').status,'left');
});
test('signals remain private, cursor retries work, declines never heartbeat into call',async()=>{
 const {act}=setup();const {call}=await act('alice','start',{userIds:['bob']});
 await act('bob','decline',{callId:call.id});await assert.rejects(act('bob','heartbeat',{callId:call.id}),/Join/);
 await act('bob','accept',{callId:call.id});
 await act('alice','signal',{callId:call.id,to:'bob',signal:{type:'offer',description:{type:'offer',sdp:'test'}}});
 const b=await act('bob','poll',{callId:call.id});assert.equal(b.events.length,1);assert.equal(b.events[0].from,'alice');
 assert.equal((await act('bob','poll',{callId:call.id})).events.length,1);
 assert.equal((await act('bob','poll',{callId:call.id,cursor:b.cursor})).events.length,0);
 assert.equal((await act('alice','poll',{callId:call.id})).events.length,0);
 await assert.rejects(act('eve','poll',{callId:call.id}),/unavailable/);
 await act('bob','leave',{callId:call.id});await assert.rejects(act('bob','heartbeat',{callId:call.id}),/ended/);
});
test('caller heartbeat expiry ends call before accept or heartbeat',async()=>{
 const {act,advance}=setup();const {call}=await act('alice','start',{userIds:['bob']});advance(31000);
 await assert.rejects(act('alice','heartbeat',{callId:call.id}),/ended/);await assert.rejects(act('bob','accept',{callId:call.id}),/ended/);
});
test('standalone authenticated users discover each other before any call',async()=>{
 const {deps}=setup();deps.chat=async()=>null;
 await phoneAction('contacts',{sub:'alice'}, {},{},deps);await phoneAction('contacts',{sub:'bob'}, {},{},deps);
 assert.deepEqual((await phoneAction('contacts',{sub:'alice'}, {},{},deps)).people.map(p=>p.id),['bob']);
});
test('channel invitations include all members, with explicit active capacity',async()=>{
 const {act,members}=setup();members(Array.from({length:12},(_,i)=>({id:i?'u'+i:'alice',name:'User '+i})));
 const {call}=await act('alice','start',{channelId:'large'});assert.equal(call.participants.length,12);
 for(let i=1;i<=7;i++)await act('u'+i,'accept',{callId:call.id});
 await assert.rejects(act('u8','accept',{callId:call.id}),/eight/);
});
