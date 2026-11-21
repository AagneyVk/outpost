// Synthetic Gecko test of the encrypted write-through provider. The provider
// is injected only into a disposable copy of the preview; no real credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { waitForAsync } from '../../tools/wait-for-async.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const flag = process.argv.indexOf('--addon');
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--addon requires a directory');
const addon = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(root, '../outpost-extension-safe-restart-v4'));
// A short OS temp path avoids Chrome's Windows IndexedDB path-length limit.
const tempRoot = path.resolve(os.tmpdir());
const temp = await fs.mkdtemp(path.join(tempRoot, 'outpost-encrypted-test-'));
const chunked = process.argv.includes('--chunked');
const block = process.argv.includes('--block');
if (chunked && block) throw Error('Choose one encrypted provider.');
const dbName = block ? 'outpost-live-test-block' : chunked ? 'outpost-live-test-chunked' : 'outpost-live-test-fixture', password = 'synthetic long test passphrase';
const publicDemo = process.argv.includes('--public-demo');
const fixtureHost = publicDemo ? 'the-internet.herokuapp.com' : 'encrypted-live-fixture.test';
let context, legacyContext;
try {
  const copy = path.join(temp, 'addon'), research = path.join(copy, 'gecko-lab/research');
  await fs.cp(addon, copy, { recursive: true });
  await fs.mkdir(path.join(research, 'encrypted-live-profile'), { recursive: true });
  await fs.mkdir(path.join(research, 'memory-profile'), { recursive: true });
  for (const name of ['live-profile.mjs', 'indexeddb-store.mjs', 'chunked-profile.mjs', 'chunked-store.mjs', 'block-profile.mjs', 'block-store.mjs', 'block-lock.mjs', 'locked-profile.mjs', 'app-profile.mjs', 'legacy-profile.mjs'])
    await fs.copyFile(path.join(here, name), path.join(research, 'encrypted-live-profile', name));
  for (const name of ['memory-profile.mjs', 'archive.mjs'])
    await fs.copyFile(path.join(root, 'experiments/memory-profile', name), path.join(research, 'memory-profile', name));
  if (block && process.argv.includes('--crash')) {
    // Test-only instrumentation keeps a transaction busy long enough to
    // observe it before crashing the disposable browser process.
    const storeFile = path.join(research, 'encrypted-live-profile/block-store.mjs');
    let source = await fs.readFile(storeFile, 'utf8');
    const marker = '        for (const name of removals) object.delete(name);';
    if (source.indexOf(marker) < 0 || source.indexOf(marker) !== source.lastIndexOf(marker)) throw Error('Unexpected block transaction.');
    source = source.replace(marker, marker + "\n        if (globalThis.__testDelayBlockCommit) { globalThis.__testTxStarted = true; for (let i = 0; i < 10000; i++) object.get('manifest'); }");
    const complete = '        tx.oncomplete = () => resolve();';
    const completionIndex = source.indexOf(complete, source.indexOf(marker));
    if (completionIndex < 0) throw Error('Unexpected block completion.');
    source = source.slice(0, completionIndex) + "        tx.oncomplete = () => { if (globalThis.__testDelayBlockCommit) globalThis.__testTxCompleted = true; resolve(); };" + source.slice(completionIndex + complete.length);
    const abortHandler = "        tx.onabort = tx.onerror = () => reject(tx.error || Error('Encrypted test store write failed.'));";
    if (source.indexOf(abortHandler) < 0 || source.indexOf(abortHandler) !== source.lastIndexOf(abortHandler)) throw Error('Unexpected block abort handling.');
    source = source.replace(abortHandler, abortHandler + "\n        if (globalThis.__testAbortNextBlockCommit) { globalThis.__testAbortNextBlockCommit = false; tx.abort(); }");
    await fs.writeFile(storeFile, source);
  }
  const file = path.join(copy, 'gecko-lab/start.mjs');
  let script = await fs.readFile(file, 'utf8');
  function replaceOnce(before, after) {
    const pos = script.indexOf(before);
    if (pos < 0 || pos !== script.lastIndexOf(before)) throw Error('Unexpected preview script.');
    script = script.slice(0, pos) + after + script.slice(pos + before.length);
  }
  script = "import { openLockedTestProfile, openLockedChunkedTestProfile, openLockedBlockTestProfile } from './research/encrypted-live-profile/locked-profile.mjs';\nimport { encryptedAppProfile } from './research/encrypted-live-profile/app-profile.mjs';\n" + script;
  const profileImport = "import { clearBrowserProfiles, exportProfile, importProfile, profileLock, profileName, readBrowserSession, writeBrowserSession, readBrowserHistory, writeBrowserHistory, hasSessionCookieSnapshot, clearSessionCookieSnapshot } from './profile.mjs';";
  replaceOnce(profileImport, "import { clearBrowserProfiles, exportProfile, importProfile, profileLock, profileName } from './profile.mjs';\nconst { readBrowserSession, writeBrowserSession, readBrowserHistory, writeBrowserHistory, hasSessionCookieSnapshot, clearSessionCookieSnapshot } = encryptedAppProfile(() => window.__liveTestHandle?.live);");
  replaceOnce('    gecko = new Gecko({', `    const testHandle = await ${block ? 'openLockedBlockTestProfile' : chunked ? 'openLockedChunkedTestProfile' : 'openLockedTestProfile'}(${JSON.stringify(dbName)}, ${JSON.stringify(password)});\n    window.__liveTestHandle = testHandle;\n    gecko = new Gecko({`);
  replaceOnce('      profile: profileName(),', '      profile: testHandle.live,');
  replaceOnce('    await gecko.init();', '    await gecko.init();\n    window.__liveTestGecko = gecko;');
  await fs.writeFile(file, script);

  const requests = [];
  async function launch() {
    context = await chromium.launchPersistentContext(path.join(temp, 'chrome-profile'), {
      ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
      headless: true, viewport: { width: 1100, height: 800 },
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
    });
    await context.addCookies([{ name: 'host_canary', value: 'host-only', domain: fixtureHost, path: '/', ...(publicDemo ? { secure: true, sameSite: 'None' } : {}) }]);
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: copy }); await cdp.detach();
    if (!publicDemo) await context.routeWebSocket('wss://wisp.mercurywork.shop/**', socket => {
      const send = (type, stream, body) => { const head = Buffer.alloc(5); head[0] = type; head.writeUInt32LE(stream, 1); socket.send(Buffer.concat([head, body])); };
      send(3, 0, Buffer.from([128, 0, 0, 0]));
      const pending = new Map(), answered = new Set();
      socket.onMessage(data => {
        const packet = Buffer.from(data);
        if (packet.length < 5 || packet[0] !== 2) return;
        const stream = packet.readUInt32LE(1); if (answered.has(stream)) return;
        const request = (pending.get(stream) || '') + packet.subarray(5).toString('latin1'); pending.set(stream, request);
        if (!request.includes('\r\n\r\n')) return;
        answered.add(stream); requests.push(request);
        const body = '<!doctype html><title>Encrypted live fixture</title><p>Synthetic page</p>';
        const cookie = requests.length === 1 ? 'Set-Cookie: live_session=SYNTHETIC_LIVE_COOKIE_SECRET; Path=/; HttpOnly\r\n' : '';
        send(2, stream, Buffer.from(`HTTP/1.1 200 OK\r\n${cookie}Content-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
        send(4, stream, Buffer.from([1]));
      });
    });
    const page = await context.newPage();
    await page.goto('chrome-extension://' + id + '/gecko-lab/index.html');
    return { page, id };
  }
  async function start(page) {
    const begin = performance.now();
    await page.locator('#start').click();
    await page.waitForFunction(() => !document.querySelector('#address').disabled || !document.querySelector('#start-error').hidden, null, { timeout: 240000 });
    assert.equal(await page.locator('#start-error').isHidden(), true, await page.locator('#start-error').textContent());
    return Math.round(performance.now() - begin);
  }
  async function navigate(page, pathname) {
    await page.waitForFunction(() => !document.querySelector('#go').disabled, null, { timeout: 180000 });
    await page.locator('#address').fill((publicDemo ? 'https://' : 'http://') + fixtureHost + '/' + pathname);
    await page.locator('#address').press('Enter');
    if (!publicDemo) await waitForAsync(async () => requests.some(req => req.startsWith('GET /' + pathname + ' HTTP/')), { timeout: 90000 });
    await page.waitForFunction(host => document.querySelector('#status').textContent.includes('Loaded ' + host), fixtureHost, { timeout: 90000 });
  }
  async function guest(page, expression) { return page.evaluate(expression => window.__liveTestGecko.evalChrome(expression), expression); }
  async function waitGuest(page, expression) {
    await waitForAsync(async () => { try { return await guest(page, expression) === 'true'; } catch { return false; } }, { timeout: 90000, interval: 500 });
  }
  async function clickGuest(page, selector) {
    if (await page.locator('#scene-view').isVisible()) await page.locator('#scene-view').click();
    const expression = `JSON.stringify((()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return {x,y,w:innerWidth,h:innerHeight,hit:!!h&&(h===e||e.contains(h))};})())`;
    let point;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { point = JSON.parse(await guest(page, expression)); } catch { point = null; }
      if (point?.hit && point.x >= 0 && point.y >= 0 && point.x < point.w && point.y < point.h) break;
      point = null; await page.waitForTimeout(250);
    }
    assert.ok(point, 'synthetic public demo element is not clickable: ' + selector);
    const box = await page.locator('#surface').boundingBox(); assert.ok(box);
    await page.mouse.click(box.x + point.x * box.width / point.w, box.y + point.y * box.height / point.h);
  }

  let { page, id } = await launch();
  const firstStartupMs = await start(page);
  console.log('Synthetic encrypted profile started in', firstStartupMs, 'ms.');
  if (publicDemo) {
    await navigate(page, 'login?private=SYNTHETIC_HISTORY_SECRET');
    await waitGuest(page, "String(location.pathname==='/login' && !!document.querySelector('#username') && !!document.querySelector('#password'))");
    await clickGuest(page, '#username'); await page.keyboard.type('tomsmith');
    await waitGuest(page, "String(document.querySelector('#username')?.value==='tomsmith')");
    await clickGuest(page, '#password'); await page.keyboard.type('SuperSecretPassword!');
    await waitGuest(page, "String(document.querySelector('#password')?.value.length===20)");
    await clickGuest(page, 'button[type="submit"]');
    await waitGuest(page, "String(location.pathname==='/secure' && /you logged into a secure area/i.test(document.body?.textContent||'') && !!document.querySelector('a[href*=\"/logout\"]'))");
    assert.equal(await guest(page, "String(window.isSecureContext)"), 'true');
  } else {
    await navigate(page, 'first');
    await navigate(page, 'second?private=SYNTHETIC_HISTORY_SECRET');
    assert.ok(requests.some(req => req.startsWith('GET /second?private=SYNTHETIC_HISTORY_SECRET HTTP/') && /Cookie:.*live_session=SYNTHETIC_LIVE_COOKIE_SECRET/i.test(req)));
    assert.ok(requests.every(req => !/host_canary/i.test(req)));
  }
  await page.evaluate(async () => {
    await window.__liveTestHandle.live.mkdir('synthetic-private-dir');
    await window.__liveTestHandle.live.writeFile('synthetic-private-dir/secret', new TextEncoder().encode('SYNTHETIC_FILE_SECRET'));
  });
  assert.equal(await page.evaluate(() => window.__liveTestGecko.evalChrome('outpost:session-cookie-save')), 'ok');
  const evidence = await page.evaluate(async ({ name, multi }) => {
    const open = indexedDB.open(name, 1);
    const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const tx = db.transaction(multi ? 'records' : 'profile', 'readonly'), request = multi ? tx.objectStore('records').getAll() : tx.objectStore('profile').get('ciphertext');
    const result = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const blobs = multi ? result : [result];
    let clean = true, bytes = 0;
    for (const blob of blobs) {
      if (!(blob instanceof Blob)) throw Error('Unexpected plaintext record');
      bytes += blob.size;
      const text = new TextDecoder('latin1').decode(await blob.arrayBuffer());
      if (['SYNTHETIC_LIVE_COOKIE_SECRET', 'SYNTHETIC_FILE_SECRET', 'SYNTHETIC_HISTORY_SECRET', 'synthetic-private-dir'].some(marker => text.includes(marker))) clean = false;
    }
    const root = await navigator.storage.getDirectory();
    async function scan(dir) {
      for await (const [, item] of dir.entries()) {
        if (item.kind === 'directory') { if (await scan(item)) return true; }
        else { const content = new TextDecoder('latin1').decode(await (await item.getFile()).arrayBuffer());
          if (['SYNTHETIC_LIVE_COOKIE_SECRET', 'SYNTHETIC_FILE_SECRET', 'SYNTHETIC_HISTORY_SECRET', btoa('SYNTHETIC_LIVE_COOKIE_SECRET')].some(marker => content.includes(marker))) return true; }
      }
      return false;
    }
    db.close(); return { ciphertextOnly: clean, markerInOpfs: await scan(root), bytes };
  }, { name: dbName, multi: chunked || block });
  assert.equal(evidence.ciphertextOnly, true); assert.equal(evidence.markerInOpfs, false);
  const atomicAbort = await page.evaluate(async block => {
    const name = block ? 'outpost-live-test-atomic-block' : 'outpost-live-test-atomic';
    const { openEncryptedStore } = await import('./research/encrypted-live-profile/indexeddb-store.mjs');
    const { openBlockTestStore } = await import('./research/encrypted-live-profile/block-store.mjs');
    const store = await (block ? openBlockTestStore : openEncryptedStore)(name), id = 'a'.repeat(32);
    try {
      if (block) await store.commit(new Blob(['committed-synthetic-value']), [[id, 0, new Blob(['committed-block'])]], []);
      else await store.commit(new Blob(['committed-synthetic-value']));
      const request = indexedDB.open(name, 1);
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(block ? 'records' : 'profile', 'readwrite', { durability: 'strict' });
          const object = tx.objectStore(block ? 'records' : 'profile');
          object.put(new Blob(['uncommitted-synthetic-value']), block ? 'manifest' : 'ciphertext');
          if (block) object.put(new Blob(['uncommitted-block']), 'block:' + id + ':0');
          tx.onabort = () => resolve(); tx.oncomplete = () => reject(Error('Synthetic transaction unexpectedly committed'));
          tx.abort();
        });
      } finally { db.close(); }
      if (block) return await (await store.readManifest()).text() === 'committed-synthetic-value' && await (await store.readBlock(id, 0)).text() === 'committed-block';
      return await (await store.read()).text() === 'committed-synthetic-value';
    } finally { store.close(); }
  }, block);
  assert.equal(atomicAbort, true, 'an aborted IndexedDB transaction must preserve the prior value');
  let explicitModes = null;
  if (block) {
    explicitModes = await page.evaluate(async () => {
      const { openLockedBlockTestProfile, deleteLockedBlockTestProfile } = await import('./research/encrypted-live-profile/locked-profile.mjs');
      const name = 'outpost-live-test-explicit-modes', pass = 'synthetic long test passphrase';
      async function rejected(operation) { try { await operation(); return false; } catch { return true; } }
      if (!await rejected(() => openLockedBlockTestProfile(name, pass, 'open'))) return false;
      let handle = await openLockedBlockTestProfile(name, pass, 'create');
      await handle.live.writeFile('synthetic', new Uint8Array([7])); await handle.close();
      if (!await rejected(() => openLockedBlockTestProfile(name, pass, 'create'))) return false;
      if (!await rejected(() => deleteLockedBlockTestProfile(name, 'wrong synthetic passphrase'))) return false;
      handle = await openLockedBlockTestProfile(name, pass, 'open');
      const intact = (await handle.live.readFile('synthetic'))[0] === 7; await handle.close();
      if (!intact) return false;
      await deleteLockedBlockTestProfile(name, pass);
      if (!await rejected(() => openLockedBlockTestProfile(name, pass, 'open'))) return false;
      handle = await openLockedBlockTestProfile(name, pass, 'create'); await handle.close();
      return true;
    });
    assert.equal(explicitModes, true, 'create, unlock and clear must not overwrite existing profiles or accept a wrong password');
  }
  let providerAbort = null;
  if (block && process.argv.includes('--crash')) {
    providerAbort = await page.evaluate(async () => {
      const { openLockedBlockTestProfile } = await import('./research/encrypted-live-profile/locked-profile.mjs');
      const name = 'outpost-live-test-provider-abort', pass = 'synthetic long test passphrase';
      let opened = await openLockedBlockTestProfile(name, pass);
      try {
        await opened.live.writeFile('synthetic', new Uint8Array([1]));
        window.__testAbortNextBlockCommit = true;
        let rejected = false, poisoned = false;
        try { await opened.live.writeFile('synthetic', new Uint8Array([2])); } catch { rejected = true; }
        try { await opened.live.readFile('synthetic'); } catch { poisoned = true; }
        await opened.close(); opened = await openLockedBlockTestProfile(name, pass);
        const restored = await opened.live.readFile('synthetic');
        return rejected && poisoned && restored.length === 1 && restored[0] === 1;
      } finally { await opened.close(); }
    });
    assert.equal(providerAbort, true, 'provider must stop after an aborted transaction and reopen the previous data');
  }
  const other = await context.newPage(); await other.goto('chrome-extension://' + id + '/gecko-lab/index.html');
  const lockResult = await other.evaluate(async ({ name, pass, chunked, block }) => {
    try { const module = await import('./research/encrypted-live-profile/locked-profile.mjs');
      const opened = await (block ? module.openLockedBlockTestProfile : chunked ? module.openLockedChunkedTestProfile : module.openLockedTestProfile)(name, pass); await opened.close(); return 'unexpected success'; }
    catch (error) { return error.message; }
  }, { name: dbName, pass: password, chunked, block });
  assert.match(lockResult, /Another tab/);
  await context.close(); context = null; // Abrupt close after the completed synthetic cookie snapshot.

  ({ page, id } = await launch());
  const wrongPassword = await page.evaluate(async ({ name, chunked, block }) => {
    try { const module = await import('./research/encrypted-live-profile/locked-profile.mjs');
      const opened = await (block ? module.openLockedBlockTestProfile : chunked ? module.openLockedChunkedTestProfile : module.openLockedTestProfile)(name, 'wrong synthetic password'); await opened.close(); return 'unexpected success'; }
    catch (error) { return error.message; }
  }, { name: dbName, chunked, block });
  assert.match(wrongPassword, /Wrong passphrase or damaged/);
  const secondStartupMs = await start(page);
  console.log('Synthetic encrypted profile reopened in', secondStartupMs, 'ms.');
  if (publicDemo) {
    await navigate(page, 'secure');
    await waitGuest(page, "String(location.pathname==='/secure' && /secure area/i.test(document.body?.textContent||'') && !!document.querySelector('a[href*=\"/logout\"]'))");
    await page.waitForTimeout(1500);
    assert.equal(await guest(page, "String(location.pathname==='/secure' && !!document.querySelector('a[href*=\"/logout\"]'))"), 'true');
    await clickGuest(page, 'a[href*="/logout"]');
    await waitGuest(page, "String(location.pathname==='/login' && !!document.querySelector('#username'))");
    assert.deepEqual((await context.cookies('https://' + fixtureHost)).map(cookie => cookie.name), ['host_canary']);
  } else {
    await navigate(page, 'restored');
    assert.ok(requests.some(req => req.startsWith('GET /restored HTTP/') && /Cookie:.*live_session=SYNTHETIC_LIVE_COOKIE_SECRET/i.test(req)));
  }
  assert.equal(await page.evaluate(async () => new TextDecoder().decode(await window.__liveTestHandle.live.readFile('synthetic-private-dir/secret'))), 'SYNTHETIC_FILE_SECRET');
  const historyRestored = await page.evaluate(async () => {
    const { encryptedAppProfile } = await import('./research/encrypted-live-profile/app-profile.mjs');
    const io = encryptedAppProfile(() => window.__liveTestHandle.live);
    return (await io.readBrowserHistory()).some(url => url.includes('SYNTHETIC_HISTORY_SECRET')) &&
      (await io.readBrowserSession())?.tabs?.some(tab => tab.stack.some(url => url.includes('SYNTHETIC_HISTORY_SECRET')));
  });
  assert.equal(historyRestored, true, 'synthetic tabs and history must survive reopening');
  assert.equal(await page.evaluate(() => window.__liveTestGecko.evalChrome('outpost:session-cookie-save')), 'ok');
  const legacyExport = Buffer.from(await page.evaluate(async ({ chunked, block }) => {
    const { seal, unseal } = await import('/portable.js');
    const { EncryptedLiveProfile } = await import('./research/encrypted-live-profile/live-profile.mjs');
    const { ChunkedLiveProfile } = await import('./research/encrypted-live-profile/chunked-profile.mjs');
    const { BlockLiveProfile } = await import('./research/encrypted-live-profile/block-profile.mjs');
    const { openEncryptedStore } = await import('./research/encrypted-live-profile/indexeddb-store.mjs');
    const { openChunkedTestStore } = await import('./research/encrypted-live-profile/chunked-store.mjs');
    const { openBlockTestStore } = await import('./research/encrypted-live-profile/block-store.mjs');
    const fingerprint = 'ebd6c75179152624d9644865e11792ed25cadc714d9e0985f412baf9c637a086';
    const blob = await window.__liveTestHandle.live.exportLegacy('T3st!abc', fingerprint, seal);
    const migrationName = block ? 'outpost-live-test-migration-block' : chunked ? 'outpost-live-test-migration-chunked' : 'outpost-live-test-migration';
    await navigator.locks.request('outpost-live-profile:' + migrationName, { ifAvailable: true }, async lock => {
      if (!lock) throw Error('Synthetic migration lock unavailable');
      const disk = await (block ? openBlockTestStore : chunked ? openChunkedTestStore : openEncryptedStore)(migrationName);
      try {
        const migrated = await (block ? BlockLiveProfile : chunked ? ChunkedLiveProfile : EncryptedLiveProfile).createFromLegacy(disk, 'another synthetic long passphrase', blob, 'T3st!abc', fingerprint, unseal);
        try {
          const secret = new TextDecoder().decode(await migrated.readFile('synthetic-private-dir/secret'));
          if (secret !== 'SYNTHETIC_FILE_SECRET' || !(await migrated.stat('outpost-session-cookies.dat'))) throw Error('Synthetic migration lost profile data');
        } finally { await migrated.close(); }
      } finally { disk.close(); }
    });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, { chunked, block }));
  assert.equal(legacyExport.includes(Buffer.from('SYNTHETIC_FILE_SECRET')), false);
  legacyContext = await chromium.launchPersistentContext(path.join(temp, 'legacy-profile'), {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, viewport: { width: 1100, height: 800 }, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging']
  });
  const legacyCdp = await legacyContext.browser().newBrowserCDPSession();
  const { id: legacyId } = await legacyCdp.send('Extensions.loadUnpacked', { path: addon }); await legacyCdp.detach();
  const legacyPage = await legacyContext.newPage();
  await legacyPage.goto('chrome-extension://' + legacyId + '/gecko-lab/index.html');
  await legacyPage.locator('#profile-options summary').click();
  await legacyPage.locator('#profile-file').setInputFiles({ name: 'synthetic.outpost', mimeType: 'application/octet-stream', buffer: legacyExport });
  await legacyPage.locator('#profile-passphrase').fill('T3st!abc');
  await legacyPage.locator('#import-profile').click();
  await legacyPage.waitForFunction(() => document.querySelector('#status').textContent.includes('Profile restored.') ||
    document.querySelector('#status').textContent.includes('Wrong passphrase'), null, { timeout: 30000 });
  assert.match(await legacyPage.locator('#status').textContent(), /Profile restored\./);
  const compatible = await legacyPage.evaluate(async () => {
    const { profileName } = await import('./profile.mjs'), root = await navigator.storage.getDirectory();
    const profile = await root.getDirectoryHandle(profileName());
    const dir = await profile.getDirectoryHandle('synthetic-private-dir');
    const secret = await (await dir.getFileHandle('secret')).getFile();
    const history = await (await profile.getFileHandle('outpost-history.ndjson')).getFile();
    const cookies = await (await profile.getFileHandle('outpost-session-cookies.dat')).getFile();
    return await secret.text() === 'SYNTHETIC_FILE_SECRET' && (await history.text()).includes('SYNTHETIC_HISTORY_SECRET') && cookies.size > 0;
  });
  assert.equal(compatible, true, 'the existing extension must import the synthetic legacy-format export');
  await legacyContext.close(); legacyContext = null;
  let writeBenchmark = null;
  if (process.argv.includes('--benchmark') || process.argv.includes('--benchmark-large')) {
    writeBenchmark = await page.evaluate(async large => {
      const live = window.__liveTestHandle.live;
      const results = [];
      for (const size of large ? [2, 32] : [2]) {
        await live.writeFile('synthetic-benchmark-payload', new Uint8Array(size * 1024 * 1024));
        const samples = [];
        for (let index = 0; index < (size === 2 ? 15 : 5); index++) {
          const started = performance.now();
          await live.writeFile('synthetic-benchmark-small', new Uint8Array([index]));
          samples.push(performance.now() - started);
        }
        samples.sort((a, b) => a - b);
        let largeFileWriteMs = null;
        if (size === 32) {
          const started = performance.now();
          const changed = new Uint8Array(size * 1024 * 1024); changed[100000] = 1;
          await live.writeFile('synthetic-benchmark-payload', changed);
          largeFileWriteMs = Math.round(performance.now() - started);
        }
        results.push({ profilePayloadBytes: size * 1024 * 1024, writes: samples.length,
          medianMs: Math.round(samples[Math.floor(samples.length / 2)]), maxMs: Math.round(samples.at(-1)), largeFileWriteMs });
      }
      return results;
    }, process.argv.includes('--benchmark-large'));
  }
  let interruptedWriteRecovered = null, crashReopenMs = null, observedPendingTransaction = null;
  if (process.argv.includes('--crash')) {
    await page.evaluate(() => window.__liveTestHandle.live.writeFile('synthetic-crash-probe', new Uint8Array([1])));
    await page.evaluate(block => {
      if (block) { window.__testDelayBlockCommit = true; window.__testTxStarted = false; window.__testTxCompleted = false; }
      const bytes = new Uint8Array(8 * 1024 * 1024); bytes.fill(7);
      window.__syntheticPendingWrite = window.__liveTestHandle.live.writeFile('synthetic-crash-probe', bytes).catch(() => {});
    }, block);
    if (block) {
      await page.waitForFunction(() => window.__testTxStarted, null, { timeout: 30000 });
      observedPendingTransaction = await page.evaluate(() => !window.__testTxCompleted);
      assert.equal(observedPendingTransaction, true, 'synthetic transaction must still be pending before crash');
    }
    const closed = context.waitForEvent('close', { timeout: 30000 });
    const crashCdp = await context.browser().newBrowserCDPSession();
    crashCdp.send('Browser.crash').catch(() => {});
    await closed; context = null;
    ({ page } = await launch());
    const reopenStarted = performance.now();
    const outcome = await page.evaluate(async ({ name, pass, chunked, block }) => {
      const module = await import('./research/encrypted-live-profile/locked-profile.mjs');
      const opened = await (block ? module.openLockedBlockTestProfile : chunked ? module.openLockedChunkedTestProfile : module.openLockedTestProfile)(name, pass);
      try {
        const bytes = await opened.live.readFile('synthetic-crash-probe');
        return bytes.length === 1 && bytes[0] === 1 ? 'previous' :
          bytes.length === 8 * 1024 * 1024 && bytes.every(byte => byte === 7) ? 'new' : 'invalid';
      } finally { await opened.close(); }
    }, { name: dbName, pass: password, chunked, block });
    assert.notEqual(outcome, 'invalid', 'interrupted write must reopen as a complete old or new value');
    interruptedWriteRecovered = outcome;
    crashReopenMs = Math.round(performance.now() - reopenStarted);
  }
  console.log(JSON.stringify({ chrome: context.browser().version(), publicDemo, chunked, block, syntheticSessionRestoredAfterClose: true,
    encryptedIndexedDbRecord: evidence.ciphertextOnly, markerAbsentFromOpfs: !evidence.markerInOpfs,
    tabsAndHistoryEncryptedAndRestored: historyRestored, legacyMigrationAndImport: compatible, concurrentTabBlocked: true, wrongPasswordRejected: true, explicitModes, abortedTransactionPreservedOldValue: atomicAbort, providerAbortRecovered: providerAbort,
    interruptedWriteRecovered, observedPendingTransaction, crashReopenMs, writeBenchmark, firstStartupMs, secondStartupMs,
    encryptedRecordBytes: evidence.bytes, testOnly: true }, null, 2));
} finally {
  if (legacyContext) await legacyContext.close();
  if (context) await context.close();
  if (path.dirname(temp) !== tempRoot || !path.basename(temp).startsWith('outpost-encrypted-test-')) throw Error('Invalid temporary path');
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
