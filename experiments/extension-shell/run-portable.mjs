// End-to-end synthetic login and encrypted profile transfer in disposable profiles.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import http from 'node:http';
import { createReadStream } from 'node:fs';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const flag = process.argv.indexOf('--addon');
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--addon requires a directory path');
const addon = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(root, '../outpost-extension-preview'));
const profiles = [], contexts = [];
const passphrase = 'Test12!x';
const encryptedLivePreview = process.argv.includes('--encrypted-live-preview');
const livePassphrase = 'synthetic long live profile passphrase';
const profileParent = encryptedLivePreview ? path.resolve(os.tmpdir()) : here;
const profilePrefix = encryptedLivePreview ? 'outpost-live-portable-' : 'temporary-profile-';
const webToExtension = process.argv.includes('--web-to-extension');
let webServer, webOrigin;
async function launch(web = false) {
  const profile = await fs.mkdtemp(path.join(profileParent, profilePrefix));
  profiles.push(profile);
  const context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, viewport: { width: 1100, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  contexts.push(context);
  await context.addCookies([{ name: 'host_canary', value: 'must-not-leak', domain: 'extension-fixture.test', path: '/' }]);
  const requests = [];
  await context.routeWebSocket('wss://wisp.mercurywork.shop/**', socket => {
    const send = (type, id, body) => { const header = Buffer.alloc(5); header[0] = type; header.writeUInt32LE(id, 1); socket.send(Buffer.concat([header, body])); };
    send(3, 0, Buffer.from([128, 0, 0, 0]));
    const partial = new Map(), done = new Set();
    socket.onMessage(data => {
      const packet = Buffer.from(data);
      if (packet.length < 5 || packet[0] !== 2) return;
      const id = packet.readUInt32LE(1);
      if (done.has(id)) return;
      const request = (partial.get(id) || '') + packet.subarray(5).toString('latin1');
      partial.set(id, request);
      if (!request.includes('\r\n\r\n')) return;
      done.add(id);
      const route = request.split('\r\n')[0].split(' ')[1], cookie = /^cookie:\s*(.*)$/im.exec(request)?.[1] || '';
      requests.push({ route, cookie });
      let status, headers, body;
      if (route === '/login') {
        status = '302 Found'; headers = 'Location: /account\r\nSet-Cookie: workspace_session=synthetic; HttpOnly; Path=/\r\n'; body = '';
      } else {
        const signedIn = route === '/account' && cookie.split(/;\s*/).includes('workspace_session=synthetic');
        status = signedIn ? '200 OK' : '401 Unauthorized'; headers = '';
        body = signedIn ? '<!doctype html><title>Synthetic account</title><p>Signed in</p>' : '<!doctype html><title>Signed out</title>';
      }
      const response = `HTTP/1.1 ${status}\r\nContent-Type: text/html; charset=utf-8\r\n${headers}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
      send(2, id, Buffer.from(response)); send(4, id, Buffer.from([1]));
    });
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: addon });
  await cdp.detach();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(web ? webOrigin + '/gecko-lab/index.html' : 'chrome-extension://' + id + '/gecko-lab/index.html');
  return { context, page, requests, errors };
}
async function prepareLive(page, mode = 'open') {
  if (!encryptedLivePreview) return;
  if (await page.locator('#live-mode').count() === 0) return;
  await page.locator('#live-mode').selectOption(mode);
  await page.locator('#live-passphrase').fill(livePassphrase);
  if (mode === 'create') await page.locator('#live-confirm').fill(livePassphrase);
}
async function start(page, mode = 'open') {
  await prepareLive(page, mode);
  await page.locator('#start').click();
  await page.waitForFunction(() => !document.querySelector('#address').disabled || !document.querySelector('#start-error').hidden, null, { timeout: 180000 });
  assert.equal(await page.locator('#start-error').isHidden(), true, await page.locator('#start-error').textContent());
}
async function waitFor(predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Timed out waiting for ' + description);
}
async function assertEncryptedAtRest(page) {
  const clean = await page.evaluate(async () => {
    const request = indexedDB.open('outpost-live-test-preview', 1);
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction('records', 'readonly'), read = tx.objectStore('records').getAll();
    const blobs = await new Promise((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
    db.close();
    for (const blob of blobs) {
      if (!(blob instanceof Blob)) return false;
      const text = new TextDecoder('latin1').decode(await blob.arrayBuffer());
      if (text.includes('workspace_session') || text.includes('extension-fixture.test')) return false;
    }
    const root = await navigator.storage.getDirectory();
    async function scan(dir) {
      for await (const [, handle] of dir.entries()) {
        if (handle.kind === 'directory') { if (await scan(handle)) return true; }
        else { const text = new TextDecoder('latin1').decode(await (await handle.getFile()).arrayBuffer());
          if (text.includes('workspace_session') || text.includes('extension-fixture.test')) return true; }
      }
      return false;
    }
    return !(await scan(root));
  });
  assert.equal(clean, true, 'synthetic profile data must not be plaintext in the extension store');
}
try {
  if (webToExtension) {
    const publicRoot = path.join(root, 'public');
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
    webServer = http.createServer(async (req, res) => {
      try {
        if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405).end();
        const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
        const file = path.resolve(publicRoot, '.' + pathname);
        if (!file.startsWith(publicRoot + path.sep)) return res.writeHead(403).end();
        const info = await fs.stat(file);
        if (!info.isFile()) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
          'Content-Length': info.size, 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' });
        if (req.method === 'HEAD') res.end(); else createReadStream(file).on('error', () => res.destroy()).pipe(res);
      } catch { if (!res.headersSent) res.writeHead(404).end(); else res.destroy(); }
    });
    await new Promise(resolve => webServer.listen(0, '127.0.0.1', resolve));
    webOrigin = 'http://127.0.0.1:' + webServer.address().port;
  }
  const first = await launch(webToExtension);
  await start(first.page, 'create');
  await first.page.locator('#address').fill('http://extension-fixture.test/login');
  await first.page.locator('#address').press('Enter');
  await waitFor(() => first.requests.some(item => item.route === '/account' && item.cookie.includes('workspace_session=synthetic')), 'synthetic login');
  await first.page.waitForFunction(() => !document.querySelector('#go').disabled, null, { timeout: 30000 });
  await first.page.locator('#new-tab').click();
  assert.equal(await first.page.locator('#tabs .browser-tab').count(), 2);
  await first.page.locator('#tabs [aria-current]').first().click();
  await first.page.waitForFunction(() => !document.querySelector('#go').disabled, null, { timeout: 30000 });
  await first.page.locator('#exit-browser').click();
  await first.page.waitForFunction(() => document.querySelector('#status').textContent.includes('Browser closed.') ||
    document.querySelector('#status').textContent.includes('Could not save'), null, { timeout: 60000 });
  assert.match(await first.page.locator('#status').textContent(), /Browser closed\./);
  if (encryptedLivePreview && !webToExtension) {
    await prepareLive(first.page, 'open');
    await first.page.locator('#live-passphrase').fill('wrong synthetic live passphrase');
    await first.page.locator('#start').click();
    await first.page.waitForFunction(() => !document.querySelector('#start-error').hidden, null, { timeout: 30000 });
    assert.match(await first.page.locator('#start-error').textContent(), /Wrong passphrase or damaged/);
    await prepareLive(first.page, 'create');
    await first.page.locator('#start').click();
    await first.page.waitForFunction(() => !document.querySelector('#start-error').hidden, null, { timeout: 30000 });
    assert.match(await first.page.locator('#start-error').textContent(), /already exists/);
    await prepareLive(first.page);
  }
  await first.page.locator('#profile-passphrase').fill(passphrase);
  const [download] = await Promise.all([first.page.waitForEvent('download'), first.page.locator('#export-profile').click()]);
  const encrypted = await fs.readFile(await download.path());
  assert.ok(encrypted.length > 32 && !encrypted.includes(Buffer.from('workspace_session=synthetic')));
  if (encryptedLivePreview && !webToExtension) await assertEncryptedAtRest(first.page);

  const second = await launch();
  await second.page.locator('#profile-options summary').click();
  async function rejectedImport(bytes, password) {
    await second.page.locator('#profile-file').setInputFiles({ name: 'synthetic.outpost', mimeType: 'application/octet-stream', buffer: bytes });
    await second.page.locator('#profile-passphrase').fill(password);
    await prepareLive(second.page, 'create');
    await second.page.locator('#import-profile').click();
    await second.page.waitForFunction(() => !document.querySelector('#profile-passphrase').value &&
      document.querySelector('#status').textContent.includes('Wrong passphrase or damaged workspace'), null, { timeout: 30000 });
  }
  await rejectedImport(encrypted, 'Bad12!xy');
  const damaged = Buffer.from(encrypted); damaged[damaged.length - 1] ^= 1;
  await rejectedImport(damaged, passphrase);
  await second.page.locator('#profile-file').setInputFiles({ name: 'synthetic.outpost', mimeType: 'application/octet-stream', buffer: encrypted });
  await second.page.locator('#profile-passphrase').fill(passphrase);
  await prepareLive(second.page, 'create');
  await second.page.locator('#import-profile').click();
  await second.page.waitForFunction(() => !document.querySelector('#profile-passphrase').value &&
    (document.querySelector('#status').textContent.includes('Profile restored.') ||
    document.querySelector('#status').textContent.includes('Wrong passphrase')), null, { timeout: 30000 });
  assert.match(await second.page.locator('#status').textContent(), /Profile restored\./);
  await start(second.page);
  await waitFor(() => second.requests.some(item => item.route === '/account' && item.cookie.includes('workspace_session=synthetic')), 'restored account');
  assert.equal(await second.page.locator('#tabs .browser-tab').count(), 2, 'both tabs should restore');
  assert.equal(second.requests.some(item => item.route === '/login'), false, 'the restored session must not silently sign in again');
  if (encryptedLivePreview) await assertEncryptedAtRest(second.page);
  if (encryptedLivePreview) {
    await second.page.locator('#exit-browser').click();
    await second.page.waitForFunction(() => document.querySelector('#status').textContent.includes('Browser closed.') || document.querySelector('#status').textContent.includes('Could not save'), null, { timeout: 60000 });
    assert.match(await second.page.locator('#status').textContent(), /Browser closed\./);
    await prepareLive(second.page);
    await second.page.locator('#profile-passphrase').fill(passphrase);
    await Promise.all([second.page.waitForEvent('download'), second.page.locator('#export-clear-profile').click()]);
    assert.equal(await second.page.locator('#confirm-profile-clear').isVisible(), true);
    await prepareLive(second.page);
    await second.page.locator('#live-passphrase').fill('wrong synthetic live passphrase');
    await second.page.locator('#clear-profile').click();
    await second.page.waitForFunction(() => document.querySelector('#status').textContent.includes('Wrong passphrase or damaged'), null, { timeout: 30000 });
    await prepareLive(second.page);
    await second.page.locator('#clear-profile').click();
    await second.page.waitForFunction(() => document.querySelector('#status').textContent.includes('Encrypted profile cleared'), null, { timeout: 30000 });
    await prepareLive(second.page);
    await second.page.locator('#start').click();
    await second.page.waitForFunction(() => !document.querySelector('#start-error').hidden, null, { timeout: 30000 });
    assert.match(await second.page.locator('#start-error').textContent(), /No encrypted profile exists/);
  }
  for (const fixture of [first, second]) {
    assert.ok(fixture.requests.every(item => !item.cookie.includes('host_canary')));
    assert.deepEqual((await fixture.context.cookies('http://extension-fixture.test')).map(cookie => cookie.name), ['host_canary']);
    assert.deepEqual(fixture.errors, []);
  }
  console.log(JSON.stringify({ chrome: first.context.browser().version(), webToExtension, encryptedLivePreview, syntheticLogin: true, encryptedExport: true, wrongPasswordRejected: true, tamperingRejected: true,
    restoredInSeparateProfile: true, restoredTabs: true, hostCookieIsolated: true }, null, 2));
} finally {
  for (const context of contexts) await context.close();
  if (webServer) await new Promise(resolve => webServer.close(resolve));
  for (const profile of profiles) {
    if (path.dirname(profile) !== profileParent || !path.basename(profile).startsWith(profilePrefix)) throw Error('Invalid temporary profile path');
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
