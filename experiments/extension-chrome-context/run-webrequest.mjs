import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const dir = path.dirname(fileURLToPath(import.meta.url));
const addon = await fs.mkdtemp(path.join(dir, 'temporary-addon-'));
const profile = await fs.mkdtemp(path.join(dir, 'temporary-profile-'));
let context;
try {
  for (const name of ['webrequest.html', 'webrequest.mjs'])
    await fs.copyFile(path.join(dir, name), path.join(addon, name));
  await fs.writeFile(path.join(addon, 'manifest.json'), JSON.stringify({ manifest_version: 3,
    name: 'OUTPOST request-specific HTTPS capability test', version: '0.0.1',
    permissions: ['webRequest'], host_permissions: ['https://example.com/*'] }));
  const args = ['--enable-unsafe-extension-debugging'];
  if (process.env.OUTPOST_ENABLE_SECURITY_INFO === '1') args.push('--enable-features=WebRequestSecurityInfo');
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: addon });
  await cdp.detach();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + id + '/webrequest.html');
  await page.waitForFunction(() => !!globalThis.probeResult, null, { timeout: 30000 });
  const result = await page.evaluate(() => globalThis.probeResult);
  console.log(JSON.stringify({ browser: context.browser().version(), experimentalFlag: process.env.OUTPOST_ENABLE_SECURITY_INFO === '1', result }, null, 2));
  assert.equal(result.fetch.status, 200);
  assert.equal(result.controlEvents.length, 1, 'control listener must observe the same request');
  if (process.env.OUTPOST_ENABLE_SECURITY_INFO === '1') {
    assert.equal(result.registration, 'ok');
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].requestId, result.controlEvents[0].requestId);
    assert.equal(result.events[0].state, 'secure');
    assert.ok(result.events[0].certs[0].derLength > 0);
    assert.equal(result.events[0].certs[0].computedFingerprint,
      result.events[0].certs[0].fingerprint.replace(/:/g, '').toUpperCase());
  }
} finally {
  if (context) await context.close();
  for (const temporary of [addon, profile]) {
    if (path.dirname(temporary) !== dir) throw Error('Invalid temporary path');
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
