import { chromium } from 'playwright-core';

const lab = new URL(process.argv[2] ?? 'http://127.0.0.1:3001/gecko-lab/index.html');
const target = new URL(process.argv[3] ?? 'https://example.com/');
if (target.protocol !== 'https:' || target.username || target.password) {
  throw new Error('Provide a public HTTPS test URL without credentials.');
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const username = process.env.OUTPOST_PREVIEW_USER;
  const password = process.env.OUTPOST_PREVIEW_PASSWORD;
  const context = await browser.newContext({
    httpCredentials: username && password ? { username, password, origin: lab.origin } : undefined,
  });
  const page = await context.newPage();
  await page.goto(lab.href);
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 20000 });
  await page.getByRole('button', { name: 'Start browser' }).click();
  const address = page.getByRole('textbox', { name: 'Address' });
  await address.fill(target.href, { timeout: 60000 });
  await address.press('Enter');
  const status = page.locator('#status');
  await page.waitForFunction(() => !document.querySelector('#go').disabled, null, { timeout: 25000 });
  const result = await status.textContent();
  if (result !== 'Loaded ' + target.hostname) throw new Error(result);
  console.log('PASS: Gecko loaded ' + target.origin + ' with certificate verification enabled.');
} finally {
  await browser.close();
}
