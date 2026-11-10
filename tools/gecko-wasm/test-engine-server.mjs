// Local-only preview: serve the normal app with an alternate Gecko build.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { attachRelay } from '../../relay.mjs';

const app = path.resolve(import.meta.dirname, '../../public');
const engine = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw Error('Provide the alternate engine directory.');
const port = Number(process.env.OUTPOST_TEST_PORT ?? 3002);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405).end();
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname === '/' ? '/gecko-lab/index.html' : url.pathname;
    const name = pathname.slice('/gecko-lab/engine/'.length);
    const alternate = pathname.startsWith('/gecko-lab/engine/') &&
      ['gecko.js', 'gecko.wasm.zst', 'gecko-input-v1.js', 'gecko-input-v1.wasm.zst',
        'gecko-input-v2.js', 'gecko-input-v2.wasm.zst'].includes(name);
    const root = alternate ? engine : app;
    const file = alternate ? path.join(root, name.replace(/^gecko-input-v[12]/, 'gecko')) : path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    const info = await stat(file);
    if (!info.isFile()) throw Error('Not a file');
    res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream',
      'content-length': info.size, 'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp', 'cache-control': 'no-store' });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch { res.writeHead(404).end('Not found'); }
});
attachRelay(server, { origin: `http://127.0.0.1:${port}`, localOrigin: `http://localhost:${port}` });
server.listen(port, '127.0.0.1', () => console.log(`Test engine on http://127.0.0.1:${port}/`));
