// TCP transport only. Guest TLS/SSH and all workstation execution stay client-side.
import {WebSocketServer,WebSocket} from 'ws';
import net from 'node:net';
import {lookup} from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
export function publicAddress(address){
 try{const ip=ipaddr.process(address);return ip.range()==='unicast';}catch{return false;}
}
async function connectSocks(port, target, destinationPort) {
 const socket=net.connect({host:'127.0.0.1',port});
 // Keep errors handled during the handshake and until the caller attaches its listeners.
 socket.on('error',()=>socket.destroy());
 socket.setTimeout(15000,()=>socket.destroy());
 function read(size){
  return new Promise((resolve,reject)=>{
   function cleanup(){socket.off('readable',ready);socket.off('close',closed);}
   function closed(){cleanup();reject(Error('SOCKS connection closed'));}
   function ready(){const data=socket.read(size);if(data){cleanup();resolve(data);}}
   socket.on('readable',ready);socket.once('close',closed);
   if(socket.destroyed)closed();else ready();
  });
 }
 try{
  socket.write(Buffer.from([5,1,0]));
  const greeting=await read(2);
  if(greeting[0]!==5||greeting[1]!==0)throw Error('SOCKS authentication rejected');
  const address=Buffer.from(ipaddr.parse(target).toByteArray());
  const request=Buffer.alloc(6+address.length);
  request.set([5,1,0,address.length===4?1:4]);
  address.copy(request,4);
  request.writeUInt16BE(destinationPort,request.length-2);
  socket.write(request);
  const reply=await read(4);
  if(reply[0]!==5||reply[1]!==0)throw Error('SOCKS connection rejected');
  const addressLength=reply[3]===1?4:reply[3]===4?16:reply[3]===3?(await read(1))[0]:0;
  if(!addressLength)throw Error('Invalid SOCKS response');
  await read(addressLength+2);
  socket.setTimeout(0);
  return socket;
 }catch(error){socket.destroy();throw error;}
}
export function attachRelay(server,{origin='http://127.0.0.1:3001',localOrigin,path='/network/',socksPort,publicPreview=false}={}){
 const wss=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false});
 const clients=new Map();
 server.on('upgrade',(req,socket,head)=>{
  const allowedOrigin=req.headers.origin===origin||(localOrigin&&req.headers.origin===localOrigin);
  if(req.url!==path||!allowedOrigin||wss.clients.size>=16){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
 });
 wss.on('connection',(ws,req)=>{
  ws.on('error',()=>ws.terminate());
  const forwarded=req.headers['x-outpost-client-ip'];
  const client=publicPreview&&typeof forwarded==='string'&&net.isIP(forwarded)?forwarded:req.socket.remoteAddress;
  const active=clients.get(client)||0;
  if(active>=4){ws.close(1008);return;}clients.set(client,active+1);
  const streams=new Map();let byteCount=0,windowStart=Date.now(),closed=false,downloadBytes=0;
  function send(type,id,payload=Buffer.alloc(0)){
   if(ws.readyState!==WebSocket.OPEN)return;
   if(ws.bufferedAmount>4*1024*1024){ws.close(1009);return;}
   const packet=Buffer.alloc(5+payload.length);packet[0]=type;packet.writeUInt32LE(id,1);payload.copy(packet,5);ws.send(packet);
  }
  function end(id,reason=2){const stream=streams.get(id);streams.delete(id);stream?.socket?.destroy();if(stream)send(4,id,Buffer.from([reason]));}
  const credit=Buffer.alloc(4);credit.writeUInt32LE(128);send(3,0,credit);
  ws.on('message',async(raw,binary)=>{
   try{
    if(!binary||raw.length<5)throw Error();
    if(Date.now()-windowStart>1000){windowStart=Date.now();byteCount=0;}byteCount+=raw.length;
    if(byteCount>8*1024*1024)throw Error();
    const type=raw[0],id=raw.readUInt32LE(1);
    if(type===1){
     if(raw.length<9||raw.length>261||!id||streams.has(id)||streams.size>=32||raw[5]!==1)throw Error();
     const port=raw.readUInt16LE(6),host=raw.subarray(8).toString('utf8');
     const stream={socket:null,pending:[],bytes:0};streams.set(id,stream);
     if(!(port===80||port===443||(!publicPreview&&port===22))||!/^[-a-zA-Z0-9.:]+$/.test(host)){end(id,4);return;}
     const records=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await lookup(host,{all:true,verbatim:true});
     if(!records.length||records.some(r=>!publicAddress(r.address))){end(id,4);return;}
     if(closed||streams.get(id)!==stream)return;
     // Connect to the validated literal address: no second DNS lookup/rebinding.
     const target=records.find(r=>r.family===4)||records[0];
     let socket;
     try{
      socket=socksPort?await connectSocks(socksPort,target.address,port):net.connect({host:target.address,family:target.family,port,noDelay:true});
     }catch{end(id);return;}
     if(closed||streams.get(id)!==stream){socket.destroy();return;}
     stream.socket=socket;
     socket.setTimeout(120000,()=>end(id));socket.on('error',()=>end(id));socket.on('end',()=>end(id));
     function flush(){for(const data of stream.pending)socket.write(data);stream.pending=[];}
     if(socket.connecting)socket.once('connect',flush);else flush();
     socket.on('data',data=>{
      downloadBytes+=data.length;
      if(publicPreview&&downloadBytes>128*1024*1024){ws.close(1008);return;}
      send(2,id,data);
     });
     socket.resume();
    }else if(type===2){
     const stream=streams.get(id);if(!stream)return;
     const data=raw.subarray(5);if(stream.socket&&!stream.socket.connecting){if(stream.socket.writableLength>1048576){end(id);return;}stream.socket.write(data);}
     else{stream.bytes+=data.length;if(stream.bytes>262144){end(id);return;}stream.pending.push(Buffer.from(data));}
     send(3,id,credit);
    }else if(type===4)end(id,1);
    else throw Error();
   }catch{ws.close(1008);}
  });
  ws.on('close',()=>{
   closed=true;
   for(const id of [...streams.keys()])end(id);
   const remaining=(clients.get(client)||1)-1;
   if(remaining)clients.set(client,remaining);else clients.delete(client);
  });
 });
 return wss;
}
