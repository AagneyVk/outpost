export class GuestChannel{
 binaryType='arraybuffer';protocol='binary';readyState=0;onopen=null;onmessage=null;onerror=null;onclose=null;
 constructor(connection){this.connection=connection;connection.on('connect',()=>{this.readyState=1;this.onopen?.({});});connection.on('data',data=>{this.onmessage?.({data:data.slice().buffer});});connection.on('close',()=>this.closed());connection.on('shutdown',()=>this.closed());}
 send(data){if(this.readyState!==1)throw Error('Guest display is disconnected');const bytes=typeof data==='string'?new TextEncoder().encode(data):data instanceof ArrayBuffer?new Uint8Array(data):new Uint8Array(data.buffer,data.byteOffset,data.byteLength);this.connection.write(bytes);}
 closed(){if(this.readyState===3)return;this.readyState=3;this.onclose?.({code:1000,reason:'Guest display closed',wasClean:true});}
 close(){this.connection.close();this.closed();}
}
