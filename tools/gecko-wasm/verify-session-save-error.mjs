import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// Run against a local test-engine-server serving a session-capable engine.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext();
  await context.route('**/gecko-lab/start.mjs', async route => {
    const response = await route.fetch();
    const source = (await response.text()).replace('    await gecko.init();', `
      await gecko.init();
      const evaluate = gecko.evalChrome.bind(gecko);
      gecko.evalChrome = command => command === 'outpost:session-cookie-save'
        ? Promise.resolve('error') : evaluate(command);
    `);
    await route.fulfill({ response, body: source });
  });
  const page = await context.newPage();
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:3002/');
  await page.locator('#start').click();
  await page.locator('#exit-browser:enabled').waitFor({ timeout: 180000 });
  await page.locator('#exit-browser').click();
  await page.getByText('Could not save session logins. Keep the browser open and try again.').waitFor();
  assert.equal(await page.locator('#exit-browser').isEnabled(), true);
  assert.equal(await page.locator('#viewport').isVisible(), true);
  assert.notEqual(new URL(page.url()).hash, '#export-profile');
  console.log('PASS: failed session save keeps the browser open and allows retry');
} finally {
  await browser.close();
}
