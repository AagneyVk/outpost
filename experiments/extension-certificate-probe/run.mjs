import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const dir = path.dirname(fileURLToPath(import.meta.url));
const profile = await fs.mkdtemp(path.join(dir, 'temporary-profile-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging']
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: dir });
  await cdp.detach();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + id + '/index.html');
  const result = await page.evaluate(() => globalThis.runCertificateProbe());
  console.log(JSON.stringify({ browser: context.browser().version(), result }, null, 2));
  assert.equal(result.valid, 200);
  assert.equal(result.expired, 'TypeError');
  assert.ok(result.events.some(event => event.securityState === 'secure'));
  assert.ok(result.certificateCount > 0);
} finally {
  if (context) await context.close();
  await fs.rm(profile, { recursive: true, force: true });
}
