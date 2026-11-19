// Disposable local fixture. The research provider is injected into a test copy,
// not into the user-facing extension. Uses synthetic cookies and mocked Wisp.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { waitForAsync } from '../../tools/wait-for-async.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const flag = process.argv.indexOf('--addon');
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--addon requires a directory');
const addon = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(root, '../outpost-extension-signin-review'));
const temp = await fs.mkdtemp(path.join(here, 'temporary-memory-'));
let context;
try {
  const copy = path.join(temp, 'addon');
  await fs.cp(addon, copy, { recursive: true });
  await fs.copyFile(path.join(here, 'memory-profile.mjs'), path.join(copy, 'gecko-lab/memory-profile.mjs'));
  await fs.copyFile(path.join(here, 'archive.mjs'), path.join(copy, 'gecko-lab/archive.mjs'));
  const start = path.join(copy, 'gecko-lab/start.mjs');
  let script = await fs.readFile(start, 'utf8');
  function replaceOnce(before, after) {
    const index = script.indexOf(before);
    if (index < 0 || index !== script.lastIndexOf(before)) throw Error('Unexpected test addon script.');
    script = script.slice(0, index) + after + script.slice(index + before.length);
  }
  script = "import { MemoryProfile } from './memory-profile.mjs';\nimport { unsealMemoryProfile } from './archive.mjs';\n" + script;
  replaceOnce('    gecko = new Gecko({', "    const testMemoryProfile = window.__testArchive ? await unsealMemoryProfile(new Blob([window.__testArchive]), (await import('/portable.js')).unseal, 'synthetic longer passphrase', 'a'.repeat(64)) : new MemoryProfile();\n    window.__testMemoryProfile = testMemoryProfile;\n    gecko = new Gecko({");
  replaceOnce('      profile: profileName(),', '      profile: testMemoryProfile,');
  replaceOnce('    await gecko.init();', '    await gecko.init();\n    window.__testGecko = gecko;');
  replaceOnce("    if (await hasSessionCookieSnapshot()) {", "    if (await testMemoryProfile.stat('outpost-session-cookies.dat')) {\n      if (await gecko.evalChrome('outpost:session-cookie-restore') !== 'ok') throw Error('Test snapshot restore failed');\n      await testMemoryProfile.unlink('outpost-session-cookies.dat');\n    }\n    if (await hasSessionCookieSnapshot()) {");
  await fs.writeFile(start, script);
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, viewport: { width: 1100, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  await context.addCookies([{ name: 'host_canary', value: 'synthetic-host-only', domain: 'memory-fixture.test', path: '/' }]);
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: copy });
  await cdp.detach();
  const requests = [];
  async function installRelay(target) { await target.routeWebSocket('wss://wisp.mercurywork.shop/**', socket => {
    const send = (type, streamId, payload) => {
      const header = Buffer.alloc(5); header[0] = type; header.writeUInt32LE(streamId, 1);
      socket.send(Buffer.concat([header, payload]));
    };
    send(3, 0, Buffer.from([128, 0, 0, 0]));
    const input = new Map(), responded = new Set();
    socket.onMessage(data => {
      const packet = Buffer.from(data);
      if (packet.length < 5 || packet[0] !== 2) return;
      const stream = packet.readUInt32LE(1);
      if (responded.has(stream)) return;
      const request = (input.get(stream) || '') + packet.subarray(5).toString('latin1');
      input.set(stream, request);
      if (!request.includes('\r\n\r\n')) return;
      responded.add(stream); requests.push(request);
      const body = '<!doctype html><title>Memory fixture</title><h1>Memory fixture</h1>';
      const cookie = requests.length === 1 ? 'Set-Cookie: memory_session=SYNTHETIC_MEMORY_SECRET; Path=/; HttpOnly\r\n' :
        /^GET \/logout HTTP/.test(request) ? 'Set-Cookie: memory_session=; Path=/; Max-Age=0; HttpOnly\r\n' : '';
      send(2, stream, Buffer.from(`HTTP/1.1 200 OK\r\n${cookie}Content-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
      send(4, stream, Buffer.from([1]));
    });
  }); }
  await installRelay(context);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto('chrome-extension://' + id + '/gecko-lab/index.html');
  await page.locator('#start').click();
  await page.waitForFunction(() => !document.querySelector('#address').disabled || !document.querySelector('#start-error').hidden, null, { timeout: 180000 });
  assert.equal(await page.locator('#start-error').isHidden(), true, await page.locator('#start-error').textContent());
  async function navigate(url) {
    await page.locator('#address').fill(url); await page.locator('#address').press('Enter');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Loaded memory-fixture.test'), null, { timeout: 60000 });
  }
  await navigate('http://memory-fixture.test/first');
  await waitForAsync(async () => requests.length >= 1, { timeout: 60000 });
  await navigate('http://memory-fixture.test/second');
  await waitForAsync(async () => requests.some(request => /^GET \/second HTTP/.test(request)), { timeout: 60000 });
  assert.ok(requests.some(request => /^GET \/second HTTP/.test(request) && /Cookie:.*memory_session=SYNTHETIC_MEMORY_SECRET/i.test(request)));
  assert.equal(await page.evaluate(() => window.__testGecko.evalChrome('outpost:session-cookie-save')), 'ok');
  const memorySnapshot = await page.evaluate(async () => {
    const bytes = await window.__testMemoryProfile.readFile('outpost-session-cookies.dat');
    return new TextDecoder().decode(bytes).includes(btoa('SYNTHETIC_MEMORY_SECRET'));
  });
  assert.equal(memorySnapshot, true, 'session snapshot must live in the memory provider');
  const encrypted = Buffer.from(await page.evaluate(async () => {
    const { sealMemoryProfile } = await import('./archive.mjs');
    const { seal } = await import('/portable.js');
    const blob = await sealMemoryProfile(window.__testMemoryProfile, seal, 'synthetic longer passphrase', 'a'.repeat(64));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }));
  assert.equal(encrypted.includes(Buffer.from('SYNTHETIC_MEMORY_SECRET')), false);
  async function scanOpfs(target) { return target.evaluate(async () => {
    const marker = 'SYNTHETIC_MEMORY_SECRET', encoded = btoa(marker), root = await navigator.storage.getDirectory();
    async function scan(dir) {
      for await (const [, handle] of dir.entries()) {
        if (handle.kind === 'directory') { if (await scan(handle)) return true; }
        else { const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
          const text = new TextDecoder('latin1').decode(bytes); if (text.includes(marker) || text.includes(encoded)) return true; }
      }
      return false;
    }
    return scan(root);
  }); }
  assert.equal(await scanOpfs(page), false, 'synthetic marker must not be present in extension OPFS');
  assert.deepEqual(errors, []);
  await context.close(); context = null;
  context = await chromium.launchPersistentContext(path.join(temp, 'restored-profile'), {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, viewport: { width: 1100, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  await context.addCookies([{ name: 'host_canary', value: 'synthetic-host-only', domain: 'memory-fixture.test', path: '/' }]);
  const restoredCdp = await context.browser().newBrowserCDPSession();
  const { id: restoredId } = await restoredCdp.send('Extensions.loadUnpacked', { path: copy });
  await restoredCdp.detach(); await installRelay(context);
  const restored = await context.newPage();
  await restored.addInitScript(bytes => { window.__testArchive = new Uint8Array(bytes); }, [...encrypted]);
  await restored.goto('chrome-extension://' + restoredId + '/gecko-lab/index.html');
  await restored.locator('#start').click();
  await restored.waitForFunction(() => !document.querySelector('#address').disabled || !document.querySelector('#start-error').hidden, null, { timeout: 180000 });
  assert.equal(await restored.locator('#start-error').isHidden(), true, await restored.locator('#start-error').textContent());
  await restored.locator('#address').fill('http://memory-fixture.test/restored');
  await restored.locator('#address').press('Enter');
  await waitForAsync(async () => requests.some(request => /^GET \/restored HTTP/.test(request)), { timeout: 60000 });
  assert.ok(requests.some(request => /^GET \/restored HTTP/.test(request) && /Cookie:.*memory_session=SYNTHETIC_MEMORY_SECRET/i.test(request)), 'restored Gecko must send the synthetic session cookie');
  await restored.waitForFunction(() => !document.querySelector('#go').disabled, null, { timeout: 60000 });
  await restored.locator('#address').fill('http://memory-fixture.test/logout');
  await restored.locator('#address').press('Enter');
  await waitForAsync(async () => requests.some(request => /^GET \/logout HTTP/.test(request)), { timeout: 60000 });
  await restored.waitForFunction(() => !document.querySelector('#go').disabled, null, { timeout: 60000 });
  await restored.locator('#address').fill('http://memory-fixture.test/after-logout');
  await restored.locator('#address').press('Enter');
  await waitForAsync(async () => requests.some(request => /^GET \/after-logout HTTP/.test(request)), { timeout: 60000 });
  assert.ok(requests.some(request => /^GET \/after-logout HTTP/.test(request) && !/memory_session=/i.test(request)), 'logout must remove the synthetic session cookie');
  assert.ok(requests.every(request => !/host_canary/i.test(request)), 'host cookies must not enter Gecko requests');
  assert.deepEqual((await context.cookies('http://memory-fixture.test')).map(cookie => cookie.name), ['host_canary']);
  assert.equal(await scanOpfs(restored), false, 'restored synthetic marker must not be present in extension OPFS');
  console.log(JSON.stringify({ chrome: context.browser().version(), syntheticSessionWorks: true,
    geckoSnapshotInMemory: true, encryptedTransferToFreshChromeProfile: true, syntheticLogout: true, markerAbsentFromBothExtensionOpfs: true, hostCanaryNotSent: true,
    testOnly: true, coversOtherHostStorageOrMemory: false }, null, 2));
} finally {
  if (context) await context.close();
  if (path.dirname(temp) !== here || !path.basename(temp).startsWith('temporary-memory-')) throw Error('Invalid temporary path');
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
