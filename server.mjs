import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import {attachRelay} from './relay.mjs';
const root=path.resolve(import.meta.dirname,'public');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json'};
const server=http.createServer(async(req,res)=>{
 try{
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405).end();return;}
  if(req.url==='/workspace-tool.py'){
   const source=path.resolve(import.meta.dirname,'runtime/workspace.py');
   res.writeHead(200,{'content-type':'text/plain','cross-origin-resource-policy':'same-origin','cache-control':'no-store'});createReadStream(source).on('error',()=>res.destroy()).pipe(res);return;
  }
  const pathname=new URL(req.url,'http://localhost').pathname;
  const p=path.resolve(root,'.'+decodeURIComponent(pathname==='/'?'/gecko-lab/index.html':pathname));
  const file=p===root?path.join(root,'index.html'):p;
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  const s=await stat(file);if(!s.isFile())throw Error();
  const immutable=/[\\/](?:debian32|vnc32)[\\/]rootfs[\\/][a-f0-9]{10}\.bin$/.test(file);
  res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','content-length':s.size,'cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':'require-corp','x-content-type-options':'nosniff','cache-control':immutable?'public, max-age=31536000, immutable':'no-store'});
  if(req.method==='HEAD')res.end();else createReadStream(file).on('error',()=>res.destroy()).pipe(res);
 }catch{res.writeHead(404).end('Not found');}
});
const port = Number(process.env.OUTPOST_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid OUTPOST_PORT');
const origin = process.env.OUTPOST_ORIGIN ?? 'http://127.0.0.1:' + port;
if (process.env.OUTPOST_ORIGIN && (new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin)) {
 throw Error('OUTPOST_ORIGIN must be an HTTPS origin without a trailing slash');
}
const socksPort = process.env.OUTPOST_SOCKS_PORT === undefined ? undefined : Number(process.env.OUTPOST_SOCKS_PORT);
if (socksPort !== undefined && (!Number.isInteger(socksPort) || socksPort < 1 || socksPort > 65535)) {
 throw Error('Invalid OUTPOST_SOCKS_PORT');
}
const localOrigin = process.env.OUTPOST_ORIGIN ? undefined : 'http://localhost:' + port;
const publicPreview = process.env.OUTPOST_PUBLIC_PREVIEW === '1';
if (publicPreview && !process.env.OUTPOST_ORIGIN) throw Error('Public preview requires an HTTPS OUTPOST_ORIGIN');
attachRelay(server, {origin,localOrigin,socksPort,publicPreview});
const bind = process.env.OUTPOST_BIND ?? '127.0.0.1';
if (bind !== '127.0.0.1' && !(bind === '0.0.0.0' && publicPreview)) {
 throw Error('Non-loopback binding requires public preview mode');
}
server.listen(port, bind, () => console.log('OUTPOST: ' + origin));
