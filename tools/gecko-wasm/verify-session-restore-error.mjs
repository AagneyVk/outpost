import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// Run against a local test-engine-server serving a session-capable engine.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:3002/');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const profile = await root.getDirectoryHandle('outpost-gecko-lab', { create: true });
    const handle = await profile.getFileHandle('outpost-session-cookies.dat', { create: true });
    const writer = await handle.createWritable();
    await writer.write('invalid synthetic snapshot');
    await writer.close();
  });
  await page.locator('#start').click();
  await page.getByText('Could not restore session logins. Your saved profile has not been removed.').first()
    .waitFor({ timeout: 180000 });
  assert.equal(await page.locator('#start-error').isVisible(), true);
  assert.equal(await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const profile = await root.getDirectoryHandle('outpost-gecko-lab');
    const handle = await profile.getFileHandle('outpost-session-cookies.dat');
    return (await handle.getFile()).text();
  }), 'invalid synthetic snapshot');
  console.log('PASS: malformed session snapshot blocks startup and remains available for recovery');
} finally {
  await browser.close();
}
