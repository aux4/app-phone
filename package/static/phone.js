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
    static properties={_people:{state:true},_recents:{state:true},_tab:{state:true},_selected:{state:true},_query:{state:true},_incoming:{state:true},_busy:{state:true},_error:{state:true}};
    constructor(){super();this._people=[];this._recents=[];this._tab='contacts';this._selected=[];this._query='';this._incoming=[];this._busy=false;this._error='';this._onChange=()=>{this._recents=controller.calls.filter(call=>call.status==='ended');this._people=this._people.map(person=>({...person,onCall:controller.calls.some(call=>call.status!=='ended'&&call.participants.some(p=>p.id===person.id&&p.status==='joined'))}));this.requestUpdate();};controller.addEventListener('change',this._onChange);}
    async connectedCallback(){super.connectedCallback();await this.load();this.refreshTimer=setInterval(()=>this.load(),10000);}
    disconnectedCallback(){clearInterval(this.refreshTimer);controller.removeEventListener('change',this._onChange);super.disconnectedCallback();}
    mountDock(){if(!document.querySelector('phone-dock')) document.body.append(document.createElement('phone-dock'));}
    async load(){try{const response=await fetch(endpoint('contacts'),{credentials:'same-origin',cache:'no-store'});if(!response.ok) throw Error();const data=await response.json();this._people=(data.people||data.contacts||[]).map(person=>({...person,onCall:controller.calls.some(call=>call.status!=='ended'&&call.participants.some(p=>p.id===person.id&&p.status==='joined'))}));this._recents=controller.calls.filter(call=>call.status==='ended').slice().reverse();}catch(error){this._error='Could not load contacts.';}}
    toggle(person){const id=person.id||person.userId;this._selected=this._selected.some(item=>(item.id||item.userId)===id)?this._selected.filter(item=>(item.id||item.userId)!==id):[...this._selected,person];}
    async call(){if(!this._selected.length)return;this._busy=true;this._error='';try{await controller.start(this._selected.length===1?{userId:this._selected[0].id,name:this._selected[0].name}:{userIds:this._selected.map(person=>person.id),name:`${this._selected.length} people`});this._selected=[];}catch(error){this._error=error.message;}finally{this._busy=false;}}
    render(){const people=this._people.filter(person=>`${person.name||''} ${person.email||''}`.toLowerCase().includes(this._query.toLowerCase()));return html`<style>${styles}</style><main class="phone-app"><header><div class="brand"><span class="app-icon">☎</span><div><h1>Phone</h1><p>Audio calls for your workspace</p></div></div></header><nav class="tabs" aria-label="Phone sections"><button class=${this._tab==='contacts'?'active':''} @click=${()=>this._tab='contacts'}>Contacts</button><button class=${this._tab==='recents'?'active':''} @click=${()=>this._tab='recents'}>Recents</button></nav>${this._error?html`<p class="error" role="alert">${this._error}</p>`:''}${this._tab==='contacts'?html`<label class="search"><span>⌕</span><input .value=${this._query} @input=${event=>this._query=event.target.value} placeholder="Search contacts" aria-label="Search contacts"></label><section class="list">${!people.length?html`<p class="phone-empty">${this._query?'No contacts match your search.':'Your contacts will appear here when they open Phone or join Chat.'}</p>`:''}${people.map(person=>html`<button class=${this._selected.some(item=>(item.id||item.userId)===(person.id||person.userId))?'person selected':'person'} @click=${()=>this.toggle(person)}><span class="person-avatar">${(person.name||person.email||'?')[0].toUpperCase()}</span><span><strong>${person.name||person.email||'Aux4 user'}</strong><small>${person.onCall?'On a call':person.email||'aux4 user'}</small></span><i class=${person.onCall?'on-call':''}></i></button>`)}</section>`:html`<section class="list">${!this._recents.length?html`<p class="phone-empty">Your recent calls will appear here.</p>`:''}${this._recents.map(person=>html`<button class="person" @click=${()=>controller.start(person.target?.type==='channel'?{channelId:person.target.id,name:person.title}:{userIds:person.participants.filter(p=>p.id!==controller.selfId).map(p=>p.id),name:person.title}).catch(error=>{this._error=error.message;})}><span class="person-avatar">${(person.title||'?')[0]}</span><span><strong>${person.title||'Audio call'}</strong><small>${new Date(person.createdAt).toLocaleString()}</small></span></button>`)}</section>`}${this._selected.length?html`<footer class="call-bar"><span>${this._selected.length} selected</span><button @click=${()=>this._selected=[]}>Clear</button><button class="call" @click=${()=>this.call()} ?disabled=${this._busy}>${this._busy?'Calling…':'Call'}</button></footer>`:''}</main>`;}
  }
  const styles=`phone-app{display:block;min-height:100%;background:#f5f7fb;color:#172033;font:15px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif}.phone-app>*{box-sizing:border-box}.phone-app header{display:flex;align-items:center;justify-content:space-between;max-width:760px;margin:auto;padding:34px 28px 22px}.brand{display:flex;align-items:center;gap:14px}.app-icon{display:grid;place-items:center;width:48px;height:48px;border-radius:15px;background:#2563eb;color:white;font-size:24px;box-shadow:0 8px 20px #2563eb44}.phone-app h1{margin:0;font-size:30px;letter-spacing:-.04em}.phone-app header p{margin:3px 0;color:#667085}.avatar{width:38px;height:38px;border:1px solid #d9e0eb;border-radius:50%;background:white;color:#2563eb;font-weight:700}.tabs{display:flex;gap:24px;max-width:760px;margin:auto;padding:0 28px;border-bottom:1px solid #e4e9f1}.tabs button{padding:13px 3px;border:0;border-bottom:2px solid transparent;background:none;color:#667085;font:600 14px system-ui;cursor:pointer}.tabs button.active{border-color:#2563eb;color:#2563eb}.search{display:flex;align-items:center;gap:8px;max-width:704px;margin:22px auto 12px;padding:11px 14px;border:1px solid #d9e0eb;border-radius:13px;background:white;color:#98a2b3}.search input{width:100%;border:0;outline:0;font:inherit}.phone-empty{padding:28px 12px;text-align:center;color:#667085;font-size:14px}.list{max-width:704px;margin:auto;padding:4px 0 100px}.person{display:flex;align-items:center;gap:12px;width:100%;padding:14px 10px;border:0;border-bottom:1px solid #edf0f5;background:transparent;text-align:left;cursor:pointer}.person:hover,.person.selected{background:#eaf1ff}.person-avatar{display:grid;place-items:center;flex:none;width:42px;height:42px;border-radius:50%;background:#e8eefb;color:#315cbb;font-weight:700}.person span:nth-child(2){display:flex;flex-direction:column;gap:2px}.person small{color:#667085}.person i{margin-left:auto;width:9px;height:9px;border-radius:50%;background:#cbd5e1}.person i.on-call{background:#12b76a;box-shadow:0 0 0 4px #12b76a22}.incoming{display:flex;align-items:center;gap:10px;max-width:704px;margin:16px auto;padding:14px 16px;border:1px solid #b7d4ff;border-radius:15px;background:#eff6ff}.incoming div{display:flex;flex-direction:column;gap:2px;flex:1}.incoming span{color:#475467}.incoming button,.call-bar button{border:0;border-radius:10px;padding:9px 13px;background:#e5e7eb;color:#344054;font-weight:650;cursor:pointer}.incoming .accept,.call-bar .call{background:#2563eb;color:white}.error{max-width:704px;margin:16px auto;padding:11px 14px;border-radius:10px;background:#fef3f2;color:#b42318}.call-bar{position:fixed;z-index:999;bottom:20px;left:50%;display:flex;align-items:center;gap:12px;transform:translateX(-50%);padding:10px 12px 10px 17px;border:1px solid #d5def0;border-radius:18px;background:#fff;box-shadow:0 10px 30px #10182824}.call-bar .call{padding:10px 22px}@media(max-width:600px){.phone-app header{padding:24px 18px 18px}.tabs{padding:0 18px}.search{margin:16px 18px 10px}.list{padding:4px 18px 100px}.incoming{margin:14px 18px;flex-wrap:wrap}.incoming div{min-width:100%}}
  `;
  PhoneApp.tag = 'phone-app'; PhoneApp.label = 'PhoneApp'; PhoneApp.propsSchema = {};
  
  const mountDock = () => { if (document.body && !document.querySelector('phone-dock')) document.body.append(document.createElement('phone-dock')); };
  if (document.body) mountDock(); else addEventListener('DOMContentLoaded', mountDock, {once:true});
  engine.registerLibrary({name:'phone',components:[PhoneApp,PhoneCallButton,PhoneDock]});
  if (!document.querySelector('phone-dock')) document.body.append(document.createElement('phone-dock'));
}
export default register;
