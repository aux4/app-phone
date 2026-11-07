import { randomUUID } from 'node:crypto';
const reject = (message, status=403) => { throw Object.assign(new Error(message), {status}); };
// Local signaling provider. Calls are ephemeral and expire on restart; media is
// encrypted browser-to-browser. Other providers implement execute(action,input).
export class LocalCallProvider {
  constructor({clock=Date.now}={}) { this.clock=clock;this.calls=new Map();this.users=new Map();this.signals=[];this.sequence=0; }
  clean() {
    const now=this.clock();
    for(const [id,call] of this.calls) {
      if(call.status==='ended') {if(now-call.endedAt>86400000)this.calls.delete(id);continue;}
      for(const p of call.participants) {
        if(p.status==='joined'&&now-p.lastSeen>30000)p.status='left';
        if(p.status==='ringing'&&now-call.createdAt>45000)p.status='missed';
      }
      if(!call.participants.some(p=>p.status==='joined') || (call.participants.filter(p=>p.status==='joined').length===1&&!call.participants.some(p=>p.status==='ringing')&&call.wasConnected)) {call.status='ended';call.endedAt=now;}
      if(call.status==='ringing'&&now-call.createdAt>45000){call.status='ended';call.endedAt=now;}
    }
    this.signals=this.signals.filter(s=> {
      const c=this.calls.get(s.callId);
      return c?.status!=='ended'&&now-s.createdAt<30000&&[s.from,s.to].every(id=>c?.participants.some(p=>p.id===id&&p.status==='joined'));
    });
  }
  view(call) { return structuredClone(call); }
  execute(action,body) {
    this.clean();const actor=body.actor;
    if(!actor||typeof actor.id!=='string'||!actor.id.trim()||actor.id.length>512)reject('Sign in to use Phone.',401);
    this.users.set(actor.id,{id:actor.id,name:String(actor.name||actor.id).slice(0,160),email:String(actor.email||'').slice(0,256)});
    const selfId=actor.id;
    if(action==='register') {
      for(const user of body.users||[]) if(typeof user.id==='string'&&user.id.length<=512)this.users.set(user.id,{id:user.id,name:String(user.name||user.id).slice(0,160),email:String(user.email||'').slice(0,256)});
      return {selfId};
    }
    if(action==='contacts')return {selfId,people:[...this.users.values()].filter(p=>p.id!==selfId).sort((a,b)=>a.name.localeCompare(b.name))};
    if(action==='list')return {selfId,calls:[...this.calls.values()].filter(c=>c.participants.some(p=>p.id===selfId)).map(c=>this.view(c))};
    if(action==='start') {
      if([...this.calls.values()].some(c=>c.status!=='ended'&&c.participants.some(p=>p.id===selfId&&p.status==='joined')))reject('You are already on a call.');
      let ids=body.channelId?body.channelMembers?.map(p=>p.id):body.userIds;
      if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!this.users.has(id)))reject('Choose available contacts.');
      ids=[...new Set([selfId,...ids])]; if(ids.length<2||ids.length>100||(!body.channelId&&ids.length>8))reject('Choose one to seven contacts, or a channel.');
      if(body.channelId) {
        if(!body.channelMembers.some(p=>p.id===selfId))reject('Conversation unavailable.');
        const existing=[...this.calls.values()].find(c=>c.status!=='ended'&&c.target.type==='channel'&&c.target.id===body.channelId);
        if(existing)return this.execute('accept',{...body,callId:existing.id});
      }
      if(this.calls.size>=2000)reject('Too many recent calls. Try again later.',429);
      const now=this.clock();const call={id:randomUUID(),title:String(body.title||'Audio call').slice(0,120),target:body.channelId?{type:'channel',id:body.channelId}:{type:'users'},status:'ringing',createdAt:now,participants:ids.map(id=>({id,name:this.users.get(id).name,status:id===selfId?'joined':'ringing',lastSeen:now})),wasConnected:false};
      this.calls.set(call.id,call);return {selfId,call:this.view(call)};
    }
    const call=this.calls.get(body.callId);
    if(call?.target.type==='channel'&&Array.isArray(body.channelMembers)&&body.channelMembers.some(p=>p.id===selfId)) {
      for(const user of body.channelMembers.slice(0,100))if(!call.participants.some(p=>p.id===user.id))call.participants.push({id:user.id,name:user.name,status:'ringing',lastSeen:this.clock()});
    }
    const p=call?.participants.find(p=>p.id===selfId);
    if(!p)reject('Call unavailable.',404);
    if(action==='get')return {selfId,call:this.view(call)};
    if(action==='revoke'){p.status='left';this.clean();return {selfId};}
    if(call.target.type==='channel') {
      if(!Array.isArray(body.channelMembers))reject('Conversation authorization required.');
      const allowed=new Set(body.channelMembers.map(p=>p.id));
      for(const member of call.participants)if(!allowed.has(member.id))member.status='left';
      this.clean();if(!allowed.has(selfId))reject('Conversation unavailable.');
    }
    if(action==='sync')return {selfId,call:this.view(call)};
    if(action==='leave'||action==='decline'){p.status=action==='leave'?'left':'declined';this.clean();return {selfId,ok:true};}
    if(call.status==='ended')reject('This call has ended.');
    if(action==='accept'){
      if(p.status==='joined')return {selfId,call:this.view(call)};
      if(!['ringing','declined','left','missed'].includes(p.status))reject('Invitation unavailable.');
      if(call.participants.filter(p=>p.status==='joined').length>=8)reject('This call already has eight participants.');
      if([...this.calls.values()].some(c=>c.id!==call.id&&c.status!=='ended'&&c.participants.some(p=>p.id===selfId&&p.status==='joined')))reject('End your current call first.');
      p.status='joined';p.lastSeen=this.clock();call.status='active';call.wasConnected=true;return {selfId,call:this.view(call)};
    }
    if(p.status!=='joined')reject('Join the call first.');
    if(action==='heartbeat'){p.lastSeen=this.clock();return {selfId,call:this.view(call)};}
    if(action==='poll'){
      const cursor=Number(body.cursor||0);if(!Number.isSafeInteger(cursor)||cursor<0)reject('Invalid cursor.',400);
      const events=this.signals.filter(s=>s.callId===call.id&&s.to===selfId&&s.seq>cursor).map(({seq,from,signal})=>({seq,from,signal}));
      return {selfId,call:this.view(call),events,cursor:this.sequence};
    }
    if(action==='signal') {
      if(body.to===selfId||!call.participants.some(p=>p.id===body.to&&p.status==='joined'))reject('Recipient unavailable.');
      const signal=body.signal;if(!signal||!['offer','answer','ice'].includes(signal.type)||JSON.stringify(signal).length>65536)reject('Invalid signal.',400);
      if(this.signals.filter(s=>s.from===selfId).length>=500)reject('Too many signaling messages.',429);
      this.signals.push({seq:++this.sequence,callId:call.id,from:selfId,to:body.to,signal,createdAt:this.clock()});return {selfId,ok:true};
    }
    reject('Unknown action.',400);
  }
}
