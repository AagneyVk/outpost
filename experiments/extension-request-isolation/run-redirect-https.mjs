import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import http from 'node:http';
const dir = path.dirname(fileURLToPath(import.meta.url));
const addon = await fs.mkdtemp(path.join(dir, 'temporary-addon-'));
const profile = await fs.mkdtemp(path.join(dir, 'temporary-profile-'));
let context;
let server, destinationServer;
const gate = process.env.OUTPOST_REDIRECT_GATE === '1';
const local = process.env.OUTPOST_REDIRECT_LOCAL === '1';
if (local && !gate) throw Error('Local redirect test requires gate mode');
try {
  for (const name of ['redirect-https.html', 'redirect-https.mjs', 'redirect-binding.mjs']) await fs.copyFile(path.join(dir, name), path.join(addon, name));
  await fs.writeFile(path.join(addon, 'manifest.json'), JSON.stringify({ manifest_version: 3,
    name: 'OUTPOST HTTPS redirect security probe', version: '0.0.1', permissions: ['debugger', 'tabs'],
    host_permissions: ['https://practice.expandtesting.com/*', ...(local ? ['http://127.0.0.1/*'] : [])] }));
  const observed = { start: 0, destination: 0, body: '' };
  if (local) {
    destinationServer = http.createServer((_req, res) => { observed.destination++; res.end('unexpected'); });
    await new Promise(resolve => destinationServer.listen(0, '127.0.0.1', resolve));
    server = http.createServer((req, res) => {
      if (req.url !== '/start') return res.writeHead(404).end();
      observed.start++;
      req.on('data', chunk => { observed.body += chunk; });
      req.on('end', () => res.writeHead(307, { Location: 'http://127.0.0.1:' + destinationServer.address().port + '/destination' }).end());
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: addon });
  await cdp.detach();
  const page = await context.newPage();
  const query = new URLSearchParams({ ...(gate ? { gate: '1' } : {}),
    ...(local ? { local: 'http://127.0.0.1:' + server.address().port + '/start' } : {}) });
  await page.goto('chrome-extension://' + id + '/redirect-https.html?' + query);
  await page.waitForFunction(() => !!globalThis.fixtureResult, null, { timeout: 30000 });
  const result = await page.evaluate(() => globalThis.fixtureResult);
  console.log(JSON.stringify({ browser: context.browser().version(), result, ...(local ? { observed } : {}) }, null, 2));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.commandErrors, []);
  assert.equal(result.requestCount, 1);
  assert.equal(result.events[0].extra.status, local ? 307 : 302);
  if (gate) {
    assert.equal(result.type, 'TypeError');
    assert.equal(result.blocked.length, 1);
    assert.deepEqual(result.blockResults, [{ url: result.blocked[0], networkId: result.events[0].id, ok: true }]);
    assert.equal(result.redirects.length, 1);
    assert.equal(result.redirects[0].id, result.events[0].id);
    assert.equal(result.redirects[0].from, local ? 'http://127.0.0.1:' + server.address().port + '/start' : 'https://practice.expandtesting.com/secure');
    assert.equal(result.redirects[0].status, local ? 307 : 302);
    if (local) {
      assert.equal(result.redirects[0].nextMethod, 'POST');
      assert.equal(result.bindingError, 'Verified HTTPS URL required');
      assert.deepEqual(observed, { start: 1, destination: 0, body: 'synthetic=not-secret' });
    } else {
      assert.equal(result.redirects[0].securityState, 'secure');
      assert.equal(result.redirects[0].hasSecurityDetails, true);
      assert.equal(result.bindingError, null);
      assert.equal(result.binding.from, 'https://practice.expandtesting.com/secure');
    }
    assert.equal(result.blocked[0], result.redirects[0].to);
  } else {
    assert.equal(result.type, 'opaqueredirect');
    assert.equal(result.events[0].pauses.length, 1);
    assert.equal(result.events[0].pauses[0].status, 302);
    assert.equal(result.events[0].response, null, 'recorded Chrome behavior: no request-bound response security event');
    assert.equal(result.events[0].pauses[0].hasSecurityDetails, false);
  }
} finally {
  if (context) await context.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (destinationServer) await new Promise(resolve => destinationServer.close(resolve));
  for (const temporary of [addon, profile]) {
    if (path.dirname(temporary) !== dir) throw Error('Invalid temporary path');
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
