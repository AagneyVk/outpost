import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const dir = path.dirname(fileURLToPath(import.meta.url));
const addon = await fs.mkdtemp(path.join(dir, 'temporary-addon-'));
const profile = await fs.mkdtemp(path.join(dir, 'temporary-profile-'));
const hosts = ['example.com', 'example.org', 'www.rfc-editor.org', 'www.iana.org', 'www.google.com'];
let context;
try {
  for (const name of ['general-public.html', 'general-public.mjs', 'capture-bytes.mjs']) await fs.copyFile(path.join(dir, name), path.join(addon, name));
  await fs.copyFile(path.join(dir, '../extension-chrome-context/response-binding.mjs'), path.join(addon, 'response-binding.mjs'));
  await fs.writeFile(path.join(addon, 'manifest.json'), JSON.stringify({ manifest_version: 3,
    name: 'OUTPOST public request research', version: '0.0.1', permissions: ['debugger', 'tabs'],
    host_permissions: hosts.map(host => 'https://' + host + '/*') }));
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  await context.addCookies(hosts.map(domain => ({ name: 'host_canary', value: 'must-not-leak', domain, path: '/', secure: true, sameSite: 'None' })));
  for (const host of hosts) assert.ok((await context.cookies('https://' + host)).some(cookie => cookie.name === 'host_canary'));
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: addon });
  await cdp.detach();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + id + '/general-public.html');
  await page.waitForFunction(() => !!globalThis.fixtureResult, null, { timeout: 60000 });
  const result = await page.evaluate(() => globalThis.fixtureResult);
  console.log(JSON.stringify({ chrome: context.browser().version(), ...result }, null, 2));
  assert.equal(result.fatal, undefined);
  assert.deepEqual(result.errors, []);
  assert.equal(result.results.length, hosts.length);
  for (const item of result.results) {
    assert.equal(item.error, undefined, item.url + ': ' + item.error);
    assert.equal(item.status, 200);
    assert.ok(item.size > 0);
    assert.equal(item.hostCookieSent, false);
    assert.equal(item.privateMarkerSent, false);
  }
  assert.match(result.results[0].contentType, /text\/html/i);
  assert.match(result.results[2].contentType, /text\/plain/i);
  assert.match(result.results[3].contentType, /image\/svg\+xml/i);
  assert.match(result.results[4].contentType, /image\/png/i);
  assert.equal(result.results[4].pngSignature, true);
  for (const host of hosts) assert.deepEqual((await context.cookies('https://' + host)).map(cookie => cookie.name), ['host_canary']);
} finally {
  if (context) await context.close();
  for (const temporary of [addon, profile]) {
    if (path.dirname(temporary) !== dir) throw Error('Invalid temporary path');
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
