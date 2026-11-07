const endpoint = action => `${globalThis.__BASE__ || ''}/api/apps/phone/action/phone/${action}`;

// Provider seam: the UI talks to a media session, never to WebRTC directly.
// A future Chime adapter can implement sync/receive/mute/close using its SDK.
export class LocalAudioSession {
  constructor(stream, selfId, send, changed) {
    this.stream = stream; this.selfId = selfId; this.send = send; this.changed = changed;
    this.peers = new Map(); this.audio = new Map(); this.pendingIce = new Map(); this.blocked = false;
  }
  peer(id) {
    if (this.peers.has(id)) return this.peers.get(id);
    const pc = new RTCPeerConnection({iceServers: []});
    this.peers.set(id, pc);
    this.stream.getTracks().forEach(track => pc.addTrack(track, this.stream));
    pc.onicecandidate = ({candidate}) => { if (candidate) this.send(id, {type:'ice',candidate: candidate.toJSON()}).catch(() => {}); };
    pc.ontrack = ({streams}) => {
      if (!streams[0] || this.audio.has(id)) return;
      const audio = document.createElement('audio');
      audio.autoplay = true; audio.playsInline = true; audio.srcObject = streams[0];
      document.body.append(audio); this.audio.set(id, audio);
      audio.play().catch(() => { this.blocked = true; this.changed(); });
    };
    pc.onconnectionstatechange = () => this.changed();
    return pc;
  }
  async resumeAudio() {
    const result = await Promise.allSettled([...this.audio.values()].map(audio => audio.play()));
    this.blocked = result.some(item => item.status === 'rejected'); this.changed();
  }
  async sync(participants) {
    const joined = new Set(participants.filter(p => p.status === 'joined' && p.id !== this.selfId).map(p => p.id));
    for (const [id, pc] of this.peers) if (!joined.has(id)) {
      pc.close(); this.peers.delete(id); this.audio.get(id)?.remove(); this.audio.delete(id); this.pendingIce.delete(id);
    }
    for (const id of joined) {
      // Exactly one offerer per pair prevents simultaneous-offer glare.
      if (this.selfId >= id || this.peers.has(id)) continue;
      const pc = this.peer(id);
      await pc.setLocalDescription(await pc.createOffer());
      await this.send(id, {type:'offer',description:pc.localDescription.toJSON()});
    }
  }
  async receive({from, signal}) {
    if (!from || from === this.selfId || !signal) return;
    if (signal.type === 'ice') {
      const pc = this.peers.get(from);
      if (!pc?.remoteDescription) { const queue = this.pendingIce.get(from) || []; if (queue.length < 100) queue.push(signal.candidate); this.pendingIce.set(from, queue); }
      else await pc.addIceCandidate(signal.candidate);
      return;
    }
    if (!['offer','answer'].includes(signal.type)) return;
    const pc = this.peer(from);
    await pc.setRemoteDescription(signal.description);
    for (const candidate of this.pendingIce.get(from) || []) await pc.addIceCandidate(candidate);
    this.pendingIce.delete(from);
    if (signal.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      await this.send(from, {type:'answer',description:pc.localDescription.toJSON()});
    }
  }
  mute(muted) { this.stream.getAudioTracks().forEach(track => { track.enabled = !muted; }); }
  close() {
    for (const pc of this.peers.values()) pc.close(); this.peers.clear();
    this.audio.forEach(el => el.remove()); this.audio.clear(); this.pendingIce.clear();
    this.stream.getTracks().forEach(track => track.stop());
  }
}

