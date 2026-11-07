// Central integration check: real WebRTC media, isolated authenticated fixtures.
// The fixture identity is scoped to Playwright interception, never a preview route.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {phoneAction} from '../package/lib/phone.mjs';
import {LocalCallProvider} from '../package/lib/local-provider.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const workspace=resolve(root,'../../..');
const {chromium}=await import(pathToFileURL(join(workspace,'packages/browser/package/lib/node_modules/playwright/index.mjs')));
const {build}=await import(pathToFileURL(join(workspace,'packages/form-engine/node_modules/esbuild/lib/main.js')));
const temp=await mkdtemp(join(tmpdir(),'phone-browser-'));
const bundle=await build({stdin:{contents:`import {createEngine} from '${workspace}/packages/form-engine/lit/index.js'; import {register} from '${root}/package/static/phone.js';const engine=createEngine();register(engine);document.body.append(document.createElement('phone-app'));window.testEngine=engine;`,resolveDir:root},bundle:true,format:'esm',write:false});
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle.outputFiles[0].text:'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body><script type="module" src="/bundle.js"></script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const provider=new LocalCallProvider();const users=[{id:'alice',name:'Alice'},{id:'bob',name:'Bob'},{id:'eve',name:'Eve'}];
const deps={provider:input=>provider.execute(input.action,input),chat:async()=>users};
const browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const errors=[];
try{
 const pages=[];
 for(const user of users){
  const context=await browser.newContext({permissions:['microphone'],viewport:{width:390,height:844}});
  await context.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>{const c=new AudioContext();const oscillator=c.createOscillator();const destination=c.createMediaStreamDestination();oscillator.connect(destination);oscillator.start();await c.resume();window.fixtureAudio=c;return destination.stream;};});
  const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE',e.message);});
  await page.route('**/api/apps/phone/action/phone/*',async route=>{
   const req=route.request(),action=req.url().split('/').at(-1);try{const result=await phoneAction(action==='calls'?'list':action,{sub:user.id,name:user.name},req.postDataJSON()||{}, {},deps);await route.fulfill({json:result});}catch(e){await route.fulfill({status:403,json:{error:e.message}});}
  });
  await page.goto(origin);await page.getByRole('button',{name:/Alice|Bob/}).first().waitFor();pages.push(page);
 }
 const [alice,bob,eve]=pages;
 await alice.locator('button.person').filter({hasText:'Bob'}).click();await alice.locator('button.person').filter({hasText:'Eve'}).click();await alice.getByRole('button',{name:'Call',exact:true}).click();
 await bob.locator('phone-dock').getByRole('button',{name:'Accept',exact:true}).click();
 await eve.locator('phone-dock').getByRole('button',{name:'Accept',exact:true}).click();
 for(const page of pages)await page.waitForFunction(()=>{const m=window.__aux4PhoneController.media;return m?.peers.size===2&&[...m.peers.values()].every(pc=>pc.connectionState==='connected');},null,{timeout:30000});
 for(const page of pages){const packets=await page.evaluate(async()=>{let n=0;for(const pc of window.__aux4PhoneController.media.peers.values())for(const stat of (await pc.getStats()).values())if(stat.type==='inbound-rtp'&&stat.kind==='audio')n+=stat.packetsReceived;return n;});assert.ok(packets>0,'received actual audio RTP');}
 await alice.getByRole('button',{name:'Mute',exact:true}).click();assert.equal(await alice.evaluate(()=>window.__aux4PhoneController.stream.getAudioTracks()[0].enabled),false);
 await alice.evaluate(()=>{document.querySelector('phone-app').remove();history.pushState({},'', '/apps/chat/chat/other');});
 assert.equal(await alice.evaluate(()=>[...window.__aux4PhoneController.media.peers.values()].every(pc=>pc.connectionState==='connected')),true);
 await bob.screenshot({path:'/tmp/aux4-phone-mobile.png',fullPage:true});
 await alice.getByRole('button',{name:'End call',exact:true}).click();
 assert.equal(await alice.evaluate(()=>window.__aux4PhoneController.stream),null);
 assert.deepEqual(errors,[]);
 console.log('PASS: three-user real WebRTC audio, RTP packets, mute, persistent route navigation, hangup; mobile screenshot /tmp/aux4-phone-mobile.png');
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});}
