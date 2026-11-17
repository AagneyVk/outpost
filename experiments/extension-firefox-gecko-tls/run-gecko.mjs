import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';

const dir = path.dirname(fileURLToPath(import.meta.url));
const forgedTest = process.env.OUTPOST_FORGED_TEST === '1';
if (!process.env.OUTPOST_FIXTURE_BUILD) throw Error('Set OUTPOST_FIXTURE_BUILD to the test engine artifact directory');
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
  const build = path.resolve(process.env.OUTPOST_FIXTURE_BUILD);
  let relayAttempts = 0;
  server = http.createServer(async (req, res) => {
    const routes = { '/': [path.join(dir, 'gecko-page.html'), 'text/html'],
      '/engine/gecko.js': [path.join(build, 'gecko.js'), 'text/javascript'],
      '/engine/gecko.wasm.zst': [path.join(build, 'gecko.wasm.zst'), 'application/octet-stream'] };
    routes['/synthetic-cert'] = [path.join(dir, 'synthetic-example-com-cert.b64'), 'text/plain'];
    const requestPath = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && routes[requestPath]) {
      const [file, type] = routes[requestPath];
      const data = await fs.readFile(file);
      res.writeHead(200, { 'content-type': type, 'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp', 'cache-control': 'no-store' });
      res.end(data);
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
  server.on('upgrade', (req, connection) => {
    if (req.url === '/wisp/') relayAttempts++;
    connection.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const testPage = 'http://127.0.0.1:' + server.address().port + '/' + (forgedTest ? '?case=forged' : '');
  await fs.writeFile(path.join(addon, 'config.js'),
    'const TEST_PAGE = ' + JSON.stringify(testPage) + ';\n');
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
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Firefox Gecko fixture timed out')), 180000); })
  ]).finally(() => clearTimeout(timer));
  const wrongLeaf = result.wrongLeaf;
  delete result.wrongLeaf;
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.fatal, undefined);
  assert.equal(result.site.href, 'https://example.com/');
  assert.equal(result.site.title, 'Example Domain');
  assert.equal(result.site.secureContext, true);
  assert.equal(result.securityInfo, 'present');
  assert.equal(result.hostEvidence.length, 3);
  assert.equal(result.hostEvidence[0].state, 'secure');
  assert.ok(result.hostEvidence[0].derLengths.every(length => length > 0));
  assert.equal(result.geckoFingerprint, result.hostEvidence[0].fingerprint);
  assert.equal(result.beforeHsts, 'absent');
  assert.equal(result.afterHsts, 'present');
  assert.equal(result.missing, 'failed');
  const adversarialCert = new X509Certificate(Buffer.from(wrongLeaf, 'base64'));
  if (forgedTest) {
    assert.equal(adversarialCert.checkHost('example.com'), 'example.com');
    assert.equal(adversarialCert.verify(adversarialCert.publicKey), true, 'fixture must be self-signed');
    assert.equal(result.corrupt, 'ok', 'this test documents a known trust-boundary vulnerability');
    console.log('KNOWN VULNERABILITY: forged self-signed same-host certificate was accepted.');
  } else {
    assert.equal(adversarialCert.checkHost('example.com'), undefined,
      'The adversarial certificate must belong to a different host');
    assert.equal(result.corrupt, 'failed');
  }
  assert.equal(result.expired, 'failed');
  assert.equal(result.selfSigned, 'failed');
  assert.equal(result.failures.length, 2);
  for (const failure of result.failures) assert.match(failure.networkError || '', /cert/i);
  assert.equal(relayAttempts, 0, 'fixture must not fall back to a relay');
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
