// Research only: compare the real Gecko Wisp client in a disposable extension
// with and without a credentialless-frame WebSocket constructor. Local WSS,
// self-signed certificate exception, and synthetic cookies only.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { waitForAsync } from '../../tools/wait-for-async.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const flag = process.argv.indexOf('--addon');
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--addon requires a directory');
const addon = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(root, '../outpost-extension-inventory-preview'));
const hardenedFlag = process.argv.indexOf('--hardened-addon');
if (hardenedFlag >= 0 && !process.argv[hardenedFlag + 1]) throw Error('--hardened-addon requires a directory');
const hardenedAddon = hardenedFlag >= 0 ? path.resolve(process.argv[hardenedFlag + 1]) : null;
const livePreview = process.argv.includes('--encrypted-live-preview');
if (livePreview && !hardenedAddon) throw Error('--encrypted-live-preview requires a hardened addon');
if (process.argv.includes('--test-post') && !process.argv.includes('--test-recovery')) throw Error('--test-post requires --test-recovery');
if (process.argv.includes('--experimental-reconnect') && (!hardenedAddon || !process.argv.includes('--test-post'))) throw Error('--experimental-reconnect requires a hardened addon and the synthetic POST control');
if (process.argv.includes('--test-restart') && (!hardenedAddon || !process.argv.includes('--test-post') || process.argv.includes('--experimental-reconnect'))) throw Error('--test-restart requires a hardened addon and the POST control without experimental reconnect');
if (process.argv.includes('--test-save-failure') && !process.argv.includes('--test-restart')) throw Error('--test-save-failure requires --test-restart');
if (process.argv.includes('--test-tab-save-failure') && !process.argv.includes('--test-restart')) throw Error('--test-tab-save-failure requires --test-restart');
if (process.argv.includes('--test-relay-save-failure') && !process.argv.includes('--test-restart')) throw Error('--test-relay-save-failure requires --test-restart');
if (process.argv.includes('--test-missing-relay') && !hardenedAddon) throw Error('--test-missing-relay requires a hardened addon');
if (process.argv.includes('--test-fallback') && !hardenedAddon) throw Error('--test-fallback requires a hardened addon');
const tempRoot = livePreview ? path.resolve(os.tmpdir()) : here;
const tempPrefix = livePreview ? 'outpost-live-relay-' : 'temporary-relay-';
const temp = await fs.mkdtemp(path.join(tempRoot, tempPrefix));
const contexts = [], requests = [], hostRequests = [];
let server, wss, tlsErrors = 0, rejectedV2 = 0;
try {
  const openssl = process.env.OUTPOST_OPENSSL || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
  const key = path.join(temp, 'key.pem'), cert = path.join(temp, 'cert.pem');
  await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', key, '-out', cert]);
  server = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) });
  server.on('tlsClientError', () => { tlsErrors++; });
  server.on('request', (req, res) => {
    hostRequests.push(req.headers.cookie || '');
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Host cookie check</title>');
  });
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/fallback/' && (req.headers['sec-websocket-protocol'] || '').split(',').map(x => x.trim()).includes('wisp-v2')) {
      rejectedV2++;
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } else wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('headers', headers => headers.push('Set-Cookie: relay_response_canary=synthetic-only; Path=/; Secure; SameSite=None'));
  wss.on('connection', (socket, req) => {
    const handshake = { cookies: req.headers.cookie || '', paths: [], http: [], socket }; requests.push(handshake);
    const send = (type, stream, body) => {
      const header = Buffer.alloc(5); header[0] = type; header.writeUInt32LE(stream, 1);
      socket.send(Buffer.concat([header, body]));
    };
    send(3, 0, Buffer.from([128, 0, 0, 0]));
    const pending = new Map(), responded = new Set();
    socket.on('message', payload => {
      const packet = Buffer.from(payload);
      if (packet.length < 5 || packet[0] !== 2) return;
      const stream = packet.readUInt32LE(1);
      if (responded.has(stream)) return;
      const text = (pending.get(stream) || '') + packet.subarray(5).toString('latin1'); pending.set(stream, text);
      if (!text.includes('\r\n\r\n')) return;
      responded.add(stream); handshake.paths.push(text.split('\r\n')[0]); handshake.http.push(text);
      if (/^POST \/synthetic-submit HTTP/.test(text)) { socket.close(1011, 'synthetic interruption'); return; }
      const body = '<!doctype html><title>Local Wisp fixture</title><p>Local relay works</p>';
      const cookie = /^GET \/ HTTP/.test(text) ? 'Set-Cookie: guest_session=synthetic-guest-only; Path=/; HttpOnly\r\n' : '';
      send(2, stream, Buffer.from(`HTTP/1.1 200 OK\r\n${cookie}Content-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
      send(4, stream, Buffer.from([1]));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const relay = `wss://127.0.0.1:${server.address().port}/`;
  async function run(isolated, forceUnsupported = false, denyBadCertificate = false, failSave = false, missingRelay = false, failTabs = false, failRelaySave = false, fallback = false) {
    const variant = fallback ? 'fallback' : failRelaySave ? 'relay-save-failure' : failTabs ? 'tab-save-failure' : missingRelay ? 'missing-relay' : failSave ? 'save-failure' : denyBadCertificate ? 'bad-certificate' : forceUnsupported ? 'unsupported' : isolated ? 'isolated' : 'baseline', copied = path.join(temp, variant);
    await fs.cp(isolated && hardenedAddon ? hardenedAddon : addon, copied, { recursive: true });
    if (isolated && !forceUnsupported && !denyBadCertificate && process.argv.includes('--experimental-reconnect')) {
      // Negative control only: this reconnect patch has been observed to
      // replay an interrupted synthetic POST. Never ship this test copy.
      const glue = path.join(copied, 'gecko-lab/engine/engine-glue.js');
      const source = await fs.readFile(glue, 'utf8');
      const marker = 'var teardown = function(errno) {\n      conn.ready = false;';
      if (source.indexOf(marker) < 0 || source.indexOf(marker) !== source.lastIndexOf(marker)) throw Error('Unexpected Wisp teardown.');
      await fs.writeFile(glue, source.replace(marker, 'var teardown = function(errno) {\n      if (WISP.conn === conn) WISP.conn = null;\n      conn.ready = false;'));
    }
    if (isolated && !hardenedAddon) {
      const engine = path.join(copied, 'gecko-lab/engine/gecko-input-v7.js');
      let source = await fs.readFile(engine, 'utf8');
      const marker = 'new WebSocket(this.wisp_url, subprotocol)';
      if (source.indexOf(marker) < 0 || source.indexOf(marker) !== source.lastIndexOf(marker)) throw Error('Unexpected Wisp client.');
      source = source.replace(marker, 'new window.__testIsolatedWebSocket(this.wisp_url, subprotocol)');
      await fs.writeFile(engine, source);
      await fs.writeFile(path.join(copied, 'gecko-lab/relay-test-frame.html'), '<!doctype html><title>Relay test frame</title>');
      const start = path.join(copied, 'gecko-lab/start.mjs');
      source = await fs.readFile(start, 'utf8');
      const anchor = '    gecko = new Gecko({';
      if (source.indexOf(anchor) < 0 || source.indexOf(anchor) !== source.lastIndexOf(anchor)) throw Error('Unexpected Gecko startup.');
      const setup = `    const testFrame = document.createElement('iframe');
    if (!('credentialless' in testFrame)) throw Error('Credentialless frames are unavailable');
    testFrame.credentialless = true;
    testFrame.hidden = true;
    testFrame.src = chrome.runtime.getURL('gecko-lab/relay-test-frame.html');
    await new Promise((resolve, reject) => { testFrame.onload = resolve; testFrame.onerror = reject; document.body.append(testFrame); });
    window.__testIsolatedWebSocket = testFrame.contentWindow.WebSocket;
`;
      await fs.writeFile(start, source.replace(anchor, setup + anchor));
    }
    if (process.argv.includes('--test-post')) {
      const start = path.join(copied, 'gecko-lab/start.mjs');
      let source = await fs.readFile(start, 'utf8');
      const marker = '    await gecko.init();';
      if (source.indexOf(marker) < 0 || source.indexOf(marker) !== source.lastIndexOf(marker)) throw Error('Unexpected Gecko init.');
      source = source.replace(marker, marker + '\n    window.__testGecko = gecko;' + (livePreview && isolated ? '\n    window.__testEncryptedProfile = encryptedHandle.live;' : ''));
      await fs.writeFile(start, source);
    }
    if (failSave) {
      const start = path.join(copied, 'gecko-lab/start.mjs');
      const source = await fs.readFile(start, 'utf8'), marker = '    await gecko.init();';
      if (source.indexOf(marker) < 0 || source.indexOf(marker) !== source.lastIndexOf(marker)) throw Error('Unexpected Gecko init.');
      await fs.writeFile(start, source.replace(marker, marker + "\n    { const evalOriginal = gecko.evalChrome.bind(gecko); gecko.evalChrome = command => command === 'outpost:session-cookie-save' ? Promise.resolve('synthetic-failure') : evalOriginal(command); }"));
    }
    if (failTabs) {
      const start = path.join(copied, 'gecko-lab/start.mjs');
      const source = await fs.readFile(start, 'utf8'), marker = '() => writeBrowserSession(session)';
      if (source.indexOf(marker) < 0 || source.indexOf(marker) !== source.lastIndexOf(marker)) throw Error('Unexpected tab persistence.');
      await fs.writeFile(start, source.replace(marker, "() => Promise.reject(Error('synthetic tab save failure'))"));
    }
    if (isolated && process.argv.includes('--test-restart')) {
      const glue = path.join(copied, 'gecko-lab/engine/engine-glue.js');
      const source = await fs.readFile(glue, 'utf8'), marker = 'function _wisp_open(id) {';
      if (source.indexOf(marker) < 0 || source.indexOf(marker) !== source.lastIndexOf(marker)) throw Error('Unexpected Wisp open.');
      await fs.writeFile(glue, source.replace(marker, "Module.__testWispState = () => ({ exists: !!WISP.conn, ready: !!WISP.conn?.ready, pending: WISP.conn?.pending?.length ?? 0, socket: WISP.conn?.client?.ws?.readyState ?? null });\n" + marker));
    }
    const context = await chromium.launchPersistentContext(path.join(temp, variant + '-profile'), {
      ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
      headless: true, viewport: { width: 1100, height: 800 }, ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', ...(denyBadCertificate ? [] : ['--allow-insecure-localhost'])]
    });
    contexts.push(context);
    await context.addCookies([{ name: 'relay_host_canary', value: 'synthetic-only', url: 'https://127.0.0.1/', secure: true, sameSite: 'None' }]);
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: copied }); await cdp.detach();
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    if (forceUnsupported) await page.addInitScript(() => {
      Object.defineProperty(HTMLIFrameElement.prototype, 'credentialless', { configurable: true, get: () => false, set: () => {} });
    });
    if (failRelaySave) await page.addInitScript(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'outpost-relay-restart-url') throw Error('synthetic relay setting save failure');
        return set.call(this, key, value);
      };
    });
    const requestsBeforePage = requests.length;
    await page.goto('chrome-extension://' + id + '/gecko-lab/index.html' + (missingRelay ? '#relay-restart' : ''));
    if (missingRelay) {
      await page.locator('#start-error').waitFor({ state: 'visible', timeout: 30000 });
      assert.match(await page.locator('#start-error').textContent(), /relay settings could not be restored/i);
      assert.equal(await page.locator('#address').isDisabled(), true);
      await page.waitForTimeout(1000);
      assert.equal(requests.length, requestsBeforePage, 'missing relay settings must not silently use another relay');
      await context.close();
      return { missingRelayFailedClosed: true };
    }
    await page.locator('#welcome details').first().locator('summary').click();
    await page.locator('#relay-url').fill(fallback ? relay + 'fallback/' : relay);
    if (livePreview && isolated) {
      await page.locator('#live-mode').selectOption('create');
      await page.locator('#live-passphrase').fill('synthetic long live passphrase');
      await page.locator('#live-confirm').fill('synthetic long live passphrase');
    }
    const count = requests.length, tlsErrorCount = tlsErrors, v2Count = rejectedV2;
    await page.locator('#start').click();
    await page.waitForFunction(() => !document.querySelector('#address').disabled || !document.querySelector('#start-error').hidden, null, { timeout: 180000 });
    if (forceUnsupported) {
      assert.match(await page.locator('#start-error').textContent(), /cannot isolate relay cookies/i);
      assert.equal(requests.length, count, 'unsupported isolation must not open a relay socket');
      await context.close();
      return true;
    }
    assert.equal(await page.locator('#start-error').isHidden(), true, await page.locator('#start-error').textContent());
    await page.locator('#address').fill('http://relay-fixture.test/');
    await page.locator('#address').press('Enter');
    if (denyBadCertificate) {
      await waitForAsync(async () => tlsErrors > tlsErrorCount, { timeout: 60000 });
      assert.equal(requests.length, count, 'an untrusted relay must not receive a WebSocket handshake');
      await context.close();
      return true;
    }
    await waitForAsync(async () => requests.slice(count).some(record => record.paths.some(p => p.startsWith('GET / HTTP/'))), { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Loaded relay-fixture.test'), null, { timeout: 60000 });
    assert.deepEqual(errors, []);
    if (fallback) {
      assert.ok(rejectedV2 > v2Count, 'the fixture must reject Wisp v2');
      await page.waitForTimeout(2500);
      assert.equal(await page.locator('#relay-recovery').isHidden(), true, 'successful protocol fallback must not report a relay failure');
      await context.close();
      return { v1FallbackWithoutFalseAlert: true };
    }
    const names = (await context.cookies('https://127.0.0.1/')).map(cookie => cookie.name);
    assert.ok(names.includes('relay_host_canary'));
    const sent = requests.slice(count).some(record => /relay_host_canary=synthetic-only/.test(record.cookies));
    const beforeHost = hostRequests.length;
    const hostPage = await context.newPage();
    await hostPage.goto(`https://127.0.0.1:${server.address().port}/`);
    await waitForAsync(async () => hostRequests.length > beforeHost, { timeout: 10000 });
    const responseSentFromHost = hostRequests.slice(beforeHost).some(cookie => /relay_response_canary=synthetic-only/.test(cookie));
    let recoveredAfterDisconnect = null, syntheticPostCount = null, sessionRestoredAfterRestart = null;
    if (process.argv.includes('--test-recovery')) {
      const sockets = requests.slice(count).map(record => record.socket).filter(socket => socket.readyState === 1);
      assert.ok(sockets.length, 'a relay socket must be open before the interruption');
      if (process.argv.includes('--test-post')) {
        const closed = Promise.all(sockets.map(socket => new Promise(resolve => socket.once('close', resolve))));
        await page.evaluate(() => window.__testGecko.evalChrome("fetch('/synthetic-submit',{method:'POST',body:'synthetic-only'}).catch(()=>{}); 'started'"));
        await waitForAsync(async () => requests.slice(count).some(record => record.paths.some(p => p.startsWith('POST /synthetic-submit HTTP/'))), { timeout: 30000 });
        await closed;
      } else {
        await Promise.all(sockets.map(socket => new Promise(resolve => {
          socket.once('close', resolve); socket.close(1011, 'synthetic interruption');
        })));
      }
      await page.waitForTimeout(1000);
      if (isolated && process.argv.includes('--test-restart')) {
        await page.locator('#relay-recovery').waitFor({ state: 'visible', timeout: 15000 });
        assert.match(await page.locator('#relay-recovery').innerText(), /may have completed/i);
        const beforeRestart = requests.length;
        if (failSave || failTabs || failRelaySave) {
          const timeOrigin = await page.evaluate(() => performance.timeOrigin);
          await page.locator('#restart-relay').click();
          const expected = failRelaySave ? 'synthetic relay setting save failure' : failTabs ? 'Could not save open tabs' : 'Could not save session logins';
          await page.waitForFunction(expected => document.querySelector('#status').textContent.includes(expected), expected, { timeout: 30000 });
          assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin, 'a failed save must not reload the page');
          assert.equal(await page.locator('#restart-relay').isEnabled(), true);
          assert.equal(requests.length, beforeRestart, 'a failed save must not reconnect');
          assert.equal(requests.slice(count).flatMap(record => record.paths).filter(p => p.startsWith('POST /synthetic-submit HTTP/')).length, 1);
          assert.equal(await page.evaluate(async live => live ? Boolean(await window.__testEncryptedProfile.stat('outpost-session-cookies.dat')) : (await import(chrome.runtime.getURL('gecko-lab/profile.mjs'))).hasSessionCookieSnapshot(), livePreview), false, 'a failed save must remove a stale session snapshot');
          await context.close();
          return failRelaySave ? { relaySaveFailurePreservedPage: true } : failTabs ? { tabSaveFailurePreservedPage: true } : { saveFailurePreservedPage: true };
        }
        await Promise.all([page.waitForEvent('load', { timeout: 60000 }), page.locator('#restart-relay').click()]);
        if (livePreview) {
          await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Enter your live profile passphrase'), null, { timeout: 30000 });
          await page.locator('#live-passphrase').fill('synthetic long live passphrase');
          await page.locator('#start').click();
        }
        await page.waitForFunction(() => !document.querySelector('#address').disabled || !document.querySelector('#start-error').hidden, null, { timeout: 180000 });
        assert.equal(await page.locator('#start-error').isHidden(), true, await page.locator('#start-error').textContent());
        assert.match(await page.locator('#status').textContent(), /check the last action/i);
        await page.waitForTimeout(1500);
        assert.equal(requests.length, beforeRestart, 'restart must not automatically open a relay connection or replay a request');
      }
      await page.waitForFunction(() => !document.querySelector('#go').disabled, null, { timeout: 30000 });
      await page.locator('#address').fill('http://relay-fixture.test/after-disconnect');
      await page.locator('#address').press('Enter');
      try {
        await waitForAsync(async () => requests.slice(count).some(record => record.paths.some(p => p.startsWith('GET /after-disconnect HTTP/'))),
          { timeout: isolated && (process.argv.includes('--experimental-reconnect') || process.argv.includes('--test-restart')) ? 15000 : 5000 });
        recoveredAfterDisconnect = true;
      } catch { recoveredAfterDisconnect = false; }
      if (isolated && process.argv.includes('--test-restart')) {
        const sessionBeforeRestart = requests.slice(count).flatMap(record => record.http)
          .some(request => /^POST \/synthetic-submit HTTP/.test(request) && /Cookie:.*guest_session=synthetic-guest-only/i.test(request));
        assert.equal(sessionBeforeRestart, true, 'synthetic guest session must exist before restart');
        if (!recoveredAfterDisconnect) console.error('Restart diagnostic:', JSON.stringify({
          status: await page.locator('#status').textContent(), address: await page.locator('#address').inputValue(),
          connections: requests.slice(count).map(record => ({ paths: record.paths, state: record.socket.readyState })),
          wisp: await page.evaluate(() => window.__testGecko?.mod?.__testWispState?.() || null), errors
        }));
        sessionRestoredAfterRestart = requests.slice(count).flatMap(record => record.http)
          .some(request => /^GET \/after-disconnect HTTP/.test(request) && /Cookie:.*guest_session=synthetic-guest-only/i.test(request));
        assert.equal(sessionRestoredAfterRestart, true, 'saved guest session must survive restart');
      }
      if (process.argv.includes('--test-post')) {
        syntheticPostCount = requests.slice(count).flatMap(record => record.paths).filter(p => p.startsWith('POST /synthetic-submit HTTP/')).length;
      }
    }
    await context.close();
    return { sent, responseListedByCookieApi: names.includes('relay_response_canary'), responseSentFromHost, recoveredAfterDisconnect, syntheticPostCount, sessionRestoredAfterRestart };
  }
  const baseline = await run(false);
  const credentialless = await run(true);
  const unsupportedFailedClosed = hardenedAddon ? await run(true, true) : null;
  const untrustedRelayRejected = hardenedAddon ? await run(true, false, true) : null;
  const saveFailure = process.argv.includes('--test-save-failure') ? await run(true, false, false, true) : null;
  const missingRelay = process.argv.includes('--test-missing-relay') ? await run(true, false, false, false, true) : null;
  const tabSaveFailure = process.argv.includes('--test-tab-save-failure') ? await run(true, false, false, false, false, true) : null;
  const relaySaveFailure = process.argv.includes('--test-relay-save-failure') ? await run(true, false, false, false, false, false, true) : null;
  const protocolFallback = process.argv.includes('--test-fallback') ? await run(true, false, false, false, false, false, false, true) : null;
  assert.equal(baseline.sent, true, 'negative control must demonstrate a matching host cookie');
  assert.equal(credentialless.sent, false, 'isolated socket must not send the host cookie');
  assert.equal(baseline.responseSentFromHost, true, 'negative control must demonstrate a relay response cookie entering the host jar');
  assert.equal(credentialless.responseSentFromHost, false, 'isolated response must not set a host cookie');
  if (process.argv.includes('--test-recovery')) {
    assert.equal(baseline.recoveredAfterDisconnect, false, 'negative control must reproduce the stale relay connection');
    assert.equal(credentialless.recoveredAfterDisconnect, process.argv.includes('--experimental-reconnect') || process.argv.includes('--test-restart'), 'unexpected relay recovery result');
    if (process.argv.includes('--test-post')) {
      assert.equal(baseline.syntheticPostCount, 1, 'baseline must not replay the synthetic POST');
      if (process.argv.includes('--experimental-reconnect')) assert.ok(credentialless.syntheticPostCount > 1, 'negative control must reproduce POST replay');
      else assert.equal(credentialless.syntheticPostCount, 1, 'the interrupted synthetic POST must not be replayed');
    }
  }
  console.log(JSON.stringify({ baseline, credentialless, unsupportedFailedClosed, untrustedRelayRejected, saveFailure, missingRelay, tabSaveFailure, relaySaveFailure, protocolFallback, geckoWispNavigation: true,
    unsafeExperimentalReconnect: process.argv.includes('--experimental-reconnect'), testOnly: true, localhostCertificateException: true }, null, 2));
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  if (wss) await new Promise(resolve => wss.close(resolve));
  if (server) await new Promise(resolve => server.close(resolve));
  if (path.dirname(temp) !== tempRoot || !path.basename(temp).startsWith(tempPrefix)) throw Error('Invalid temporary path');
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
