// Native Chrome control for a public practice site; published synthetic login only.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const siteFlag = process.argv.indexOf('--site');
const site = siteFlag < 0 ? 'the-internet' : process.argv[siteFlag + 1];
const fixtures = {
  'the-internet': { origin: 'https://the-internet.herokuapp.com', username: 'tomsmith' },
  expand: { origin: 'https://practice.expandtesting.com', username: 'practice' }
};
if (!Object.hasOwn(fixtures, site)) throw Error('Use --site expand or --site the-internet');
const { origin, username } = fixtures[site];
const browser = await chromium.launch({
  ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
  headless: true
});
const context = await browser.newContext();
const page = await context.newPage();
try {
  await page.goto(origin + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('#username').fill(username);
  await page.locator('#password').fill('SuperSecretPassword!');
  await Promise.all([page.waitForURL('**/secure', { timeout: 60000 }), page.locator('button[type="submit"]').click()]);
  await page.locator('a[href*="/logout"]').waitFor({ timeout: 30000 });
  assert.match(await page.locator('body').innerText(), /you logged into a secure area/i);
  await Promise.all([page.waitForURL('**/login', { timeout: 60000 }), page.locator('a[href*="/logout"]').click()]);
  await page.goto(origin + '/secure', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForURL('**/login', { timeout: 30000 });
  assert.equal(new URL(page.url()).pathname, '/login');
  console.log(JSON.stringify({ chrome: browser.version(), site: origin, realDemoLogin: true, logoutReachedLogin: true,
    protectedPageRejectedAfterLogout: true, syntheticCredentialsOnly: true }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
