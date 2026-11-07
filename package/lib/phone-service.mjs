import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { LocalCallProvider } from './local-provider.mjs';
export function createPhoneServer(secret,provider=new LocalCallProvider()) {
  if(typeof secret!=='string'||secret.length<32)throw Error('PHONE_SERVICE_SECRET must contain at least 32 random characters');
  const expected=Buffer.from(`Bearer ${secret}`);
  return createServer(async(req,res)=>{
    const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    if(req.url==='/health'&&req.method==='GET')return reply(200,{ok:true,provider:'local-webrtc'});
    const supplied=Buffer.from(req.headers.authorization||'');
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reply(401,{error:'Unauthorized'});
    if(req.method!=='POST'||req.url!=='/')return reply(404,{error:'Not found'});
    try {
      let data='',size=0;
      for await(const chunk of req){size+=chunk.length;if(size>262144)return reply(413,{error:'Request too large'});data+=chunk;}
      const input=JSON.parse(data);reply(200,provider.execute(input.action,input));
    }catch(error){reply(error.status||400,{error:error.message});}
  });
}
if(import.meta.url===`file://${process.argv[1]}`)createPhoneServer(process.env.PHONE_SERVICE_SECRET).listen(Number(process.env.PHONE_PORT||8787),process.env.PHONE_HOST||'127.0.0.1',()=>console.log('Phone signaling provider ready'));
