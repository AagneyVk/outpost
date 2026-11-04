// RFC 6455 over a private, in-page guest TCP connection. No host socket is opened.
const enc=new TextEncoder(),dec=new TextDecoder();
export class GuestWebSocket{
 constructor(connection,{host='localhost:9222',path='/session',origin=location.origin}={}){
  this.connection=connection;this.buffer=new Uint8Array(0);this.pending=new Map();this.next=1;this.listeners=new Map();this.fragments=[];this.bytes=0;
  this.ready=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});
  this.key=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  this.accept=crypto.subtle.digest('SHA-1',enc.encode(this.key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11')).then(b=>btoa(String.fromCharCode(...new Uint8Array(b))));
  connection.on('connect',()=>connection.write(enc.encode(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${this.key}\r\n\r\n`)));
  connection.on('data',data=>{const copy=data.slice();this.chain=(this.chain||Promise.resolve()).then(()=>this.receive(copy)).catch(e=>this.fail(e));});
  connection.on('close',()=>this.fail(Error('Local browser connection closed.')));
  connection.on('shutdown',()=>this.fail(Error('Local browser connection ended.')));
 }
 fail(error){this.reject(error);for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();}
 async receive(data){
  if(this.buffer.length+data.length>32*1024*1024)throw Error('Local browser frame exceeds limit.');
  const combined=new Uint8Array(this.buffer.length+data.length);combined.set(this.buffer);combined.set(data,this.buffer.length);this.buffer=combined;
  if(!this.upgraded){
   const text=dec.decode(this.buffer),end=text.indexOf('\r\n\r\n');if(end<0){if(this.buffer.length>16384)throw Error('Invalid local WebSocket upgrade');return;}
   const header=text.slice(0,end);if(!/^HTTP\/1\.[01] 101 /.test(header))throw Error('Local browser rejected WebSocket: '+header.slice(0,300));
   const accept=header.match(/^sec-websocket-accept:\s*(.+)$/im)?.[1].trim();if(accept!==await this.accept)throw Error('Local browser handshake failed.');
   this.buffer=this.buffer.slice(end+4);this.upgraded=true;this.resolve();
  }
  while(this.buffer.length>=2){
   const b=this.buffer,final=!!(b[0]&128),opcode=b[0]&15;if(b[0]&112||b[1]&128)throw Error('Invalid server WebSocket frame');
   let length=b[1]&127,offset=2;
   if(length===126){if(b.length<4)return;length=new DataView(b.buffer,b.byteOffset).getUint16(2);offset=4;}
   if(length===127){if(b.length<10)return;const v=new DataView(b.buffer,b.byteOffset);if(v.getUint32(2))throw Error('Oversized browser frame');length=v.getUint32(6);offset=10;}
   if(length>24*1024*1024)throw Error('Oversized browser frame');if(b.length<offset+length)return;
   const payload=b.slice(offset,offset+length);this.buffer=b.slice(offset+length);
   if(opcode>=8&&(!final||length>125))throw Error('Invalid browser control frame');
   if(opcode===8){this.close();return;}if(opcode===9){this.frame(10,payload);continue;}if(opcode===10)continue;
   if(opcode!==0&&opcode!==1)throw Error('Unexpected browser frame type');
   if(opcode===0&&!this.fragmented||opcode===1&&this.fragmented)throw Error('Invalid browser message continuation');
   this.fragmented=!final;
   this.fragments.push(payload);this.bytes+=payload.length;if(this.bytes>24*1024*1024)throw Error('Browser message too large');
   if(final){const message=new Uint8Array(this.bytes);let at=0;for(const part of this.fragments){message.set(part,at);at+=part.length;}this.fragments=[];this.bytes=0;const result=JSON.parse(dec.decode(message));
    if(result.id!==undefined){const item=this.pending.get(result.id);if(item){clearTimeout(item.timer);this.pending.delete(result.id);result.type==='error'?item.reject(Error(result.message||result.error)):item.resolve(result.result);}}
    else if(result.method)for(const listener of this.listeners.get(result.method)||[])listener(result.params);
   }
  }
 }
 frame(opcode,payload){
  const prefix=payload.length<126?2:payload.length<65536?4:10,mask=crypto.getRandomValues(new Uint8Array(4)),packet=new Uint8Array(prefix+4+payload.length);packet[0]=128|opcode;
  if(prefix===2)packet[1]=128|payload.length;else if(prefix===4){packet[1]=254;new DataView(packet.buffer).setUint16(2,payload.length);}else{packet[1]=255;new DataView(packet.buffer).setUint32(6,payload.length);}
  packet.set(mask,prefix);for(let i=0;i<payload.length;i++)packet[prefix+4+i]=payload[i]^mask[i%4];this.connection.write(packet);
 }
 async request(method,params={},timeout=90000){await this.ready;const id=this.next++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Local browser command timed out: '+method));},timeout);this.pending.set(id,{resolve,reject,timer});this.frame(1,enc.encode(JSON.stringify({id,method,params})));});}
 on(method,listener){if(!this.listeners.has(method))this.listeners.set(method,[]);this.listeners.get(method).push(listener);}
 close(){try{this.frame(8,new Uint8Array());}catch{}this.connection.close();this.fail(Error('Local browser connection closed.'));}
}
