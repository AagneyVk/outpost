// Disposable Chrome profile; the bundled guest is offline and uses synthetic files.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { waitForAsync } from '../../tools/wait-for-async.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const flag = process.argv.indexOf('--addon');
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--addon requires a directory path');
const addon = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(root, '../outpost-extension-linux-preview'));
const build = JSON.parse(await fs.readFile(path.join(addon, 'build.json'), 'utf8'));
assert.equal(build.offline, true, 'the packaged Linux demo must be offline');
const profile = await fs.mkdtemp(path.join(here, 'temporary-profile-'));
let context, second, secondProfile;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, viewport: { width: 1200, height: 850 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: addon });
  await cdp.detach();
  const browserPage = await context.newPage();
  await browserPage.goto('chrome-extension://' + id + '/gecko-lab/index.html');
  const terminalLink = browserPage.getByRole('link', { name: 'Terminal', exact: true });
  await terminalLink.waitFor({ state: 'visible', timeout: 30000 });
  const [terminal] = await Promise.all([context.waitForEvent('page'), terminalLink.click()]);
  const errors = [], failures = [], sockets = [];
  terminal.on('pageerror', error => errors.push(String(error)));
  terminal.on('console', message => { if (message.type() === 'error') failures.push(message.text().slice(0, 400)); });
  terminal.on('requestfailed', request => failures.push(request.url() + ': ' + (request.failure()?.errorText || 'failed')));
  terminal.on('websocket', socket => sockets.push(socket.url()));
  try {
    await terminal.waitForFunction(() => {
      const status = document.querySelector('#status')?.textContent || '';
      return status.startsWith('Linux tools running on this computer') || status.startsWith('Workspace could not start');
    }, null, { timeout: 240000 });
    assert.equal(await terminal.locator('#status').textContent(), 'Linux tools running on this computer · Offline');
    const input = terminal.locator('.xterm-helper-textarea');
    await input.waitFor({ state: 'attached', timeout: 30000 });
    await input.focus();
    await terminal.keyboard.type("printf 'synthetic extension file' > /home/outpost/extension-test.txt");
    await terminal.keyboard.press('Enter');
    await waitForAsync(() => terminal.evaluate(async () => {
      try { return new TextDecoder().decode(await window.vm.read_file('/home/outpost/extension-test.txt')) === 'synthetic extension file'; }
      catch { return false; }
    }), { timeout: 45000 });
    await terminal.locator('#files').click();
    await terminal.getByRole('button', { name: /extension-test\.txt/ }).waitFor({ timeout: 45000 });
    const [download] = await Promise.all([terminal.waitForEvent('download'), terminal.getByRole('button', { name: /extension-test\.txt/ }).click()]);
    assert.equal(await fs.readFile(await download.path(), 'utf8'), 'synthetic extension file');
    await terminal.locator('#files-close').click();
    await terminal.locator('#export').click();
    await terminal.locator('#save-passphrase').fill('synthetic-test-passphrase!');
    const [exported] = await Promise.all([
      terminal.waitForEvent('download', { timeout: 300000 }),
      terminal.locator('#password-dialog button[value="save"]').click()
    ]);
    const encrypted = await fs.readFile(await exported.path());
    assert.equal(encrypted.includes(Buffer.from('synthetic extension file')), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(sockets, []);
    const chromeVersion = context.browser().version();
    await context.close(); context = null;

    secondProfile = await fs.mkdtemp(path.join(here, 'temporary-profile-'));
    second = await chromium.launchPersistentContext(secondProfile, {
      ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
      headless: true, viewport: { width: 1200, height: 850 },
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
    });
    const secondCdp = await second.browser().newBrowserCDPSession();
    const { id: secondId } = await secondCdp.send('Extensions.loadUnpacked', { path: addon });
    await secondCdp.detach();
    const restored = await second.newPage();
    const restoreErrors = [], restoreSockets = [];
    restored.on('pageerror', error => restoreErrors.push(String(error)));
    restored.on('websocket', socket => restoreSockets.push(socket.url()));
    await restored.goto('chrome-extension://' + secondId + '/workstation.html?tool=terminal&locked=1');
    await restored.locator('#passphrase').fill('synthetic-test-passphrase!');
    await restored.locator('#import').setInputFiles({ name: 'workspace.outpost', mimeType: 'application/octet-stream', buffer: encrypted });
    await restored.waitForFunction(() => ['Linux tools running on this computer', 'Workspace could not start'].some(text => document.querySelector('#status')?.textContent.startsWith(text)), null, { timeout: 300000 });
    assert.equal(await restored.locator('#status').textContent(), 'Linux tools running on this computer · Offline', await restored.locator('#message').textContent());
    const restoredText = await restored.evaluate(async () => new TextDecoder().decode(await window.vm.read_file('/home/outpost/extension-test.txt')));
    assert.equal(restoredText, 'synthetic extension file');
    assert.deepEqual(restoreErrors, []);
    assert.deepEqual(restoreSockets, []);
    console.log(JSON.stringify({ chrome: chromeVersion, linuxBooted: true, terminalInput: true,
      guestFileDownloaded: true, encryptedExportRestoredInNewProfile: true, offline: true }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: await terminal.locator('#status').textContent().catch(() => ''),
      message: await terminal.locator('#message').textContent().catch(() => ''), errors, failures: failures.slice(-12),
      serial: await terminal.evaluate(() => String(window.serialText || '').slice(-1200)).catch(() => '') }, null, 2));
    throw error;
  }
} finally {
  if (context) await context.close();
  if (second) await second.close();
  if (path.dirname(profile) !== here) throw Error('Invalid temporary profile path');
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  if (secondProfile) {
    if (path.dirname(secondProfile) !== here) throw Error('Invalid temporary profile path');
    await fs.rm(secondProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
