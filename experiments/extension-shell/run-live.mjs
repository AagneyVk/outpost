// Anonymous external smoke test. It uses a disposable copy and synthetic host cookie.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const flag = process.argv.indexOf('--addon');
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--addon requires a directory path');
const addon = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(root, '../outpost-extension-preview'));
const temporary = await fs.mkdtemp(path.join(here, 'temporary-addon-'));
const profile = await fs.mkdtemp(path.join(here, 'temporary-profile-'));
let context;
try {
  const copied = path.join(temporary, 'addon');
  await fs.cp(addon, copied, { recursive: true, errorOnExist: true });
  const script = path.join(copied, 'gecko-lab/start.mjs');
  const original = await fs.readFile(script, 'utf8');
  const marker = '    await gecko.init();';
  if (original.indexOf(marker) < 0 || original.indexOf(marker) !== original.lastIndexOf(marker)) throw Error('Unexpected startup script');
  // Only this disposable copy exposes a diagnostic handle to the test runner.
  await fs.writeFile(script, original.replace(marker, marker + '\n    window.__outpostTestGecko = gecko;'));
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, viewport: { width: 1100, height: 800 }, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging']
  });
  await context.addCookies([{ name: 'host_canary', value: 'must-not-leak', domain: 'example.com', path: '/', secure: true, sameSite: 'None' }]);
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: copied });
  await cdp.detach();
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto('chrome-extension://' + id + '/gecko-lab/index.html');
  await page.locator('#start').click();
  await page.waitForFunction(() => !document.querySelector('#address').disabled || !document.querySelector('#start-error').hidden, null, { timeout: 180000 });
  assert.equal(await page.locator('#start-error').isHidden(), true, await page.locator('#start-error').textContent());
  await page.locator('#address').fill('example.com');
  await page.locator('#address').press('Enter');
  await page.waitForFunction(async () => {
    try { return await window.__outpostTestGecko.evalChrome("String(document.body?.textContent?.includes('documentation examples') || false)") === 'true'; }
    catch { return false; }
  }, null, { timeout: 90000 });
  const guest = JSON.parse(await page.evaluate(async () => window.__outpostTestGecko.evalChrome(
    "JSON.stringify({href:location.href,title:document.title,secure:window.isSecureContext,contentLoaded:document.body?.textContent?.includes('documentation examples') || false})")));
  assert.equal(guest.href, 'https://example.com/');
  assert.equal(guest.title, 'Example Domain');
  assert.equal(guest.secure, true);
  assert.equal(guest.contentLoaded, true);
  const certificateResults = [];
  for (const host of ['expired.badssl.com', 'self-signed.badssl.com', 'wrong.host.badssl.com']) {
    await page.locator('#address').fill('https://' + host + '/');
    await page.locator('#address').press('Enter');
    await page.waitForFunction(expected => {
      const value = document.querySelector('#status').textContent;
      return value.includes(expected) && !value.startsWith('Opening ');
    }, host, { timeout: 45000 });
    const status = await page.locator('#status').textContent();
    const certificatePage = JSON.parse(await page.evaluate(async () => window.__outpostTestGecko.evalChrome(
      "JSON.stringify({href:location.href,documentURI:document.documentURI,title:document.title})")));
    if (status !== 'Gecko could not verify the HTTPS certificate for ' + host + '.' || !certificatePage.documentURI.startsWith('about:certerror?'))
      throw Error('Certificate rejection was not established: ' + JSON.stringify({ host, status, certificatePage }));
    certificateResults.push({ host, status, errorPage: true });
  }
  assert.deepEqual((await context.cookies('https://example.com/')).map(cookie => cookie.name), ['host_canary']);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ chrome: context.browser().version(), exampleHttpsLoaded: true,
    relay: 'wss://wisp.mercurywork.shop/', guest, certificateResults }, null, 2));
} finally {
  if (context) await context.close();
  for (const entry of [temporary, profile]) {
    if (path.dirname(entry) !== here) throw Error('Invalid temporary path');
    await fs.rm(entry, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
