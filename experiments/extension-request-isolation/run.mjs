import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
const dir = path.dirname(fileURLToPath(import.meta.url));
const addon = await fs.mkdtemp(path.join(dir, 'temporary-addon-'));
const profile = await fs.mkdtemp(path.join(dir, 'temporary-profile-'));
const observed = [];
let context, serverA, serverB, sockets;
const socketEmpty = process.env.OUTPOST_WS_EMPTY === '1';
const socketRule = process.env.OUTPOST_WS_RULE === '1' || socketEmpty;
const websocketProbe = process.env.OUTPOST_WS_PROBE === '1' || socketRule;
function server(handler) { return http.createServer((req, res) => {
  const item = { path: req.url, method: req.method, cookie: req.headers.cookie || '',
    marker: req.headers['x-outpost-fixture-id'] || '' };
  observed.push(item);
  handler(req, res, item);
}); }
async function listen(s) { await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + s.address().port; }
try {
  serverB = server((_req, res, item) => res.end(JSON.stringify(item)));
  const b = await listen(serverB);
  serverA = server((req, res, item) => {
    if (req.url === '/login') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      return req.on('end', () => {
        item.body = body;
        res.writeHead(302, { Location: '/account',
          'Set-Cookie': ['workspace_session=alpha; HttpOnly; Path=/', 'preference=synthetic; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/'] }).end();
      });
    }
    if (req.url === '/cross') return res.writeHead(302, { Location: b + '/external' }).end();
    if (req.url === '/account') return setTimeout(() => res.end(JSON.stringify(item)), item.cookie.includes('alpha') ? 30 : 0);
    if (req.url === '/upload') {
      const parts = [];
      req.on('data', chunk => parts.push(chunk));
      return req.on('end', () => { item.bytes = Array.from(Buffer.concat(parts)); res.end(JSON.stringify(item.bytes)); });
    }
    if (req.url === '/set') {
      const value = item.cookie.endsWith('alpha') ? 'alpha' : 'beta';
      return setTimeout(() => res.writeHead(200, { 'Set-Cookie': 'result=' + value + '; HttpOnly; Path=/' }).end(value), value === 'alpha' ? 30 : 0);
    }
    if (req.url === '/binary') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      let segment = 0;
      const write = () => {
        if (segment === 3) return res.end();
        res.write(Buffer.alloc(16384, [0, 128, 255][segment++]));
        setTimeout(write, 30);
      };
      return write();
    }
    if (req.url === '/cancel') {
      res.on('close', () => { item.closed = true; });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.write(Buffer.alloc(256, 17));
    }
    res.writeHead(404).end();
  });
  sockets = new WebSocketServer({ noServer: true });
  serverA.on('upgrade', (req, socket, head) => {
    if (req.url !== '/socket') return socket.destroy();
    observed.push({ path: req.url, method: 'WS', cookie: req.headers.cookie || '',
      marker: req.headers['x-outpost-fixture-id'] || '' });
    sockets.handleUpgrade(req, socket, head, ws => ws.on('message', (data, binary) => ws.send(data, { binary })));
  });
  const a = await listen(serverA);
  for (const name of ['manifest.json', 'index.html', 'fixture.mjs']) await fs.copyFile(path.join(dir, name), path.join(addon, name));
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  await context.addCookies([{ name: 'host_canary', value: 'must-not-leak',
    ...(websocketProbe ? { domain: '127.0.0.1', path: '/', sameSite: 'None', secure: true } : { url: a }) }]);
  const hostCanaryInitiallyStored = (await context.cookies()).some(cookie => cookie.name === 'host_canary');
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: addon });
  await cdp.detach();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + id + '/index.html?' + new URLSearchParams({ a, b, ...(websocketProbe ? { websocket: '1' } : {}), ...(socketRule ? { socketRule: '1' } : {}), ...(socketEmpty ? { socketEmpty: '1' } : {}) }));
  await page.waitForFunction(() => !!globalThis.fixtureResult, null, { timeout: 40000 });
  const result = await page.evaluate(() => globalThis.fixtureResult);
  for (let i = 0; i < 100 && !observed.find(item => item.path === '/cancel')?.closed; i++)
    await new Promise(resolve => setTimeout(resolve, 25));
  console.log(JSON.stringify({ browser: context.browser().version(), hostCanaryInitiallyStored,
    fatal: result.fatal, redirectNetworkResponse: result.login?.networkResponse,
    websocket: result.websocket, remainingRules: result.remainingRules,
    socketRequests: result.socketRequests, matchedRules: result.matchedRules, sentHandshakes: result.sentHandshakes, cancellationEvents: result.cancellationEvents,
    streamed: result.streamed?.streamed, errors: result.errors, observed }, null, 2));
  assert.equal(result.fatal, undefined);
  assert.equal(hostCanaryInitiallyStored, true, 'host-cookie control must exist');
  assert.deepEqual(result.errors, []);
  assert.equal(result.login.status, 302);
  assert.equal(observed.find(item => item.path === '/login')?.body, 'synthetic-login');
  assert.equal(result.login.headers.filter(h => h.name.toLowerCase() === 'set-cookie').length, 2);
  assert.ok(result.login.headers.some(h => h.name.toLowerCase() === 'set-cookie' && h.value.includes('Wed, 21 Oct 2037')));
  assert.equal(result.login.headers.find(h => h.name.toLowerCase() === 'location').value, '/account');
  assert.equal(JSON.parse(result.account.body).cookie, 'workspace_session=alpha');
  assert.deepEqual(result.parallel.map(r => JSON.parse(r.body).cookie), ['workspace_session=alpha', 'workspace_session=beta']);
  assert.deepEqual(result.parallelSet.map(r => r.headers.find(h => h.name.toLowerCase() === 'set-cookie').value),
    ['result=alpha; HttpOnly; Path=/', 'result=beta; HttpOnly; Path=/']);
  assert.notEqual(result.parallelSet[0].networkId, result.parallelSet[1].networkId);
  assert.deepEqual(JSON.parse(result.upload.body), [0, 127, 128, 255]);
  assert.deepEqual(observed.find(item => item.path === '/upload')?.bytes, [0, 127, 128, 255]);
  assert.equal(result.streamed.status, 200);
  assert.equal(result.streamed.streamed.length, 49152);
  assert.equal(result.streamed.streamed.checksum, (128 + 255) * 16384);
  assert.ok(result.streamed.streamed.chunks >= 2, 'fixture response should arrive in multiple chunks');
  assert.equal(result.cancelled.streamed.cancelled, true);
  assert.equal(observed.find(item => item.path === '/cancel')?.closed, true, 'server should observe stream cancellation');
  assert.ok(result.cancellationEvents.some(event => event.networkId === result.cancelled.networkId));
  assert.equal(result.cross.status, 302);
  assert.equal(result.cross.headers.find(h => h.name.toLowerCase() === 'location').value, b + '/external');
  assert.equal(JSON.parse(result.external.body).cookie, '');
  assert.equal(observed.filter(r => r.path === '/external').length, 1, 'redirect must not auto-follow');
  assert.ok(observed.every(r => !r.marker && ((r.method === 'WS' && !socketRule) || !r.cookie.includes('host_canary'))));
  assert.equal((await context.cookies(a)).some(cookie => cookie.name === 'workspace_session'), false);
  assert.equal((await context.cookies(a)).some(cookie => cookie.name === 'result'), false);
  if (websocketProbe) {
    assert.deepEqual(result.websocket, { ok: true, text: 'synthetic-echo', binary: [0, 127, 128, 255] });
    const handshake = observed.find(r => r.method === 'WS');
    assert.equal(handshake.cookie, socketEmpty ? '' : socketRule ? 'workspace_session=alpha' : 'host_canary=must-not-leak');
    // Chrome's debugger omits this header even when the loopback server sees it.
    // It cannot by itself prove whether the real handshake carried a cookie.
    assert.deepEqual(result.sentHandshakes, [{ cookie: '' }]);
    assert.deepEqual(result.remainingRules, []);
    assert.equal(result.matchedRules.length, socketRule ? 1 : 0);
  }
} finally {
  if (context) await context.close();
  if (sockets) await new Promise(resolve => sockets.close(resolve));
  for (const s of [serverA, serverB]) if (s) await new Promise(resolve => s.close(resolve));
  for (const temporary of [addon, profile]) {
    if (path.dirname(temporary) !== dir) throw Error('Invalid temporary path');
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
