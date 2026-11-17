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
  for (const name of ['public-wss.html', 'public-wss.mjs']) await fs.copyFile(path.join(dir, name), path.join(addon, name));
  await fs.writeFile(path.join(addon, 'manifest.json'), JSON.stringify({ manifest_version: 3,
    name: 'OUTPOST public WSS fixture', version: '0.0.1',
    permissions: ['debugger', 'tabs', 'webRequest', 'declarativeNetRequest', 'declarativeNetRequestFeedback'],
    host_permissions: ['wss://echo.websocket.org/*'] }));
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
  await context.addCookies([{ name: 'host_canary', value: 'synthetic-only', domain: 'echo.websocket.org',
    path: '/', sameSite: 'None', secure: true }]);
  assert.ok((await context.cookies()).some(cookie => cookie.name === 'host_canary'));
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: addon });
  await cdp.detach();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + id + '/public-wss.html');
  await page.waitForFunction(() => !!globalThis.fixtureResult, null, { timeout: 25000 });
  const result = await page.evaluate(() => globalThis.fixtureResult);
  console.log(JSON.stringify({ browser: context.browser().version(), result }, null, 2));
  assert.equal(result.error, undefined);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.textEcho, true);
  assert.equal(result.binaryEcho, true);
  assert.deepEqual(result.matches, ['wss://echo.websocket.org/']);
  assert.equal(result.sentHandshakes.length, 1);
  assert.equal(result.cookieIsolationVerified, false);
  assert.deepEqual(result.remainingRules, []);
} finally {
  if (context) await context.close();
  for (const temporary of [addon, profile]) {
    if (path.dirname(temporary) !== dir) throw Error('Invalid temporary path');
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
