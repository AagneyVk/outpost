import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import path from 'node:path';
import {attachRelay} from './relay.mjs';
const root=path.resolve(import.meta.dirname,'public');
const directLocal = process.argv.includes('--direct-local');
const inspectionDirectory = process.env.OUTPOST_INSPECTION_DIR ??
 path.resolve(import.meta.dirname, 'local-inspection');
const inspectionDb = path.join(inspectionDirectory, 'cert9.db');
const inspectionRoot = path.join(inspectionDirectory, 'approved-ca.der');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json'};
const server=http.createServer(async(req,res)=>{
 try{
  if(directLocal&&!localHosts.has(req.headers.host)){res.writeHead(421).end();return;}
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405).end();return;}
  if(req.url==='/workspace-tool.py'){
   const source=path.resolve(import.meta.dirname,'runtime/workspace.py');
   res.writeHead(200,{'content-type':'text/plain','cross-origin-resource-policy':'same-origin','cache-control':'no-store'});createReadStream(source).on('error',()=>res.destroy()).pipe(res);return;
  }
  const pathname=new URL(req.url,'http://localhost').pathname;
  if (directLocal && ['/gecko-lab/inspection-cert-db','/gecko-lab/inspection-authority'].includes(pathname)) {
   const approved = new X509Certificate(readFileSync(inspectionRoot));
   const expected = createHash('sha256').update(approved.raw).digest('hex');
   const match = new URL(req.url,'http://localhost').searchParams.get('sha256');
   if (!approved.ca || Date.parse(approved.validFrom) > Date.now() ||
       Date.parse(approved.validTo) < Date.now()) {
    res.writeHead(404).end();return;
   }
   const { size } = await stat(inspectionDb);
   if (!size || size > 1024 * 1024) { res.writeHead(404).end();return; }
   if (pathname === '/gecko-lab/inspection-authority') {
    res.writeHead(200, {'content-type':'application/json','cache-control':'no-store','cross-origin-resource-policy':'same-origin'});
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({subject:approved.subject, fingerprint:expected}));
    return;
   }
   if (match !== expected) { res.writeHead(404).end();return; }
   res.writeHead(200, {'content-type':'application/octet-stream','cache-control':'no-store','cross-origin-resource-policy':'same-origin'});
   if (req.method === 'HEAD') res.end();
   else createReadStream(inspectionDb).on('error',()=>res.destroy()).pipe(res);
   return;
  }
  const p=path.resolve(root,'.'+decodeURIComponent(pathname==='/'?'/gecko-lab/index.html':pathname));
  const experimentalProfile = directLocal && pathname === '/gecko-lab/inspection-memory.mjs';
  const file=experimentalProfile
   ? path.resolve(import.meta.dirname,'experiments/memory-profile/memory-profile.mjs')
   : p===root?path.join(root,'index.html'):p;
  if(!experimentalProfile&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  const s=await stat(file);if(!s.isFile())throw Error();
  const immutable=/[\\/](?:debian32|vnc32)[\\/]rootfs[\\/][a-f0-9]{10}\.bin$/.test(file);
  res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','content-length':s.size,'cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':'require-corp','x-content-type-options':'nosniff','cache-control':immutable?'public, max-age=31536000, immutable':'no-store'});
  if(req.method==='HEAD')res.end();else createReadStream(file).on('error',()=>res.destroy()).pipe(res);
 }catch{res.writeHead(404).end('Not found');}
});
const port = Number(process.env.OUTPOST_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid OUTPOST_PORT');
const origin = process.env.OUTPOST_ORIGIN ?? 'http://127.0.0.1:' + port;
const localHosts = new Set(['127.0.0.1:' + port, 'localhost:' + port]);
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
const bind = process.env.OUTPOST_BIND ?? '127.0.0.1';
if (bind !== '127.0.0.1' && !(bind === '0.0.0.0' && publicPreview)) {
 throw Error('Non-loopback binding requires public preview mode');
}
if (directLocal && (bind !== '127.0.0.1' || process.env.OUTPOST_ORIGIN || publicPreview || socksPort !== undefined)) {
 throw Error('Direct local mode requires loopback and cannot use a public origin or upstream SOCKS proxy');
}
const exitFile = path.resolve(import.meta.dirname, 'outpost-exit.json');
let encryptedExit;
if (directLocal && existsSync(exitFile)) {
 const { host, port: exitPort, ca, cert, key } = JSON.parse(readFileSync(exitFile, 'utf8'));
 if (typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host) ||
     !Number.isInteger(exitPort) || exitPort < 1 || exitPort > 65535 ||
     typeof ca !== 'string' || !ca.startsWith('-----BEGIN CERTIFICATE-----') ||
     typeof cert !== 'string' || !cert.startsWith('-----BEGIN CERTIFICATE-----') ||
     typeof key !== 'string' || !key.includes('PRIVATE KEY-----')) {
  throw Error('Invalid encrypted exit configuration');
 }
 encryptedExit = {host, port:exitPort, servername:host, ca, cert, key};
}
attachRelay(server, {origin,localOrigin,socksPort,encryptedExit,publicPreview,webOnly:directLocal,
 allowedHosts:directLocal ? localHosts : undefined});
server.listen(port, bind, () => {
 console.log('OUTPOST: ' + origin);
 if (directLocal) console.log(encryptedExit ? 'Encrypted exit configured.' : 'Direct local mode: Gecko connects through this computer.');
});
