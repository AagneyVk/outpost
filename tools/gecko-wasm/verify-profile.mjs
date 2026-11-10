import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://127.0.0.1:3001/';
const customRelay = process.argv[3];
const restoreBase = process.argv[4] ?? base;
const upgradedEngine = process.argv[5];
const baselineEngineName = process.argv[6] ?? 'gecko';
const appEngineName = process.argv[7] ?? 'gecko-input-v1';
const site = 'http://outpost-fixture.test/';
const secret = 'test7!Qz';
const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function fixture(context) {
  const requests = [];
  await context.routeWebSocket(customRelay ?? '**/network/', ws => {
    const streams = new Map();
    function send(type, id, body) {
      const frame = Buffer.alloc(5 + body.length);
      frame[0] = type;
      frame.writeUInt32LE(id, 1);
      body.copy(frame, 5);
      ws.send(frame);
    }
    send(3, 0, Buffer.from([128, 0, 0, 0]));
    ws.onMessage(data => {
      const packet = Buffer.from(data);
      const id = packet.readUInt32LE(1);
      if (packet[0] === 1) streams.set(id, '');
      if (packet[0] !== 2 || !streams.has(id)) return;
      const request = streams.get(id) + packet.subarray(5).toString();
      streams.set(id, request);
      if (!request.includes('\r\n\r\n')) return;
      streams.delete(id);
      const seed = request.startsWith('GET /login ');
      const authenticated = /^Cookie:.*outpost_fixture=portable-session/im.test(request);
      requests.push({ seed, authenticated });
      const color = seed ? '#0bbf75' : authenticated ? '#175de0' : '#dc3248';
      const html = `<body style="background:${color}">OUTPOST profile fixture</body>`;
      const cookie = seed ? 'Set-Cookie: outpost_fixture=portable-session; Path=/; HttpOnly; Max-Age=86400\r\n' : '';
      send(2, id, Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(html)}\r\nConnection: close\r\n${cookie}\r\n${html}`));
      send(4, id, Buffer.from([1]));
    });
  });
  return requests;
}

async function navigate(page, path, color) {
  await page.getByText('Network settings', { exact: true }).click();
  await page.getByLabel('Custom Wisp endpoint').fill(customRelay ?? '');
  await page.locator('#start').click();
  await page.locator('#go:enabled').waitFor();
  const address = page.getByRole('textbox', { name: 'Address' });
  await address.fill(new URL(path, site).href);
  await address.press('Enter');
  await page.waitForFunction(rgb => {
    const canvas = document.querySelector('#surface');
    const pixel = canvas.getContext('2d').getImageData(30, 100, 1, 1).data;
    return rgb.every((value, index) => value === pixel[index]);
  }, color, { timeout: 15000 });
}

try {
  const original = await browser.newContext();
  const initialRequests = await fixture(original);
  if (upgradedEngine) {
    await original.route('**/gecko-lab/start.mjs', async route => {
      const response = await route.fetch();
      const source = (await response.text()).replaceAll(appEngineName, baselineEngineName);
      await route.fulfill({ response, body: source });
    });
  }
  let page = await original.newPage();
  await page.goto(base);
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 20000 });
  await navigate(page, '/login', [11, 191, 117]);
  assert(initialRequests.some(request => request.seed));
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.getByRole('textbox', { name: 'Address' }).fill(site + 'proof');
  await page.getByRole('textbox', { name: 'Address' }).press('Enter');
  await page.getByText('Loaded outpost-fixture.test', { exact: true }).waitFor({ state: 'attached' });
  await page.waitForFunction(async () => {
    const entry = document.querySelector('script[type="module"][src$="/start.mjs"]');
    const { readBrowserSession } = await import(new URL('./profile.mjs', entry.src).href);
    const session = await readBrowserSession();
    return session?.active === 1 && session.tabs[1].position === 0;
  });
  // Allow the persistent cookie write to reach OPFS before closing the engine tab.
  await page.waitForFunction(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('outpost-gecko-lab');
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith('cookies.sqlite') && (await handle.getFile()).size > 0) return true;
    }
    return false;
  });
  await page.close();
  if (upgradedEngine) {
    await original.unroute('**/gecko-lab/start.mjs');
    for (const name of ['gecko.js', 'gecko.wasm.zst']) {
      await original.route('**/gecko-lab/engine/' + name.replace('gecko', appEngineName), route => route.fulfill({
        path: path.resolve(upgradedEngine, name),
        contentType: name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream',
      }));
    }
    page = await original.newPage();
    await page.goto(base);
    await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 20000 });
    if (customRelay) {
      await page.getByText('Network settings', { exact: true }).click();
      await page.getByLabel('Custom Wisp endpoint').fill(customRelay);
    }
    const before = initialRequests.length;
    await page.locator('#start').click();
    await page.getByText('Loaded outpost-fixture.test', { exact: true }).waitFor({ state: 'attached' });
    assert(initialRequests.slice(before).some(request => request.authenticated), 'The upgraded engine must reopen the existing login');
    assert.equal(await page.getByRole('textbox', { name: 'Address' }).inputValue(), site + 'proof');
    await page.close();
  }
  page = await original.newPage();
  await page.goto(base);
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 20000 });
  await page.getByText('Encrypted browser profile', { exact: true }).click();
  await page.locator('#profile-passphrase').fill(secret);
  await page.getByRole('button', { name: 'Show passphrase' }).click();
  assert.equal(await page.locator('#profile-passphrase').getAttribute('type'), 'text');
  await page.getByRole('button', { name: 'Hide passphrase' }).click();
  assert.equal(await page.locator('#profile-passphrase').getAttribute('type'), 'password');
  const pending = page.waitForEvent('download');
  await page.locator('#export-clear-profile').click();
  const download = await pending;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const archive = Buffer.concat(chunks);
  assert(!archive.includes('portable-session'));
  const hasProfile = () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) if (name === 'outpost-gecko-lab') return true;
    return false;
  });
  assert(await hasProfile(), 'Download must leave the profile intact until confirmation');
  await page.locator('#clear-profile').click();
  await page.getByText('OUTPOST browser profiles cleared from this address.', { exact: true }).waitFor();
  assert(!(await hasProfile()), 'Confirmed clear must remove the local profile');
  await original.close();

  const fresh = await browser.newContext();
  const restoredRequests = await fixture(fresh);
  page = await fresh.newPage();
  await page.goto(restoreBase);
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 20000 });
  await page.getByText('Encrypted browser profile', { exact: true }).click();
  await page.locator('#profile-file').setInputFiles({ name: 'test.outpost', mimeType: 'application/octet-stream', buffer: archive });
  await page.locator('#profile-passphrase').fill(secret);
  await page.locator('#import-profile').click();
  await page.getByText('Profile restored. Start the browser to use it.').waitFor();
  if (customRelay) {
    await page.getByText('Network settings', { exact: true }).click();
    await page.getByLabel('Custom Wisp endpoint').fill(customRelay);
  }
  await page.locator('#start').click();
  await page.getByText('Loaded outpost-fixture.test', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await page.getByRole('textbox', { name: 'Address' }).inputValue(), site + 'proof');
  assert.equal(await page.locator('#tabs [aria-current]').count(), 2);
  assert.equal(await page.locator('#tabs [aria-current]').nth(1).getAttribute('aria-current'), 'true');
  assert(restoredRequests.some(request => request.authenticated));
  assert(!restoredRequests.some(request => request.seed));
  await page.getByRole('button', { name: 'History', exact: true }).click();
  assert.equal(await page.locator('#history-list li').count(), 2);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Clear browsing history' }).click();
  await page.locator('#history-list li').first().waitFor({ state: 'detached' });
  await page.reload();
  if (customRelay) {
    await page.getByText('Network settings', { exact: true }).click();
    await page.getByLabel('Custom Wisp endpoint').fill(customRelay);
  }
  await page.locator('#start').click();
  await page.getByText('Loaded outpost-fixture.test', { exact: true }).waitFor({ state: 'attached' });
  await page.getByRole('button', { name: 'History', exact: true }).click();
  assert.equal(await page.locator('#history-list li').count(), 0);
  console.log('PASS: encrypted export reopened two tabs and restored the selected tab’s HttpOnly login.');
} finally {
  await browser.close();
}
