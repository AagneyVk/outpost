import {test} from 'node:test';import assert from 'node:assert/strict';
import http from 'node:http';import {WebSocket} from 'ws';import tls from 'node:tls';import {Duplex} from 'node:stream';
import {attachRelay,publicAddress} from '../relay.mjs';
import net from 'node:net';

test('optional SOCKS egress tunnels bytes to a validated destination',{timeout:5000},async()=>{
 const sockets=new Set();
 const proxy=net.createServer(socket=>{
  sockets.add(socket);
  socket.once('close',()=>sockets.delete(socket));
  socket.once('data',greeting=>{
   assert.deepEqual(greeting,Buffer.from([5,1,0]));
   socket.write(Buffer.from([5,0]));
   socket.once('data',request=>{
    assert.deepEqual(request,Buffer.from([5,1,0,1,93,184,215,14,1,187]));
    socket.write(Buffer.from([5,0,0,1,0,0,0,0,0,0]));
    socket.on('data',data=>socket.write(data));
   });
  });
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const server=http.createServer();
 const relay=attachRelay(server,{socksPort:proxy.address().port});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const ws=new WebSocket('ws://127.0.0.1:'+server.address().port+'/network/',{origin:'http://127.0.0.1:3001'});
 try{
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const received=new Promise(resolve=>ws.on('message',packet=>{if(packet[0]===2)resolve(packet.subarray(5));}));
  ws.send(Buffer.concat([Buffer.from([1,1,0,0,0,1,187,1]),Buffer.from('93.184.215.14')]));
  ws.send(Buffer.from([2,1,0,0,0,42]));
  assert.deepEqual(await received,Buffer.from([42]));
 }finally{
  ws.terminate();
  for(const client of relay.clients)client.terminate();
  for(const socket of sockets)socket.destroy();
  await Promise.all([new Promise(resolve=>proxy.close(resolve)),new Promise(resolve=>server.close(resolve))]);
 }
});
test('nonpublic destinations are rejected, including mapped IPv6',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.2','172.16.0.1','::1','fe80::1','fc00::1','::ffff:127.0.0.1','0.0.0.0','224.0.0.1'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('93.184.215.14'),true);
});
test('account-free preview blocks outbound SSH',{timeout:5000},async()=>{
 const server=http.createServer();
 const origin='https://preview.example';
 const relay=attachRelay(server,{origin,publicPreview:true});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const ws=new WebSocket('ws://127.0.0.1:'+server.address().port+'/network/',{origin});
 try{
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const rejected=new Promise(resolve=>ws.on('message',packet=>{if(packet[0]===4)resolve(packet[5]);}));
  ws.send(Buffer.concat([Buffer.from([1,1,0,0,0,1,22,0]),Buffer.from('93.184.215.14')]));
  assert.equal(await rejected,4);
 }finally{
  ws.terminate();
  for(const client of relay.clients)client.terminate();
  await new Promise(resolve=>server.close(resolve));
 }
});
test('relay rejects foreign origins and private network streams',async()=>{
 const server=http.createServer();const relay=attachRelay(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='ws://127.0.0.1:'+server.address().port+'/network/';
 try{
  await new Promise((resolve,reject)=>{const ws=new WebSocket(url,{origin:'https://foreign.invalid'});ws.on('open',()=>reject(Error('Foreign origin accepted')));ws.on('error',resolve);});
  const ws=new WebSocket(url,{origin:'http://127.0.0.1:3001'});await new Promise((r,j)=>{ws.on('open',r);ws.on('error',j);});
  const closed=new Promise(resolve=>ws.on('message',b=>{if(b[0]===4)resolve(b);}));
  const host=Buffer.from('127.0.0.1'),packet=Buffer.alloc(8+host.length);packet[0]=1;packet.writeUInt32LE(1,1);packet[5]=1;packet.writeUInt16LE(443,6);host.copy(packet,8);ws.send(packet);
  assert.equal((await closed)[5],4);ws.close();
 }finally{for(const ws of relay.clients)ws.terminate();await new Promise(r=>server.close(r));}
});
test('actual HTTPS passes through without terminating guest TLS',{skip:!process.env.OUTPOST_NETWORK_TEST,timeout:60000},async()=>{
 const server=http.createServer();const relay=attachRelay(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const ws=new WebSocket('ws://127.0.0.1:'+server.address().port+'/network/',{origin:'http://127.0.0.1:3001'});let socket;
 try{
  await new Promise((r,j)=>{ws.on('open',r);ws.on('error',j);});
  const transport=new Duplex({read(){},write(data,encoding,done){const b=Buffer.alloc(5+data.length);b[0]=2;b.writeUInt32LE(1,1);data.copy(b,5);ws.send(b,done);}});
  ws.on('message',b=>{if(b[0]===2)transport.push(b.subarray(5));if(b[0]===4)transport.push(null);});
  const host=Buffer.from('example.com'),packet=Buffer.alloc(8+host.length);packet[0]=1;packet.writeUInt32LE(1,1);packet[5]=1;packet.writeUInt16LE(443,6);host.copy(packet,8);ws.send(packet);
  socket=tls.connect({socket:transport,servername:'example.com',rejectUnauthorized:true});
  await new Promise((r,j)=>{socket.once('secureConnect',r);socket.once('error',j);});
  socket.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');let response='';
  await new Promise((r,j)=>{socket.on('data',b=>response+=b);socket.once('end',r);socket.once('error',j);});assert.match(response,/HTTP\/1\.[01] 200/);assert.match(response,/Example Domain/);
 }finally{socket?.destroy();ws.terminate();for(const c of relay.clients)c.terminate();await new Promise(r=>server.close(r));}
});
