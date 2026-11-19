import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const flag = process.argv.indexOf('--addon');
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--addon requires a directory path');
const addon = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(root, '../outpost-extension-preview'));
const manifest = JSON.parse(await fs.readFile(path.join(addon, 'manifest.json'), 'utf8'));
const linuxIncluded = await fs.access(path.join(addon, 'build.json')).then(() => true, () => false);
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.permissions, undefined);
assert.equal(manifest.host_permissions, undefined);
assert.equal(manifest.externally_connectable, undefined);
assert.equal(manifest.web_accessible_resources, undefined);
const profile = await fs.mkdtemp(path.join(here, 'temporary-profile-'));
const relayRequests = [];
let context, attackerServer;
try {
  attackerServer = http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Attacker</title>'));
  await new Promise(resolve => attackerServer.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, viewport: { width: 1100, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  await context.addCookies([{ name: 'host_canary', value: 'must-not-leak', domain: 'extension-fixture.test', path: '/' }]);
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: addon });
  await cdp.detach();
  await context.routeWebSocket('wss://wisp.mercurywork.shop/**', socket => {
    const send = (type, streamId, payload) => {
      const header = Buffer.alloc(5); header[0] = type; header.writeUInt32LE(streamId, 1);
      socket.send(Buffer.concat([header, payload]));
    };
    send(3, 0, Buffer.from([128, 0, 0, 0]));
    const input = new Map(), responded = new Set();
    socket.onMessage(data => {
      const packet = Buffer.from(data);
      if (packet.length < 5 || packet[0] !== 2) return;
      const streamId = packet.readUInt32LE(1);
      if (responded.has(streamId)) return;
      const request = (input.get(streamId) || '') + packet.subarray(5).toString('latin1');
      input.set(streamId, request);
      if (!request.includes('\r\n\r\n')) return;
      responded.add(streamId);
      relayRequests.push(request);
      const body = '<!doctype html><title>OUTPOST extension fixture</title><body><h1>Extension navigation works</h1></body>';
      send(2, streamId, Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
      send(4, streamId, Buffer.from([1]));
    });
  });
  const page = await context.newPage();
  const pageErrors = [], diagnostics = [], sensitiveConsoleEntries = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') diagnostics.push(message.text().slice(0, 500));
    if (message.text().includes('synthetic-private-query-marker')) sensitiveConsoleEntries.push(message.type());
  });
  page.on('requestfailed', request => diagnostics.push(request.url() + ': ' + (request.failure()?.errorText || 'failed')));
  await page.goto('chrome-extension://' + id + '/gecko-lab/index.html');
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.match(await page.locator('#welcome').innerText(), /browsing uses the selected Wisp relay/i);
  assert.match(await page.locator('#welcome').innerText(), linuxIncluded ? /Linux terminal is an offline preview/i : /Linux workspace is not included/i);
  assert.equal(await page.locator('#relay-url').inputValue(), 'wss://wisp.mercurywork.shop/');
  await page.getByText('Network settings', { exact: true }).click();
  await page.locator('#relay-url').fill('');
  await page.locator('#start').click();
  await page.waitForFunction(() => !document.querySelector('#address').disabled || !document.querySelector('#start-error').hidden, null, { timeout: 180000 });
  assert.equal(await page.locator('#start-error').isHidden(), true, JSON.stringify({ message: await page.locator('#start-error').textContent(), diagnostics }));
  await page.locator('#address').fill('http://extension-fixture.test/?synthetic-private-query-marker');
  await page.locator('#address').press('Enter');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Loaded extension-fixture.test'), null, { timeout: 60000 });
  assert.ok(relayRequests.some(request => /^GET \/\?synthetic-private-query-marker HTTP\/1\.[01]/.test(request)), 'Gecko must send its request through the mocked relay');
  assert.equal(await page.locator('#relay-recovery').isHidden(), true, 'a working relay must not report disconnection');
  assert.ok(relayRequests.every(request => !/host_canary/i.test(request)), 'host-browser cookie must not enter guest requests');
  await page.locator('#new-tab').click();
  assert.equal(await page.locator('#tabs .browser-tab').count(), 2);
  assert.equal(await page.locator('#address').inputValue(), '');
  await page.locator('#address').fill('http://second-fixture.test/');
  await page.locator('#address').press('Enter');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Loaded second-fixture.test'), null, { timeout: 60000 });
  await page.locator('#tabs [aria-current]').first().click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Loaded extension-fixture.test'), null, { timeout: 60000 });
  await page.locator('#history').click();
  assert.match(await page.locator('#history-list').innerText(), /extension-fixture\.test/);
  await page.locator('#history-dialog button').last().click();
  const [files] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: 'Files', exact: true }).click()]);
  await files.waitForLoadState('domcontentloaded');
  await files.locator('#upload').setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic file') });
  await files.getByRole('button', { name: /synthetic\.txt/ }).waitFor({ timeout: 15000 });
  const [download] = await Promise.all([files.waitForEvent('download'), files.getByRole('button', { name: /synthetic\.txt/ }).click()]);
  assert.equal(await fs.readFile(await download.path(), 'utf8'), 'synthetic file');
  const attacker = await context.newPage();
  await attacker.goto('http://127.0.0.1:' + attackerServer.address().port + '/');
  assert.equal(await attacker.evaluate(async extensionId => {
    try { await fetch('chrome-extension://' + extensionId + '/gecko-lab/index.html'); return 'readable'; }
    catch { return 'rejected'; }
  }, id), 'rejected');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(sensitiveConsoleEntries, [], 'navigation query values must not appear in browser console output');
  assert.deepEqual((await context.cookies('http://extension-fixture.test')).map(cookie => cookie.name), ['host_canary']);
  console.log(JSON.stringify({ chrome: context.browser().version(), extensionStarted: true, relayNavigation: true,
    tabs: true, history: true, fileRoundTrip: true, hostCookieIsolated: true, externalReadRejected: true, navigationQueryNotLogged: true }, null, 2));
} finally {
  if (context) await context.close();
  if (attackerServer) await new Promise(resolve => attackerServer.close(resolve));
  if (path.dirname(profile) !== here) throw Error('Invalid temporary profile path');
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