export class CallController extends EventTarget {
  constructor() {
    super(); this.call = null; this.media = null; this.stream = null; this.selfId = null;
    this.incoming = []; this.calls = []; this.cursor = 0; this.muted = false; this.error = '';
    this.generation = 0; this.busy = false; this.failures = 0;
  }
  emit() { this.dispatchEvent(new Event('change')); }
  async request(action, body, keepalive = false) {
    const response = await fetch(endpoint(action), {method: body === undefined ? 'GET' : 'POST', credentials:'same-origin', cache:'no-store',
      ...(body === undefined ? {} : {headers:{'content-type':'application/json'},body:JSON.stringify(body)}),
      signal: AbortSignal.timeout(12000), keepalive});
    if (response.status === 401) { this.endLocal(); this.incoming = []; throw new Error('Sign in again to use Phone.'); }
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'Phone service unavailable.');
    if (data.selfId) this.selfId = data.selfId;
    return data;
  }
  unlockAudio() {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) return;
    this.audioContext ||= new Context();
    const node = this.audioContext.createBufferSource();
    node.buffer = this.audioContext.createBuffer(1,1,this.audioContext.sampleRate);
    node.connect(this.audioContext.destination); node.start(); this.audioContext.resume().catch(() => {});
  }
  async acquire() {
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Open the secure HTTPS link to allow microphone access.');
    this.unlockAudio();
    return navigator.mediaDevices.getUserMedia({audio:true, video:false});
  }
  async join(action, body, target) {
    if (this.call || this.busy) throw new Error('End your current call first.');
    this.busy = true; this.error = ''; const generation = ++this.generation; this.emit();
    let stream;
    try {
      stream = await this.acquire();
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
      const result = await this.request(action, body);
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); await this.request('leave',{callId:result.call.id}); return; }
      if (!result.call?.id || !this.selfId) throw new Error('Invalid call response.');
      this.stream = stream; this.call = {...result.call, displayName:target?.name || result.call.title}; this.cursor = 0; this.failures = 0;
      const callId = this.call.id;
      this.media = new LocalAudioSession(stream, this.selfId, (to, signal) => this.request('signal',{callId,to,signal}), () => this.emit());
      this.incoming = this.incoming.filter(call => call.id !== callId);
      this.emit(); this.poll(generation);
    } catch (error) { stream?.getTracks().forEach(t => t.stop()); this.error = error.message; this.emit(); throw error; }
    finally { this.busy = false; this.emit(); }
  }
  start(target) { return this.join('start', {channelId:target.channelId,userIds:target.userIds || (target.userId ? [target.userId] : []),title:target.name || 'Audio call'}, target); }
  async respond(callId, response) {
    if (response === 'accept') return this.join('accept',{callId});
    await this.request('decline',{callId}); this.incoming = this.incoming.filter(call => call.id !== callId); this.emit();
  }
  toggleMute() { this.muted = !this.muted; this.media?.mute(this.muted); this.emit(); }
  async leave() {
    const callId = this.call?.id; this.endLocal();
    if (callId) await this.request('leave',{callId}).catch(() => {});
  }
  endLocal() {
    ++this.generation; clearTimeout(this.timer); this.timer = null;
    this.media?.close(); this.media = null; this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    this.call = null; this.muted = false; this.busy = false; this.emit();
  }
  async poll(generation) {
    if (!this.call || generation !== this.generation) return;
    const callId = this.call.id;
    try {
      await this.request('heartbeat',{callId});
      const data = await this.request('poll',{callId,cursor:this.cursor});
      if (generation !== this.generation) return;
      const member = data.call?.participants.find(p => p.id === this.selfId);
      if (!data.call || data.call.status === 'ended' || member?.status !== 'joined') { this.endLocal(); return; }
      this.call = {...this.call,...data.call,error:''};
      await this.media.sync(data.call.participants);
      for (const event of data.events || []) await this.media.receive(event);
      this.cursor = data.cursor ?? this.cursor; this.failures = 0; this.emit();
    } catch (error) {
      if (generation !== this.generation) return;
      if (++this.failures >= 3) { this.error = 'Call disconnected. Please call again.'; await this.leave(); return; }
      this.call = {...this.call,error:'Reconnecting…'}; this.emit();
    }
    if (generation === this.generation) this.timer = setTimeout(() => this.poll(generation), 900);
  }
  async refreshCalls() {
    if (this.refreshing) return; this.refreshing = true;
    try {
      const data = await this.request('calls'); this.calls = data.calls || [];
      this.incoming = this.calls.filter(call => call.status !== 'ended' && call.participants.some(p => p.id === this.selfId && p.status === 'ringing'));
      this.emit();
    } catch {} finally { this.refreshing = false; }
  }
  listen() {
    if (this.incomingTimer) return;
    this.incomingTimer = setInterval(() => this.refreshCalls(), 2500); this.refreshCalls();
    globalThis.addEventListener('pagehide', () => {
      const callId = this.call?.id; this.endLocal();
      if (callId) this.request('leave',{callId},true).catch(() => {});
    });
    document.addEventListener('click', event => {
      if (event.composedPath().some(el => el.tagName === 'A' && /\/auth\/(logout|signout)/.test(el.getAttribute('href') || ''))) this.leave();
    },true);
  }
}

