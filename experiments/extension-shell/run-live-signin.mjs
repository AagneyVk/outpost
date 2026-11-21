// Real public demo, published synthetic credentials, disposable Chrome profiles.
// This tests the relay-based preview, not the experimental direct transport.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { waitForAsync } from '../../tools/wait-for-async.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const flag = process.argv.indexOf('--addon');
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--addon requires a directory path');
const addon = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(root, '../outpost-extension-security-preview'));
const profiles = [], contexts = [];
const passphrase = 'Synthetic longer test passphrase';
const livePreview = process.argv.includes('--encrypted-live-preview');
const livePassphrase = 'Synthetic live profile test passphrase';
const temporaryParent = livePreview ? path.resolve(os.tmpdir()) : here;
const addonPrefix = livePreview ? 'outpost-live-addon-' : 'temporary-addon-';
const profilePrefix = livePreview ? 'outpost-live-profile-' : 'temporary-profile-';
const siteFlag = process.argv.indexOf('--site');
const site = siteFlag < 0 ? 'expand' : process.argv[siteFlag + 1];
const fixtures = { expand: { host: 'practice.expandtesting.com', username: 'practice' },
  'the-internet': { host: 'the-internet.herokuapp.com', username: 'tomsmith' } };
if (!Object.hasOwn(fixtures, site)) throw Error('Use --site expand or --site the-internet');
const { host, username } = fixtures[site];
const signedIn = `String(location.hostname===${JSON.stringify(host)} && location.pathname==='/secure' && /you logged into a secure area/i.test(document.body?.textContent||'') && !!document.querySelector('a[href*="/logout"]'))`;
const protectedPage = `String(location.hostname===${JSON.stringify(host)} && location.pathname==='/secure' && /secure area/i.test(document.body?.textContent||'') && !!document.querySelector('a[href*="/logout"]'))`;
const temporary = await fs.mkdtemp(path.join(temporaryParent, addonPrefix));
try {
  const copied = path.join(temporary, 'addon');
  await fs.cp(addon, copied, { recursive: true, errorOnExist: true });
  const script = path.join(copied, 'gecko-lab/start.mjs');
  const source = await fs.readFile(script, 'utf8'), marker = '    await gecko.init();';
  if (source.indexOf(marker) < 0 || source.indexOf(marker) !== source.lastIndexOf(marker)) throw Error('Unexpected startup script');
  // Diagnostic access exists only in this disposable test copy.
  await fs.writeFile(script, source.replace(marker, marker + '\n    window.__outpostTestGecko = gecko;'));
  async function launch() {
    const profile = await fs.mkdtemp(path.join(temporaryParent, profilePrefix));
    profiles.push(profile);
    const context = await chromium.launchPersistentContext(profile, {
      ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
      headless: true, viewport: { width: 1200, height: 900 }, ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging']
    });
    contexts.push(context);
    await context.addCookies([{ name: 'host_canary', value: 'synthetic-only', domain: host, path: '/', secure: true, sameSite: 'None' }]);
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: copied });
    await cdp.detach();
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto('chrome-extension://' + id + '/gecko-lab/index.html');
    return { context, page, errors };
  }
  async function prepareLive(page, mode = 'open') {
    if (!livePreview) return;
    await page.locator('#live-mode').selectOption(mode);
    await page.locator('#live-passphrase').fill(livePassphrase);
    if (mode === 'create') await page.locator('#live-confirm').fill(livePassphrase);
  }
  async function start(page, mode = 'open') {
    await prepareLive(page, mode);
    await page.locator('#start').click();
    await page.waitForFunction(() => !document.querySelector('#address').disabled || !document.querySelector('#start-error').hidden, null, { timeout: 180000 });
    assert.equal(await page.locator('#start-error').isHidden(), true, await page.locator('#start-error').textContent());
  }
  async function guest(page, expression) {
    return page.evaluate(async expression => window.__outpostTestGecko.evalChrome(expression), expression);
  }
  async function snapshotMetadata(page) {
    return page.evaluate(async host => {
      try {
        const { profileName } = await import(chrome.runtime.getURL('gecko-lab/profile.mjs'));
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle(profileName());
        const file = await (await directory.getFileHandle('outpost-session-cookies.dat')).getFile();
        const lines = (await file.text()).split('\n').slice(1).filter(Boolean);
        const entries = lines.map(line => line.split(',')).filter(fields => {
          try { return atob(fields[0]).replace(/^\./, '').endsWith(host); } catch { return false; }
        });
        return Promise.all(entries.map(async fields => {
          const bytes = Uint8Array.from(fields[2] === '-' ? '' : atob(fields[2]), char => char.charCodeAt(0));
          try {
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            return { name: fields[1] === '-' ? '' : atob(fields[1]), secure: fields[5] === '1', httpOnly: fields[6] === '1',
              proof: [...hash].map(value => value.toString(16).padStart(2, '0')).join('') };
          } finally { bytes.fill(0); }
        }));
      } catch (error) { return { error: error.name }; }
    }, host);
  }
  async function navigate(page, url) {
    await page.waitForFunction(() => !document.querySelector('#go').disabled, null, { timeout: 60000 });
    await page.evaluate(() => {
      globalThis.__outpostSawOpening = false;
      globalThis.__outpostNavObserver?.disconnect();
      const status = document.querySelector('#status');
      globalThis.__outpostNavObserver = new MutationObserver(() => {
        if (status.textContent.startsWith('Opening ')) globalThis.__outpostSawOpening = true;
      });
      globalThis.__outpostNavObserver.observe(status, { childList: true, characterData: true, subtree: true });
    });
    await page.locator('#address').fill(url);
    await page.locator('#address').press('Enter');
    await page.waitForFunction(() => globalThis.__outpostSawOpening, null, { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector('#go').disabled, null, { timeout: 45000 });
    await page.evaluate(() => globalThis.__outpostNavObserver.disconnect());
  }
  async function waitGuest(page, expression, timeout = 90000) {
    // waitForFunction treats the returned Promise itself as truthy. Poll the
    // resolved Gecko result here, outside the page, so false cannot pass.
    await waitForAsync(async () => {
      try { return await guest(page, expression) === 'true'; } catch { return false; }
    }, { timeout, interval: 500 });
  }
  async function clickGuest(page, selector) {
    if (await page.locator('#scene-view').isVisible()) await page.locator('#scene-view').click();
    const expression = `JSON.stringify((()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,w:innerWidth,h:innerHeight,hit:hit?.tagName,hitMatches:!!hit&&(hit===e||e.contains(hit))};})())`;
    let point = null;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { point = JSON.parse(await guest(page, expression)); } catch {}
      if (point?.hitMatches && point.x >= 0 && point.y >= 0 && point.x < point.w && point.y < point.h) break;
      point = null;
      await page.waitForTimeout(250);
    }
    assert.ok(point && point.w > 0 && point.h > 0, 'demo element is not clickable: ' + selector);
    if (process.argv.includes('--trace')) console.log('Synthetic click:', selector, JSON.stringify(point));
    const box = await page.locator('#surface').boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + point.x * box.width / point.w, box.y + point.y * box.height / point.h);
  }
  const first = await launch();
  let second, sourceSnapshot, stage = 'starting';
  try {
    await start(first.page, 'create');
    stage = 'loading login form';
    await navigate(first.page, 'https://' + host + '/login');
    await waitGuest(first.page, `String(location.hostname===${JSON.stringify(host)} && location.pathname==='/login' && !!document.querySelector('#username') && !!document.querySelector('#password'))`, 90000);
    assert.equal(await guest(first.page, "String(document.cookie.includes('host_canary='))"), 'false');
    stage = 'entering public demo credentials';
    await clickGuest(first.page, '#username');
    await first.page.keyboard.type(username);
    await waitGuest(first.page, `String(document.querySelector('#username')?.value===${JSON.stringify(username)})`, 20000);
    await clickGuest(first.page, '#password');
    await first.page.keyboard.type('SuperSecretPassword!');
    await waitGuest(first.page, "String(document.querySelector('#password')?.value.length===20)", 20000);
    await clickGuest(first.page, 'button[type="submit"]');
    if (process.argv.includes('--trace')) {
      let previous = '';
      for (let attempt = 0; attempt < 30; attempt++) {
        const state = await guest(first.page, `JSON.stringify({path:location.pathname,ready:document.readyState,success:/you logged into a secure area/i.test(document.body?.textContent||''),logout:!!document.querySelector('a[href*="/logout"]'),login:!!document.querySelector('#username'),invalid:/invalid (username|password)/i.test(document.querySelector('#flash')?.textContent||''),cookies:document.cookie.split(';').map(x=>x.trim().split('=')[0]).filter(Boolean).sort()})`);
        if (state !== previous) console.log('Synthetic demo state:', state);
        previous = state;
        await first.page.waitForTimeout(500);
      }
    }
    stage = 'waiting for confirmed demo sign-in';
    if (process.argv.includes('--trace')) console.log('Synthetic signed-in predicate before wait:', await guest(first.page, signedIn));
    await waitGuest(first.page, signedIn, 90000);
    if (process.argv.includes('--trace')) console.log('Synthetic signed-in predicate after wait:', await guest(first.page, signedIn));
    await first.page.waitForTimeout(1500);
    assert.equal(await guest(first.page, signedIn), 'true', 'demo sign-in must remain on the protected page');
    console.log('Confirmed protected demo page in first profile.');
    assert.equal(await guest(first.page, "String(window.isSecureContext)"), 'true');
    stage = 'exporting demo session';
    await first.page.locator('#exit-browser').click();
    await first.page.waitForFunction(() => document.querySelector('#status').textContent.includes('Browser closed.') ||
      document.querySelector('#status').textContent.includes('Could not save'), null, { timeout: 60000 });
    assert.match(await first.page.locator('#status').textContent(), /Browser closed\./);
    if (!livePreview) {
      sourceSnapshot = await snapshotMetadata(first.page);
      console.log('Synthetic source session metadata:', JSON.stringify(Array.isArray(sourceSnapshot) ? sourceSnapshot.map(({ proof, ...record }) => record) : sourceSnapshot));
    }
    await prepareLive(first.page);
    await first.page.locator('#profile-passphrase').fill(passphrase);
    const [download] = await Promise.all([first.page.waitForEvent('download'), first.page.locator('#export-profile').click()]);
    const encrypted = await fs.readFile(await download.path());
    assert.ok(encrypted.length > 32 && !encrypted.includes(Buffer.from('SuperSecretPassword!')));

    second = await launch();
    stage = 'importing demo session';
    await second.page.locator('#profile-options summary').click();
    await second.page.locator('#profile-file').setInputFiles({ name: 'synthetic.outpost', mimeType: 'application/octet-stream', buffer: encrypted });
    await second.page.locator('#profile-passphrase').fill(passphrase);
    await prepareLive(second.page, 'create');
    await second.page.locator('#import-profile').click();
    await second.page.waitForFunction(() => document.querySelector('#status').textContent.includes('Profile restored.') ||
      document.querySelector('#status').textContent.includes('Wrong passphrase'), null, { timeout: 30000 });
    assert.match(await second.page.locator('#status').textContent(), /Profile restored\./);
    if (!livePreview) {
      const importedSnapshot = await snapshotMetadata(second.page);
      assert.deepEqual(importedSnapshot, sourceSnapshot, 'encrypted import must preserve the synthetic session snapshot');
    }
    await start(second.page);
    if (!livePreview) {
      if (await guest(second.page, 'outpost:session-cookie-save') !== 'ok') throw Error('Could not inspect the synthetic restored session');
      const restoredSnapshot = await snapshotMetadata(second.page);
      console.log('Synthetic restored session metadata:', JSON.stringify(Array.isArray(restoredSnapshot) ? restoredSnapshot.map(({ proof, ...record }) => record) : restoredSnapshot));
      console.log('Synthetic session values match after startup:', JSON.stringify(JSON.stringify(restoredSnapshot) === JSON.stringify(sourceSnapshot)));
      await second.page.evaluate(async () => {
        const { clearSessionCookieSnapshot } = await import(chrome.runtime.getURL('gecko-lab/profile.mjs'));
        await clearSessionCookieSnapshot();
      });
    }
    await navigate(second.page, 'https://' + host + '/secure');
    stage = 'waiting for confirmed restored session';
    await waitGuest(second.page, protectedPage, 90000);
    await second.page.waitForTimeout(1500);
    assert.equal(await guest(second.page, protectedPage), 'true', 'restored demo session must remain on the protected page');
    assert.equal(await guest(second.page, "String(document.cookie.includes('host_canary='))"), 'false');
    await waitGuest(second.page, "String(!!document.querySelector('a[href*=\"/logout\"]'))", 45000);
    await clickGuest(second.page, 'a[href*="/logout"]');
    stage = 'waiting for logout';
    await waitGuest(second.page, `String(location.hostname===${JSON.stringify(host)} && location.pathname==='/login' && !!document.querySelector('#username'))`, 90000);
    await second.page.waitForTimeout(3000);
    assert.equal(await guest(second.page, `String(location.hostname===${JSON.stringify(host)} && location.pathname==='/login' && !!document.querySelector('#username'))`), 'true', 'logout must settle on the login page');
    stage = 'checking protected page after logout';
    await navigate(second.page, 'https://' + host + '/secure');
    // The previous login document can remain visible while the request and
    // its redirect are in flight. Do not mistake it for the final response.
    await second.page.waitForTimeout(8000);
    await waitGuest(second.page, `String(location.hostname===${JSON.stringify(host)} && location.pathname==='/login' && !!document.querySelector('#username'))`, 90000);
    assert.equal(await guest(second.page, protectedPage), 'false', 'the protected page must not remain available after logout');
    for (const fixture of [first, second]) {
      const cookies = await fixture.context.cookies('https://' + host);
      assert.deepEqual(cookies.map(cookie => cookie.name), ['host_canary']);
      assert.deepEqual(fixture.errors, []);
    }
    console.log(JSON.stringify({ chrome: second.context.browser().version(), site: 'https://' + host + '/login',
      transport: 'public Wisp relay', encryptedLivePreview: livePreview, realDemoLogin: true, syntheticCredentialsOnly: true,
      usedCanvasInput: true, encryptedExport: true, restoredInFreshProfile: true, logoutReachedLoginPage: true, protectedPageRejectedAfterLogout: true,
      hostCookieJarUnchanged: true }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ stage, status: await first.page.locator('#status').textContent().catch(() => ''),
      guest: await guest(first.page, "JSON.stringify({host:location.hostname,path:location.pathname,title:document.title,ready:document.readyState,inputs:[...document.querySelectorAll('input')].map(e=>({id:e.id,type:e.type,name:e.name})),forms:document.forms.length,bodyLength:document.body?.textContent?.length||0})").catch(() => ''),
      restoredGuest: second ? await guest(second.page, "JSON.stringify({host:location.hostname,path:location.pathname,title:document.title,ready:document.readyState,logoutLinks:[...document.querySelectorAll('a')].filter(a=>/logout|sign.?out/i.test(a.textContent+' '+a.getAttribute('href'))).map(a=>({text:a.textContent.trim().slice(0,80),href:a.getAttribute('href')}))})").catch(() => '') : '',
      pageErrors: first.errors.slice(-5) }, null, 2));
    throw error;
  }
} finally {
  for (const context of contexts) await context.close();
  for (const entry of [temporary, ...profiles]) {
    if (path.dirname(entry) !== temporaryParent || !(path.basename(entry).startsWith(addonPrefix) || path.basename(entry).startsWith(profilePrefix))) throw Error('Invalid temporary path');
    await fs.rm(entry, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
