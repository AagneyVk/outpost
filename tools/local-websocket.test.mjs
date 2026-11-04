import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {GuestWebSocket} from '../public/local-websocket.js';
class Connection{
 handlers={};writes=[];
 on(name,fn){this.handlers[name]=fn;}
 emit(name,data){this.handlers[name]?.(data);}
 write(bytes){this.writes.push(bytes);}
 close(){}
}
const frame=(text,first=129)=>{const data=new TextEncoder().encode(text);assert.ok(data.length<126);return new Uint8Array([first,data.length,...data]);};
async function connected(){const c=new Connection(),ws=new GuestWebSocket(c,{origin:'http://localhost'});c.emit('connect');const request=new TextDecoder().decode(c.writes[0]),key=request.match(/Sec-WebSocket-Key: (.+)\r/)[1];const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');const response=new TextEncoder().encode('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');c.emit('data',response.slice(0,30));c.emit('data',response.slice(30));await ws.ready;return{c,ws};}
test('private WebSocket verifies upgrade and handles fragmented BiDi replies',async()=>{
 const{c,ws}=await connected();const result=ws.request('session.status');await Promise.resolve();await Promise.resolve();const sent=c.writes.at(-1);assert.ok(sent[1]&128,'Client frames must be masked');
 c.emit('data',frame('{"type":"success",',1));c.emit('data',frame('"id":1,"result":{"ready":true}}',128));assert.deepEqual(await result,{ready:true});ws.close();
});
test('invalid private handshake fails before protocol use',async()=>{
 const c=new Connection(),ws=new GuestWebSocket(c,{origin:'http://localhost'}),failed=assert.rejects(ws.ready,/handshake/);c.emit('data',new TextEncoder().encode('HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: wrong\r\n\r\n'));await failed;
});
