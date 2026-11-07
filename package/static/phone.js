// Phone UI and the browser-side local call provider.  The call controller lives on
// window so it survives app route changes (the same page can keep a call while Chat
// navigates between conversations).
export function register(engine) {
  const { LightElement, html } = engine.base;
  const endpoint = action => `${globalThis.__BASE__ || ''}/api/apps/phone/action/phone/${action}`;

  class CallController extends EventTarget {
    constructor() { super(); this.call = null; this.stream = null; this.peers = new Map(); this.cursor = 0; this.timer = null; this.audio = new Map(); }
    emit() { this.dispatchEvent(new Event('change')); }
    async request(action, body = {}) {
      const response = await fetch(endpoint(action), { method: 'POST', credentials: 'same-origin', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
      if (response.status === 401) { this.endLocal(); throw new Error('Your session expired. Sign in again to make a call.'); }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Phone service unavailable.');
      return data;
    }
    async start(target) {
      if (this.call) return this.call;
      // Must be called directly from a click/tap handler for iOS Safari permission.
      this.stream = await navigator.mediaDevices.getUserMedia({audio:true, video:false});
      const call = await this.request('start', { channelId: target.channelId, userIds: target.userIds || [target.userId], title: target.name || 'Audio call' });
      this.call = {...call, target}; this.cursor = 0; this.emit(); this.poll(); return this.call;
    }
    async respond(callId, response) {
      if (response === 'accept') this.stream = await navigator.mediaDevices.getUserMedia({audio:true, video:false});
      const call = await this.request(response, {callId});
      if (response === 'accept') { this.call = call; this.poll(); }
      else if (this.call?.id === callId) this.endLocal();
      this.emit(); return call;
    }
    async leave() { if (this.call) await this.request('leave',{callId:this.call.id}).catch(()=>{}); this.endLocal(); }
    endLocal() { for (const pc of this.peers.values()) pc.close(); this.peers.clear(); this.audio.forEach(el=>el.remove()); this.audio.clear(); this.stream?.getTracks().forEach(track=>track.stop()); this.stream=null; this.call=null; clearTimeout(this.timer); this.timer=null; this.emit(); }
    async poll() {
      if (!this.call) return;
      try {
        const query = new URLSearchParams({callId:this.call.id,cursor:String(this.cursor)});
        const response = await fetch(`${endpoint('events')}?${query}`, {credentials:'same-origin',cache:'no-store'});
        if (response.status === 401) return this.endLocal();
        if (!response.ok) throw Error();
        const data = await response.json(); this.cursor = data.cursor ?? this.cursor;
        for (const event of data.events || []) await this.signal(event);
        if (data.call?.status === 'ended' || data.call?.status === 'declined') return this.endLocal();
        this.call = {...this.call,...data.call}; this.emit();
      } catch (error) { this.call = {...this.call,error:'Connection lost. Reconnecting…'}; this.emit(); }
      this.timer = setTimeout(() => this.poll(), 1200);
    }
    async signal(event) {
      if (!event.from || event.from === this.call.userId) return;
      let pc = this.peers.get(event.from);
      if (!pc) {
        pc = new RTCPeerConnection({iceServers:[]}); this.peers.set(event.from,pc);
        this.stream?.getTracks().forEach(track => pc.addTrack(track,this.stream));
        pc.ontrack = ({streams}) => { if (!streams[0] || this.audio.has(event.from)) return; const audio = document.createElement('audio'); audio.autoplay=true; audio.playsInline=true; audio.srcObject=streams[0]; document.body.append(audio); this.audio.set(event.from,audio); audio.play().catch(()=>{}); };
        pc.onicecandidate = ({candidate}) => candidate && this.request('signal',{callId:this.call.id,to:event.from,type:'ice',candidate}).catch(()=>{});
      }
      if (event.type === 'offer') { await pc.setRemoteDescription(event.description || event.offer); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); await this.request('signal',{callId:this.call.id,to:event.from,type:'answer',description:pc.localDescription}); }
      if (event.type === 'answer') await pc.setRemoteDescription(event.description || event.answer);
      if (event.type === 'ice' && event.candidate) await pc.addIceCandidate(event.candidate).catch(()=>{});
    }
    async ensureOffer(userId) {
      if (!this.call || this.peers.has(userId)) return;
      const pc = new RTCPeerConnection({iceServers:[]}); this.peers.set(userId,pc); this.stream?.getTracks().forEach(track=>pc.addTrack(track,this.stream));
      pc.ontrack = ({streams}) => { if (!streams[0] || this.audio.has(userId)) return; const audio=document.createElement('audio'); audio.autoplay=true; audio.playsInline=true; audio.srcObject=streams[0]; document.body.append(audio); this.audio.set(userId,audio); audio.play().catch(()=>{}); };
      pc.onicecandidate = ({candidate}) => candidate && this.request('signal',{callId:this.call.id,to:userId,type:'ice',candidate}).catch(()=>{});
      const offer=await pc.createOffer(); await pc.setLocalDescription(offer); await this.request('signal',{callId:this.call.id,to:userId,type:'offer',description:pc.localDescription});
    }
  }
  const controller = globalThis.__aux4PhoneController ||= new CallController();

  class PhoneDock extends LightElement {
    static properties = { _call: {state:true} };
    constructor(){ super(); this._call=controller.call; this._onChange=()=>{this._call=controller.call;this.requestUpdate();}; controller.addEventListener('change',this._onChange); }
    disconnectedCallback(){ /* controller deliberately remains alive */ super.disconnectedCallback(); }
    render(){ if(!this._call) return html``; const title=this._call.target?.name || this._call.name || 'Call'; return html`<style>.phone-dock{position:fixed;z-index:1000;left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:14px;padding:12px 16px;border-radius:22px;background:#111827;color:#fff;box-shadow:0 12px 35px #0004;font:14px system-ui}.phone-dock .pulse{width:10px;height:10px;border-radius:50%;background:#34d399;box-shadow:0 0 0 5px #34d39933}.phone-dock button{border:0;border-radius:999px;padding:9px 15px;font-weight:700;cursor:pointer}.phone-dock .hangup{background:#ef4444;color:white}</style><aside class="phone-dock" aria-live="polite"><span class="pulse"></span><strong>${title}</strong><span>${this._call.status==='ringing'?'Incoming call':this._call.status||'Connected'}</span><button class="hangup" @click=${()=>controller.leave()}>End</button></aside>`; }
  }
  customElements.define('phone-dock', PhoneDock);

  class PhoneCallButton extends LightElement {
    static properties={channelId:{type:String},userId:{type:String},name:{type:String},userIds:{attribute:false}};
    render(){ return html`<button class="phone-call-button" aria-label="Start audio call" @click=${async()=>{try{await controller.start({channelId:this.channelId,userId:this.userId,userIds:this.userIds,name:this.name});}catch(error){this.dispatchEvent(new CustomEvent('phone-error',{detail:error,bubbles:true,composed:true}));}}}>☎</button>`; }
  }
  customElements.define('phone-call-button', PhoneCallButton);

  class PhoneApp extends LightElement {
    static properties={_people:{state:true},_recents:{state:true},_tab:{state:true},_selected:{state:true},_query:{state:true},_incoming:{state:true},_busy:{state:true},_error:{state:true}};
    constructor(){super();this._people=[];this._recents=[];this._tab='contacts';this._selected=[];this._query='';this._incoming=[];this._busy=false;this._error='';this._onChange=()=>this.requestUpdate();controller.addEventListener('change',this._onChange);}
    async connectedCallback(){super.connectedCallback();await this.load();this.mountDock();}
    mountDock(){if(!document.querySelector('phone-dock')) document.body.append(document.createElement('phone-dock'));}
    async load(){try{const response=await fetch(endpoint('contacts'),{credentials:'same-origin',cache:'no-store'});if(!response.ok) throw Error();const data=await response.json();this._people=data.people||data.contacts||[];this._recents=data.recents||[];this._incoming=data.incoming||[];}catch(error){this._error='Could not load contacts.';}}
    toggle(person){const id=person.id||person.userId;this._selected=this._selected.some(item=>(item.id||item.userId)===id)?this._selected.filter(item=>(item.id||item.userId)!==id):[...this._selected,person];}
    async call(){if(!this._selected.length)return;this._busy=true;this._error='';try{await controller.start(this._selected.length===1?{userId:this._selected[0].id,name:this._selected[0].name}:{userIds:this._selected.map(person=>person.id),name:`${this._selected.length} people`});this._selected=[];}catch(error){this._error=error.message;}finally{this._busy=false;}}
    render(){const people=this._people.filter(person=>`${person.name||''} ${person.email||''}`.toLowerCase().includes(this._query.toLowerCase()));return html`<style>${styles}</style><main class="phone-app"><header><div class="brand"><span class="app-icon">☎</span><div><h1>Phone</h1><p>Audio calls for your workspace</p></div></div><button class="avatar" aria-label="Your profile">${(this._people.find(person=>person.self)?.name||'U')[0]}</button></header><nav class="tabs" aria-label="Phone sections"><button class=${this._tab==='contacts'?'active':''} @click=${()=>this._tab='contacts'}>Contacts</button><button class=${this._tab==='recents'?'active':''} @click=${()=>this._tab='recents'}>Recents</button></nav>${this._error?html`<p class="error" role="alert">${this._error}</p>`:''}${this._incoming.map(call=>html`<section class="incoming"><div><strong>Incoming call</strong><span>${call.name||'Workspace call'}</span></div><button @click=${()=>controller.respond(call.id,'decline')}>Decline</button><button class="accept" @click=${()=>controller.respond(call.id,'accept')}>Accept</button></section>`)}${this._tab==='contacts'?html`<label class="search"><span>⌕</span><input .value=${this._query} @input=${event=>this._query=event.target.value} placeholder="Search contacts" aria-label="Search contacts"></label><section class="list">${people.map(person=>html`<button class=${this._selected.some(item=>(item.id||item.userId)===(person.id||person.userId))?'person selected':'person'} @click=${()=>this.toggle(person)}><span class="person-avatar">${(person.name||person.email||'?')[0].toUpperCase()}</span><span><strong>${person.name||person.email||'Aux4 user'}</strong><small>${person.email||'Available'}</small></span><i class=${person.onCall?'on-call':''}></i></button>`)}</section>`:html`<section class="list">${this._recents.map(person=>html`<button class="person" @click=${()=>controller.start({userId:person.id,name:person.name})}><span class="person-avatar">${(person.name||'?')[0]}</span><span><strong>${person.name||'Aux4 user'}</strong><small>${person.at||'Recent call'}</small></span></button>`)}</section>`}${this._selected.length?html`<footer class="call-bar"><span>${this._selected.length} selected</span><button @click=${()=>this._selected=[]}>Clear</button><button class="call" @click=${()=>this.call()} ?disabled=${this._busy}>${this._busy?'Calling…':'Call'}</button></footer>`:''}</main>`;}
  }
  const styles=`phone-app{display:block;min-height:100%;background:#f5f7fb;color:#172033;font:15px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif}.phone-app>*{box-sizing:border-box}.phone-app header{display:flex;align-items:center;justify-content:space-between;max-width:760px;margin:auto;padding:34px 28px 22px}.brand{display:flex;align-items:center;gap:14px}.app-icon{display:grid;place-items:center;width:48px;height:48px;border-radius:15px;background:#2563eb;color:white;font-size:24px;box-shadow:0 8px 20px #2563eb44}.phone-app h1{margin:0;font-size:30px;letter-spacing:-.04em}.phone-app header p{margin:3px 0;color:#667085}.avatar{width:38px;height:38px;border:1px solid #d9e0eb;border-radius:50%;background:white;color:#2563eb;font-weight:700}.tabs{display:flex;gap:24px;max-width:760px;margin:auto;padding:0 28px;border-bottom:1px solid #e4e9f1}.tabs button{padding:13px 3px;border:0;border-bottom:2px solid transparent;background:none;color:#667085;font:600 14px system-ui;cursor:pointer}.tabs button.active{border-color:#2563eb;color:#2563eb}.search{display:flex;align-items:center;gap:8px;max-width:704px;margin:22px auto 12px;padding:11px 14px;border:1px solid #d9e0eb;border-radius:13px;background:white;color:#98a2b3}.search input{width:100%;border:0;outline:0;font:inherit}.list{max-width:704px;margin:auto;padding:4px 0 100px}.person{display:flex;align-items:center;gap:12px;width:100%;padding:14px 10px;border:0;border-bottom:1px solid #edf0f5;background:transparent;text-align:left;cursor:pointer}.person:hover,.person.selected{background:#eaf1ff}.person-avatar{display:grid;place-items:center;flex:none;width:42px;height:42px;border-radius:50%;background:#e8eefb;color:#315cbb;font-weight:700}.person span:nth-child(2){display:flex;flex-direction:column;gap:2px}.person small{color:#667085}.person i{margin-left:auto;width:9px;height:9px;border-radius:50%;background:#cbd5e1}.person i.on-call{background:#12b76a;box-shadow:0 0 0 4px #12b76a22}.incoming{display:flex;align-items:center;gap:10px;max-width:704px;margin:16px auto;padding:14px 16px;border:1px solid #b7d4ff;border-radius:15px;background:#eff6ff}.incoming div{display:flex;flex-direction:column;gap:2px;flex:1}.incoming span{color:#475467}.incoming button,.call-bar button{border:0;border-radius:10px;padding:9px 13px;background:#e5e7eb;color:#344054;font-weight:650;cursor:pointer}.incoming .accept,.call-bar .call{background:#2563eb;color:white}.error{max-width:704px;margin:16px auto;padding:11px 14px;border-radius:10px;background:#fef3f2;color:#b42318}.call-bar{position:fixed;z-index:999;bottom:20px;left:50%;display:flex;align-items:center;gap:12px;transform:translateX(-50%);padding:10px 12px 10px 17px;border:1px solid #d5def0;border-radius:18px;background:#fff;box-shadow:0 10px 30px #10182824}.call-bar .call{padding:10px 22px}@media(max-width:600px){.phone-app header{padding:24px 18px 18px}.tabs{padding:0 18px}.search{margin:16px 18px 10px}.list{padding:4px 18px 100px}.incoming{margin:14px 18px;flex-wrap:wrap}.incoming div{min-width:100%}}
  `;
  customElements.define('phone-app', PhoneApp);
  engine.registerLibrary({name:'phone',components:[PhoneApp,PhoneCallButton,PhoneDock]});
}
export default register;
