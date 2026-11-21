// Test-only injected storage failure; disposable Chrome profile and synthetic
// guest session. The real preview is never modified by this script.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { waitForAsync } from '../../tools/wait-for-async.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const flag = process.argv.indexOf('--addon');
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--addon requires a directory');
const addon = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(root, '../outpost-encrypted-live-preview-4'));
const tempRoot = path.resolve(os.tmpdir()), temp = await fs.mkdtemp(path.join(tempRoot, 'outpost-live-failure-'));
let context;
try {
  const copy = path.join(temp, 'addon'); await fs.cp(addon, copy, { recursive: true });
  const startFile = path.join(copy, 'gecko-lab/start.mjs');
  let source = await fs.readFile(startFile, 'utf8'), marker = '    await gecko.init();';
  if (source.indexOf(marker) < 0 || source.indexOf(marker) !== source.lastIndexOf(marker)) throw Error('Unexpected encrypted preview startup.');
  await fs.writeFile(startFile, source.replace(marker, marker + '\n    window.__testGecko = gecko; window.__testLive = encryptedHandle.live;'));
  const storeFile = path.join(copy, 'gecko-lab/research/encrypted-live-profile/block-store.mjs');
  source = await fs.readFile(storeFile, 'utf8');
  marker = "        tx.onabort = tx.onerror = () => reject(tx.error || Error('Encrypted test store write failed.'));";
  if (source.indexOf(marker) < 0 || source.indexOf(marker) !== source.lastIndexOf(marker)) throw Error('Unexpected encrypted store transaction.');
  await fs.writeFile(storeFile, source.replace(marker, marker + "\n        if (globalThis.__testAbortNext) { globalThis.__testAbortNext = false; tx.abort(); }"));
  const requests = [];
  async function launch() {
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
      ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
      headless: true, viewport: { width: 1100, height: 800 },
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
    });
    await context.routeWebSocket('wss://wisp.mercurywork.shop/**', socket => {
      const send = (type, id, body) => { const head = Buffer.alloc(5); head[0] = type; head.writeUInt32LE(id, 1); socket.send(Buffer.concat([head, body])); };
      send(3, 0, Buffer.from([128, 0, 0, 0]));
      const input = new Map(), done = new Set();
      socket.onMessage(data => {
        const packet = Buffer.from(data); if (packet.length < 5 || packet[0] !== 2) return;
        const id = packet.readUInt32LE(1); if (done.has(id)) return;
        const request = (input.get(id) || '') + packet.subarray(5).toString('latin1'); input.set(id, request);
        if (!request.includes('\r\n\r\n')) return; done.add(id);
        const route = request.split('\r\n')[0].split(' ')[1], cookie = /^cookie:\s*(.*)$/im.exec(request)?.[1] || '';
        requests.push({ route, cookie });
        const login = route === '/login', allowed = route === '/account' && cookie.includes('synthetic_session=fixture');
        const status = login ? '302 Found' : allowed ? '200 OK' : '401 Unauthorized';
        const headers = login ? 'Location: /account\r\nSet-Cookie: synthetic_session=fixture; HttpOnly; Path=/\r\n' : '';
        const body = allowed ? '<!doctype html><title>Synthetic account</title><p>Signed in</p>' : '';
        send(2, id, Buffer.from(`HTTP/1.1 ${status}\r\n${headers}Content-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
        send(4, id, Buffer.from([1]));
      });
    });
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: copy }); await cdp.detach();
    const page = await context.newPage(); await page.goto('chrome-extension://' + id + '/gecko-lab/index.html');
    return page;
  }
  async function start(page, mode) {
    await page.locator('#live-mode').selectOption(mode);
    await page.locator('#live-passphrase').fill('synthetic long profile passphrase');
    if (mode === 'create') await page.locator('#live-confirm').fill('synthetic long profile passphrase');
    await page.locator('#start').click();
    await page.waitForFunction(() => !document.querySelector('#address').disabled || !document.querySelector('#start-error').hidden, null, { timeout: 180000 });
    assert.equal(await page.locator('#start-error').isHidden(), true, await page.locator('#start-error').textContent());
  }
  let page = await launch(); await start(page, 'create');
  await page.locator('#address').fill('http://failure-fixture.test/login'); await page.locator('#address').press('Enter');
  await waitForAsync(async () => requests.some(req => req.route === '/account' && req.cookie.includes('synthetic_session=fixture')), { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#go').disabled, null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.__testGecko.evalChrome('outpost:session-cookie-save')), 'ok');
  await page.evaluate(async () => {
    window.__testAbortNext = true;
    try { await window.__testLive.writeFile('synthetic-failure', new Uint8Array([1])); } catch {}
  });
  await page.locator('#live-fatal').waitFor({ state: 'visible', timeout: 30000 });
  assert.equal(await page.locator('#address').isDisabled(), true);
  await context.close(); context = null;
  page = await launch(); await start(page, 'open');
  await waitForAsync(async () => requests.filter(req => req.route === '/account' && req.cookie.includes('synthetic_session=fixture')).length >= 2, { timeout: 60000 });
  assert.equal(await page.locator('#live-fatal').isHidden(), true);
  console.log(JSON.stringify({ syntheticStorageFailureWarned: true, newNavigationDisabled: true,
    previousEncryptedSessionReopened: true, syntheticDataOnly: true }, null, 2));
} finally {
  if (context) await context.close();
  if (path.dirname(temp) !== tempRoot || !path.basename(temp).startsWith('outpost-live-failure-')) throw Error('Invalid temporary path');
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
