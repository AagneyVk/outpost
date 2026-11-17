import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const dir = path.dirname(fileURLToPath(import.meta.url));
const profile = await fs.mkdtemp(path.join(dir, 'temporary-profile-'));
const addon = await fs.mkdtemp(path.join(dir, 'temporary-addon-'));
let firefox, socket, server;
try {
  await fs.writeFile(path.join(profile, 'user.js'), [
    'user_pref("devtools.debugger.remote-enabled", true);',
    'user_pref("devtools.chrome.enabled", true);',
    'user_pref("devtools.debugger.prompt-connection", false);',
    'user_pref("toolkit.telemetry.enabled", false);'
  ].join('\n'));
  await fs.copyFile(path.join(dir, 'manifest.json'), path.join(addon, 'manifest.json'));
  await fs.copyFile(path.join(dir, 'background.js'), path.join(addon, 'background.js'));
  await fs.copyFile(path.join(dir, 'content.js'), path.join(addon, 'content.js'));
  let resolveReport;
  const report = new Promise(resolve => { resolveReport = resolve; });
  server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html', 'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp' });
      res.end(`<!doctype html><meta charset="utf-8"><title>OUTPOST test</title><script>
        (async function () {
          let id = 0;
          function request(url) {
            return new Promise(function (resolve, reject) {
              const expected = ++id;
              const timer = setTimeout(function () { reject(Error('bridge timeout')); }, 12000);
              function receive(event) {
                if (event.source !== window || event.origin !== location.origin || !event.data ||
                    event.data.type !== 'outpost-test-response' || event.data.id !== expected) return;
                clearTimeout(timer); window.removeEventListener('message', receive); resolve(event.data.result);
              }
              window.addEventListener('message', receive);
              window.postMessage({ type: 'outpost-test-request', id: expected, url: url }, location.origin);
            });
          }
          const urls = ['https://example.com/', 'https://expired.badssl.com/', 'https://self-signed.badssl.com/'];
          const results = [];
          for (const url of urls) {
            const result = await request(url);
            results.push({ url: url, ok: result.ok, status: result.status || null,
              expectedBody: !!(result.body && result.body.includes('Example Domain')),
              state: result.security && result.security.state || null,
              requestId: result.security && result.security.id || null,
              derLengths: result.security ? result.security.certificates.map(function (c) { return c.length; }) : [],
              error: result.error || null, networkError: result.networkError || null });
          }
          await fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({results}) });
        }()).catch(function (error) { fetch('/report', { method:'POST', body:JSON.stringify({fatal:String(error)}) }); });
      </script>`);
      return;
    }
    if (req.method !== 'POST' || req.url !== '/report') { res.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 16384) { res.writeHead(413).end(); return; }
    }
    try { resolveReport(JSON.parse(body)); res.writeHead(204).end(); }
    catch { res.writeHead(400).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(path.join(addon, 'config.js'),
    'const TEST_PAGE = ' + JSON.stringify('http://127.0.0.1:' + server.address().port + '/') + ';\n');
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  firefox = spawn(process.env.OUTPOST_FIREFOX || 'C:/Program Files/Mozilla Firefox/firefox.exe', [
    '-headless', '-no-remote', '-profile', profile, '-start-debugger-server', String(port), 'about:blank'
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  firefox.stderr.on('data', data => { log += data.toString(); });
  const until = Date.now() + 30000;
  while (!socket && Date.now() < until) {
    try {
      socket = await new Promise((resolve, reject) => {
        const client = net.createConnection({ port, host: '127.0.0.1' });
        client.once('connect', () => resolve(client)); client.once('error', reject);
      });
    } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (!socket) throw Error('Firefox debugger did not start: ' + log.slice(-500));
  let buffer = Buffer.alloc(0);
  const messages = [];
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const colon = buffer.indexOf(58);
      if (colon < 0) return;
      const length = Number(buffer.subarray(0, colon).toString());
      if (!Number.isInteger(length) || length > 1000000) throw Error('Invalid debugger packet');
      if (buffer.length < colon + 1 + length) return;
      messages.push(JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString()));
      buffer = buffer.subarray(colon + 1 + length);
    }
  });
  async function receive() {
    const deadline = Date.now() + 15000;
    while (!messages.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!messages.length) throw Error('Debugger response timeout');
    return messages.shift();
  }
  async function send(message) {
    const json = JSON.stringify(message);
    socket.write(Buffer.byteLength(json) + ':' + json);
    const response = await receive();
    if (response.error) throw Error(response.error + ': ' + response.message);
    return response;
  }
  await receive();
  let root;
  try { root = await send({ to: 'root', type: 'getRoot' }); }
  catch { root = await send({ to: 'root', type: 'listTabs' }); }
  if (!root.addonsActor) throw Error('Firefox has no add-on debugger actor: ' + JSON.stringify(root));
  await send({ to: root.addonsActor, type: 'installTemporaryAddon', addonPath: addon });
  let timer;
  const result = await Promise.race([report,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Firefox extension report timed out')), 45000); })
  ]).finally(() => clearTimeout(timer));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.fatal, undefined);
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].expectedBody, true);
  assert.equal(result.results[0].state, 'secure');
  assert.ok(result.results[0].requestId);
  assert.ok(result.results[0].derLengths.length > 0 && result.results[0].derLengths.every(length => length > 0));
  for (const negative of result.results.slice(1)) {
    assert.equal(negative.ok, false);
    assert.equal(negative.state, null);
    assert.match(negative.networkError || '', /cert/i);
  }
} finally {
  socket?.destroy();
  if (firefox && firefox.exitCode === null) {
    firefox.kill();
    await Promise.race([new Promise(resolve => firefox.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  if (server) await new Promise(resolve => server.close(resolve));
  for (const temporary of [profile, addon]) {
    if (path.dirname(temporary) !== dir) throw Error('Invalid temporary path');
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