export function register(engine) {
  if (engine.getComponentByType('PhoneApp')) return;
  const { LightElement, FieldElement, html } = engine.base;
  const controller = globalThis.__aux4PhoneController ||= new CallController();
  controller.listen();

  const safe = action => Promise.resolve().then(action).catch(error => { controller.error = error.message; controller.emit(); });
  class PhoneDock extends LightElement {
    connectedCallback() { super.connectedCallback(); this.changed = () => this.requestUpdate(); controller.addEventListener('change',this.changed); }
    disconnectedCallback() { controller.removeEventListener('change',this.changed); super.disconnectedCallback(); }
    render() {
      const call = controller.call, incoming = controller.incoming[0];
      if (!call && !incoming && !controller.error) return html``;
      const participants = call?.participants.filter(p => p.status === 'joined') || [];
      const connected = [...(controller.media?.peers.values() || [])].filter(pc => pc.connectionState === 'connected').length;
      return html`<style>
        phone-dock{position:fixed;z-index:1000;right:20px;bottom:20px;width:min(360px,calc(100vw - 32px));font:14px/1.45 -apple-system,BlinkMacSystemFont,system-ui;color:white}
        .phone-dock{padding:18px;background:#17201e;border:1px solid #ffffff20;border-radius:22px;box-shadow:0 14px 45px #10231f40}
        .phone-dock header{display:flex;align-items:center;justify-content:space-between;gap:12px}.phone-dock strong{font-size:16px}.phone-dock small{color:#b5c9c0;display:block;margin:4px 0 14px}
        .phone-dock .phone-controls{display:flex;gap:8px}.phone-dock button{border:0;border-radius:12px;min-height:42px;padding:10px 16px;font:600 13px system-ui;cursor:pointer;color:white;background:#ffffff20}
        .phone-dock .hangup{background:#e44154}.phone-dock .accept{background:#28a86b}.phone-dock details{margin:8px 0}.phone-dock summary{cursor:pointer;color:#b5c9c0;font-size:12px}.phone-dock .phone-members{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.phone-member{padding:4px 8px;border-radius:8px;background:#ffffff12;font-size:12px}
        .phone-dock .phone-warning{color:#ffd9a6;margin:8px 0}.phone-error-dismiss{float:right}.phone-pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:#55d69b;margin-right:6px}
        @media(max-width:600px){phone-dock{right:16px;bottom:calc(16px + env(safe-area-inset-bottom));}.phone-dock{padding:14px}}
      </style>${location.pathname.includes('/apps/chat/') ? html`<style>phone-dock{bottom:auto;top:76px}</style>` : ''}<aside class="phone-dock" aria-label="Call controls" aria-live="polite">
        ${controller.error ? html`<p class="phone-warning">${controller.error}<button aria-label="Dismiss error" @click=${() => {controller.error='';controller.emit();}}>×</button></p>` : ''}
        ${call ? html`<header><strong><span class="phone-pulse"></span>${call.displayName || call.title}</strong><span>${controller.muted ? 'Muted' : 'Audio'}</span></header>
          <small>${call.error || (connected ? `${connected + 1} people connected` : participants.length > 1 ? 'Connecting audio…' : 'Calling…')}</small>
          <details><summary>Participants (${participants.length})</summary><div class="phone-members">${call.participants.map(p => html`<span class="phone-member">${p.name}${p.id === controller.selfId ? ' (you)' : ''} · ${p.status}</span>`)}</div></details>
          ${controller.media?.blocked ? html`<button @click=${() => controller.media.resumeAudio()}>Tap to hear audio</button>` : ''}
          <div class="phone-controls"><button aria-pressed=${controller.muted} @click=${() => controller.toggleMute()}>${controller.muted ? 'Unmute' : 'Mute'}</button><button class="hangup" @click=${() => controller.leave()}>End call</button></div>` : incoming ? html`
          <header><strong>${incoming.title || 'Incoming call'}</strong></header><small>${incoming.participants.filter(p => p.id !== controller.selfId).map(p => p.name).join(', ')}</small>
          <div class="phone-controls"><button class="hangup" @click=${() => safe(() => controller.respond(incoming.id,'decline'))}>Decline</button><button class="accept" ?disabled=${controller.busy} @click=${() => { controller.respond(incoming.id,'accept').catch(() => {}); }}>Accept</button></div>` : ''}
      </aside>`;
    }
  }
  PhoneDock.tag='phone-dock'; PhoneDock.label='PhoneDock'; PhoneDock.propsSchema={};

  class PhoneCallButton extends FieldElement {
    static reactive = true;
    connectedCallback() { super.connectedCallback(); this.changed=()=>this.requestUpdate();controller.addEventListener('change',this.changed); }
    disconnectedCallback() { controller.removeEventListener('change',this.changed);super.disconnectedCallback(); }
    render() {
      const scope = this.scopeState();
      const channelId = this.fieldValue || scope.channelId || scope.id;
      const existing = controller.calls.find(call => call.target?.id === channelId && call.status !== 'ended');
      const joined = existing?.participants.filter(p => p.status === 'joined').length || 0;
      return html`<style>phone-call-button button{display:flex;align-items:center;gap:6px;border:0;background:transparent;color:#25855b;border-radius:10px;min-width:40px;height:40px;padding:8px;cursor:pointer}phone-call-button button:hover{background:#e5f5ed}phone-call-button svg{width:21px;height:21px}phone-call-button small{font:600 12px system-ui}</style><button title=${joined ? 'Join conversation call' : 'Call conversation'} aria-label=${joined ? 'Join conversation call' : 'Call conversation'} ?disabled=${!channelId || controller.busy} @click=${() => {
        const action = existing ? controller.respond(existing.id,'accept') : controller.start({channelId,name:scope.title || 'Conversation call'});
        action.catch(error => {controller.error=error.message;controller.emit();});
      }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 5.2 2 2 0 0 1 5.1 3h3a2 2 0 0 1 2 1.7l.5 2.8a2 2 0 0 1-.6 1.7L8.7 10.5a16 16 0 0 0 4.8 4.8l1.3-1.3a2 2 0 0 1 1.7-.6l2.8.5a2 2 0 0 1 1.7 2z"/></svg>${joined ? html`<small>${joined}</small>` : ''}</button>`;
    }
  }
  PhoneCallButton.tag='phone-call-button'; PhoneCallButton.label='PhoneCallButton'; PhoneCallButton.propsSchema={field:{type:'string'}};

  class PhoneApp extends LightElement {
    static properties = {_people:{state:true},_recents:{state:true},_tab:{state:true},_selected:{state:true},_group:{state:true},_busy:{state:true},_error:{state:true}};
    constructor() {
      super(); this._people=[];this._recents=[];this._tab='contacts';this._selected=[];this._group=false;this._busy=false;this._error='';
      this.listRuntime={run:async()=>this.rows()};
      this._onChange=()=>{this._recents=controller.calls.filter(call=>call.status==='ended').slice().reverse();this.requestUpdate();};
    }
    connectedCallback() {super.connectedCallback();controller.addEventListener('change',this._onChange);this.load();this.refreshTimer=setInterval(()=>this.load(),10000);}
    disconnectedCallback() {clearInterval(this.refreshTimer);controller.removeEventListener('change',this._onChange);super.disconnectedCallback();}
    async load() {
      try {const data=await controller.request('contacts');this._people=data.people||[];this._recents=controller.calls.filter(call=>call.status==='ended').slice().reverse();this._error='';}
      catch(error){this._error=error.message||'Could not load contacts.';}
    }
    rows() {
      if(this._tab==='recents')return this._recents.map(call=>({...call,name:call.title,detail:new Date(call.createdAt).toLocaleString(),initials:call.title?.slice(0,1)||'☎'}));
      return this._people.map(person=>({...person,detail:person.email||'aux4 user',initials:person.name?.trim().split(/\s+/).slice(0,2).map(s=>s[0]).join('').toUpperCase()||'?',selected:this._selected.some(p=>p.id===person.id),badge:controller.calls.some(call=>call.status!=='ended'&&call.participants.some(p=>p.id===person.id&&p.status==='joined'))?'On a call':''}));
    }
    updated() {this.querySelector('fe-list')?.applyEvent(this.rows());}
    toggle(person) {this._selected=this._selected.some(p=>p.id===person.id)?this._selected.filter(p=>p.id!==person.id):[...this._selected,person];}
    async start(target) {this._busy=true;this._error='';try{await controller.start(target);this._selected=[];this._group=false;}catch(error){this._error=error.message;}finally{this._busy=false;}}
    action(event) {
      const {action,payload:row}=event.detail||{};
      if(!['phone-call','phone-select'].includes(action))return;
      event.stopPropagation();
      if(action==='phone-select'){this.toggle(row);return;}
      if(this._tab==='recents')this.start(row.target?.type==='channel'?{channelId:row.target.id,name:row.title}:{userIds:row.participants.filter(p=>p.id!==controller.selfId).map(p=>p.id),name:row.title});
      else this.start({userId:row.id,name:row.name});
    }
    render() {
      const group=this._group&&this._tab==='contacts';
      const meta={source:'phone-rows',label:this._tab==='contacts'?'Contacts':'Recent calls',primary:'name',secondary:'detail',avatarText:'initials',activeField:'selected',badge:'badge',badgeTone:'success',bordered:false,search:true,searchFields:['name','detail'],searchPlaceholder:this._tab==='contacts'?'Search contacts':'Search recent calls',emptyState:{title:this._tab==='contacts'?'No contacts yet':'No recent calls',description:this._tab==='contacts'?'Contacts appear when they open Phone or join Chat.':'Your completed calls will appear here.'},actions:group?[{icon:'plus',label:'Add to call',onClick:'phone-select',when:{field:'selected',equals:false}},{icon:'check',label:'Remove from call',onClick:'phone-select',when:{field:'selected',equals:true}}]:[{icon:'phone',label:'Call',onClick:'phone-call'}]};
      return html`<style>${styles}</style><main class="phone-app" aria-label="Phone">
        <div class="phone-toolbar"><nav class="phone-tabs" aria-label="Phone sections">
          <button type="button" aria-current=${this._tab==='contacts'?'page':'false'} @click=${()=>this._tab='contacts'}>Contacts</button>
          <button type="button" aria-current=${this._tab==='recents'?'page':'false'} @click=${()=>this._tab='recents'}>Recents</button>
        </nav>${this._tab==='contacts'?html`<button type="button" class="phone-group-toggle" aria-pressed=${this._group} @click=${()=>{this._group=!this._group;this._selected=[];}}>${this._group?'Cancel':'Group call'}</button>`:''}</div>
        ${this._error?html`<p class="phone-error" role="alert">${this._error}</p>`:''}
        <section class="phone-directory"><fe-list .meta=${meta} .runtime=${this.listRuntime} @fe-action=${event=>this.action(event)}></fe-list></section>
        ${group?html`<footer class="phone-selection"><span>${this._selected.length?`${this._selected.length} selected`:'Select people to call'}</span><button type="button" ?disabled=${!this._selected.length||this._busy} @click=${()=>this.start({userIds:this._selected.map(p=>p.id),name:this._selected.map(p=>p.name).join(', ')})}>${this._busy?'Calling…':'Start call'}</button></footer>`:''}
      </main>`;
    }
  }
  const styles=`
    phone-app{display:block;min-height:100%;background:var(--fe-surface,#fff);color:var(--fe-text,#18181b);font:15px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
    .phone-app{max-width:900px;margin:0 auto;padding:0 24px 100px;box-sizing:border-box}
    .phone-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--fe-border,#e4e4e7);margin-bottom:20px}
    .phone-tabs{display:flex;gap:24px}.phone-tabs button{border:0;border-bottom:2px solid transparent;background:none;padding:19px 0 15px;font:600 14px system-ui;color:var(--fe-text-muted,#667085);cursor:pointer}
    .phone-tabs button[aria-current=page]{color:var(--fe-primary,#2563eb);border-bottom-color:var(--fe-primary,#2563eb)}
    .phone-group-toggle{border:0;border-radius:8px;background:var(--fe-surface-muted,#f4f4f5);padding:8px 12px;color:var(--fe-text,#18181b);font:500 13px system-ui;cursor:pointer;white-space:nowrap}
    .phone-directory fe-list{display:block}.phone-directory fe-list-item{min-width:0}.phone-directory .fe-search-input{border-color:var(--fe-border,#e4e4e7)!important;background:var(--fe-surface-muted,#f7f7f8)!important}
    .phone-error{padding:12px 16px;border-radius:10px;background:#fef3f2;color:#b42318}
    .phone-selection{position:sticky;bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;margin-top:20px;border:1px solid var(--fe-border,#e4e4e7);border-radius:12px;background:var(--fe-surface,#fff);box-shadow:0 4px 16px #0000000a;font-size:14px}
    .phone-selection button{border:0;border-radius:8px;background:var(--fe-primary,#2563eb);color:white;padding:10px 16px;font:600 14px system-ui;cursor:pointer}.phone-selection button:disabled{opacity:.45;cursor:default}
    @media(max-width:600px){.phone-app{padding:0 16px 90px}.phone-toolbar{margin-bottom:16px}.phone-tabs{gap:22px}}
  `;
  PhoneApp.tag = 'phone-app'; PhoneApp.label = 'PhoneApp'; PhoneApp.propsSchema = {};
  
  const mountDock = () => { if (document.body && !document.querySelector('phone-dock')) document.body.append(document.createElement('phone-dock')); };
  if (document.body) mountDock(); else addEventListener('DOMContentLoaded', mountDock, {once:true});
  engine.registerLibrary({name:'phone',components:[PhoneApp,PhoneCallButton,PhoneDock]});
  if (!document.querySelector('phone-dock')) document.body.append(document.createElement('phone-dock'));
}
export default register;
