import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LocalAudioSession,CallController} from '../package/static/phone.js';
test('media session queues early ICE and uses one deterministic offerer',async()=>{
 const events=[];class Peer{constructor(){this.remoteDescription=null;this.localDescription=null;}addTrack(){} async createOffer(){return {type:'offer',sdp:'sdp'};}async createAnswer(){return {type:'answer',sdp:'sdp'};}async setLocalDescription(d){this.localDescription={...d,toJSON:()=>d};}async setRemoteDescription(d){this.remoteDescription=d;}async addIceCandidate(c){events.push(['ice',c]);}close(){events.push(['closed']);}}
 const previous=globalThis.RTCPeerConnection;globalThis.RTCPeerConnection=Peer;
 try{const stream={getTracks:()=>[],getAudioTracks:()=>[]};const sent=[];const session=new LocalAudioSession(stream,'bob',async(to,signal)=>sent.push({to,signal}),()=>{});
 await session.sync([{id:'alice',status:'joined'},{id:'bob',status:'joined'}]);assert.equal(sent.length,0);
 await session.receive({from:'alice',signal:{type:'ice',candidate:{candidate:'early'}}});assert.equal(events.length,0);
 await session.receive({from:'alice',signal:{type:'offer',description:{type:'offer',sdp:'sdp'}}});assert.equal(events[0][0],'ice');assert.equal(sent[0].signal.type,'answer');
 await session.sync([{id:'bob',status:'joined'}]);assert.equal(session.peers.size,0);
 }finally{globalThis.RTCPeerConnection=previous;}
});
test('failed call setup stops microphone and clears busy state',async()=>{
 const controller=new CallController();let stopped=0;controller.acquire=async()=>({getTracks:()=>[{stop:()=>stopped++}]});controller.request=async()=>{throw Error('Denied');};
 await assert.rejects(controller.start({userId:'bob'}),/Denied/);assert.equal(stopped,1);assert.equal(controller.busy,false);assert.equal(controller.call,null);
});
test('hangup stops media immediately even when server is unavailable',async()=>{
 const controller=new CallController();let closed=false;controller.call={id:'c'};controller.media={close:()=>closed=true};controller.request=async()=>{throw Error('offline');};
 await controller.leave();assert.equal(closed,true);assert.equal(controller.call,null);
});
