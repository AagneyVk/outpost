// Security regression: a valid but oversized synthetic profile must not be installed.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const flag = process.argv.indexOf('--addon');
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--addon requires a directory path');
const addon = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(root, '../outpost-extension-reviewed-preview'));
const profile = await fs.mkdtemp(path.join(here, 'temporary-profile-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: addon });
  await cdp.detach();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + id + '/gecko-lab/index.html');
  const encrypted = await page.evaluate(async () => {
    const { seal } = await import(chrome.runtime.getURL('portable.js'));
    const root = await navigator.storage.getDirectory();
    const profile = await root.getDirectoryHandle('outpost-gecko-lab', { create: true });
    const canary = await profile.getFileHandle('synthetic-canary.txt', { create: true });
    const writer = await canary.createWritable(); await writer.write('preserve'); await writer.close();
    const raw = new Uint8Array(66 * 1024 * 1024).fill(65);
    const blob = await seal(raw, 'T3st!abc', 'ebd6c75179152624d9644865e11792ed25cadc714d9e0985f412baf9c637a086', { minLength: 8 });
    raw.fill(0);
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await page.locator('#profile-options summary').click();
  await page.locator('#profile-file').setInputFiles({ name: 'oversized.outpost', mimeType: 'application/octet-stream', buffer: Buffer.from(encrypted) });
  await page.locator('#profile-passphrase').fill('T3st!abc');
  await page.locator('#import-profile').click();
  await page.waitForFunction(() => !document.querySelector('#profile-passphrase').value &&
    document.querySelector('#status').textContent.includes('Workspace exceeds the prototype size limit'), null, { timeout: 60000 });
  const state = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory(), directories = [];
    for await (const [name, entry] of root.entries()) if (entry.kind === 'directory') directories.push(name);
    const profile = await root.getDirectoryHandle('outpost-gecko-lab');
    const canary = await (await profile.getFileHandle('synthetic-canary.txt')).getFile();
    return { directories, contents: await canary.text(), active: localStorage.getItem('outpost-gecko-profile-name') };
  });
  assert.equal(state.contents, 'preserve');
  assert.equal(state.active, null);
  assert.equal(state.directories.some(name => name.startsWith('outpost-import-')), false);
  console.log(JSON.stringify({ chrome: context.browser().version(), validOversizedEnvelopeRejected: true,
    existingProfilePreserved: true, partialProfileCreated: false }, null, 2));
} finally {
  if (context) await context.close();
  if (path.dirname(profile) !== here || !path.basename(profile).startsWith('temporary-profile-')) throw Error('Invalid temporary path');
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
