import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const dir = path.dirname(fileURLToPath(import.meta.url));
const profile = await fs.mkdtemp(path.join(dir, 'temporary-profile-'));
const secondProfile = await fs.mkdtemp(path.join(dir, 'temporary-profile-'));
let context;
try {
  const launch = async profileDir => {
    const instance = await chromium.launchPersistentContext(profileDir, {
      ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
      headless: true, ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging']
    });
    const cdp = await instance.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: dir });
    await cdp.detach();
    const page = await instance.newPage();
    await page.goto('chrome-extension://' + id + '/index.html');
    return { instance, page };
  };
  let opened = await launch(profile);
  context = opened.instance;
  let page = opened.page;
  const result = await page.evaluate(() => globalThis.runDemoLogin());
  const session = result.session;
  delete result.session;
  assert.equal(result.success, true);
  assert.ok(session?.length > 0);
  assert.deepEqual(await context.cookies('https://practice.expandtesting.com'), []);
  await context.close();
  context = undefined;
  opened = await launch(secondProfile);
  context = opened.instance;
  page = opened.page;
  const unauthenticated = await page.evaluate(() => globalThis.runDemoLogin({ restoreOnly: true }));
  assert.equal(unauthenticated.success, false);
  const restored = await page.evaluate(session => globalThis.runDemoLogin({ session, restoreOnly: true }), session);
  assert.equal(restored.success, true);
  assert.deepEqual(await context.cookies('https://practice.expandtesting.com'), []);
  console.log(JSON.stringify({ ...result, unauthenticatedStatus: unauthenticated.secure,
    restoredInFreshProfile: restored.success }, null, 2));
} finally {
  if (context) await context.close();
  await fs.rm(profile, { recursive: true, force: true });
  await fs.rm(secondProfile, { recursive: true, force: true });
}
