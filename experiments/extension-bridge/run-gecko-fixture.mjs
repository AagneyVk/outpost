// Test runner for the separate fixture build; never points at the real relay.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const dir = path.dirname(fileURLToPath(import.meta.url));
const patched = process.argv.includes('--patched');
const ordered = process.argv.includes('--ordered');
const testHttps = process.argv.includes('--https');
const securityInfoFlag = process.argv.includes('--security-info');
const build = path.join(dir, ordered ? 'build-ordered' : patched ? 'build-patched' : 'build');
const egressCases = [];
let relayConnectionAttempts = 0;
const routes = new Map([
  ['/', [path.join(dir, 'gecko-fixture.html'), 'text/html']],
  ['/engine/gecko.js', [path.join(build, 'gecko.js'), 'text/javascript']],
  ['/engine/gecko.wasm.zst', [path.join(build, 'gecko.wasm.zst'), 'application/octet-stream']]
]);
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  if (parsed.pathname === '/login' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    egressCases.push({ kind: 'login', body, cookie: req.headers.cookie || '' });
    if (body !== 'alpha') { res.writeHead(403).end(); return; }
    res.writeHead(302, { location: '/account', 'set-cookie': 'workspace_session=alpha; Max-Age=3600; HttpOnly; Path=/; SameSite=Lax',
      'cache-control': 'no-store' }).end();
    return;
  }
  if (parsed.pathname === '/account' && req.method === 'GET') {
    const cookie = req.headers.cookie || '';
    egressCases.push({ kind: 'account', cookie });
    const authorized = cookie === 'workspace_session=alpha';
    res.writeHead(authorized ? 200 : 401, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(authorized ? '<!doctype html><title>BRIDGE SESSION OK</title>' : '<!doctype html><title>BRIDGE SESSION MISSING</title>');
    return;
  }
  if (parsed.pathname === '/slow' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    egressCases.push({ kind: parsed.searchParams.get('case'), body });
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end('synthetic fixture accepted');
    return;
  }
  const item = routes.get(parsed.pathname);
  if (!item) { res.writeHead(404).end(); return; }
  try {
    const content = await fs.readFile(item[0]);
    res.writeHead(200, { 'content-type': item[1], 'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp', 'cache-control': 'no-store' });
    res.end(content);
  } catch (error) { res.writeHead(500).end(String(error)); }
});
server.on('upgrade', (req, socket) => {
  if (req.url === '/wisp/') relayConnectionAttempts++;
  socket.destroy();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const timed = (operation, ms, label) => {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), ms); })
  ]).finally(() => clearTimeout(timer));
};
let browser;
let context;
let profile;
let secondProfile;
try {
  let extension;
  if (ordered) {
    profile = await fs.mkdtemp(path.join(dir, 'gecko-fixture-profile-'));
    context = await chromium.launchPersistentContext(profile, {
      ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
      headless: true, ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging',
        ...(securityInfoFlag ? ['--enable-features=WebRequestSecurityInfo'] : [])]
    });
    const cdp = await context.browser().newBrowserCDPSession();
    ({ id: extension } = await cdp.send('Extensions.loadUnpacked', { path: dir }));
    await cdp.detach();
  } else {
    browser = await chromium.launch({
      ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
      headless: true
    });
    context = await browser.newContext();
  }
  const page = await context.newPage();
  page.on('console', message => {
    if (/GECKO-ERR|FAILED|EvalThrew/.test(message.text())) console.error(message.text());
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  if (ordered) await context.addCookies([{ name: 'host_canary', value: 'must-not-leak', url: origin }]);
  await page.goto(origin + '/' +
    (extension ? '?extension=' + extension : ''));
  await page.waitForFunction(() => window.ready || window.failure, null, { timeout: 180000 });
  const failure = await page.evaluate(() => window.failure);
  if (failure) throw Error(failure);
  const installed = await page.evaluate(() => gecko.evalChrome('outpost:fixture-install'));
  if (installed !== 'ok') throw Error('test fixture failed to install: ' + installed);
  await timed(page.evaluate(() => gecko.load('http://fixture.test/index')), 30000, 'fixture navigation');
  let title = '';
  for (let n = 0; n < 40; n++) {
    title = await page.evaluate(() => gecko.evalChrome('document.title'));
    if (title.includes('|')) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const stats = await page.evaluate(() => gecko.evalChrome('outpost:fixture-stats'));
  const order = await page.evaluate(() => gecko.evalChrome('outpost:fixture-order'));
  const cookieControl = await page.evaluate(() =>
    gecko.evalChrome("document.cookie='control=present; path=/'; document.cookie"));
  await timed(page.evaluate(() => gecko.load('http://fixture.test/login')), 30000, 'fixture redirect');
  const cookieResultText = await page.evaluate(() =>
    gecko.evalChrome("JSON.stringify({title:document.title,cookie:document.querySelector('#cookie')?.textContent,href:location.href})"));
  const cookieResult = JSON.parse(cookieResultText);
  let bridgeLogin = null;
  let restoredLogin = null;
  let httpsEvidence = null;
  assert.match(cookieControl, /control=present/);
  assert.equal(cookieResult.href, 'http://fixture.test/home');
  assert.match(cookieResult.cookie, /control=present/);
  if (ordered) {
    assert.equal(title, 'ERROR:TypeError|OK:synthetic fixture accepted');
    assert.equal(stats, '2,1', 'only the allowed POST should reach the bridge hook');
    assert.equal(order, 'OOP', 'preflight must precede the only allowed POST');
    assert.deepEqual(egressCases, [{ kind: 'allowed', body: 'synthetic-side-effect' }],
      'only the allowed request may reach the extension-backed endpoint');
    assert.match(cookieResult.cookie, /fixture_session=synthetic/);
    await timed(page.evaluate(() => gecko.load('http://fixture.test/bridge-login')), 30000, 'extension login');
    const bridgeTitle = await page.evaluate(() => gecko.evalChrome('document.title'));
    assert.equal(bridgeTitle, 'BRIDGE SESSION OK');
    bridgeLogin = bridgeTitle;
    assert.deepEqual(egressCases.slice(1), [
      { kind: 'login', body: 'alpha', cookie: '' },
      { kind: 'account', cookie: 'workspace_session=alpha' }
    ]);
    const hostCookies = await context.cookies(origin);
    assert.deepEqual(hostCookies.map(c => c.name), ['host_canary']);

    if (testHttps) {
      const external = await page.evaluate(async extension => {
        const run = url => chrome.runtime.sendMessage(extension, {
          type: 'fixture-request', url, method: 'GET'
        });
        return {
          valid: await run('https://example.com/'),
          expired: await run('https://expired.badssl.com/'),
          selfSigned: await run('https://self-signed.badssl.com/')
        };
      }, extension);
      assert.equal(external.valid.status, 200);
      assert.match(external.valid.body, /Example Domain/);
      assert.equal(external.expired.ok, false);
      assert.equal(external.selfSigned.ok, false);
      assert.match(external.expired.networkError || '', /^net::ERR_CERT_/);
      assert.match(external.selfSigned.networkError || '', /^net::ERR_CERT_/);
      await timed(page.evaluate(() => gecko.load('https://example.com/')), 30000, 'HTTPS navigation');
      const siteText = await page.evaluate(() => gecko.evalChrome(
        "JSON.stringify({href:location.href,title:document.title,secureContext:window.isSecureContext,body:document.body?.innerText?.slice(0,250)})"));
      const site = JSON.parse(siteText);
      assert.equal(site.href, 'https://example.com/');
      assert.equal(site.title, 'Example Domain');
      const channelSecurityInfo = await page.evaluate(() => gecko.evalChrome('outpost:fixture-security-info'));
      assert.equal(channelSecurityInfo, 'absent', 'fixture security state changed; reassess the release blocker');
      // Verify the local relay probe sees connections before using it to assert
      // that the failed certificate requests cannot fall back to the relay.
      const initialAttempts = relayConnectionAttempts;
      await page.evaluate(url => new Promise(resolve => {
        const socket = new WebSocket(url);
        socket.onerror = socket.onclose = () => resolve();
      }), origin.replace(/^http:/, 'ws:') + '/wisp/');
      assert.equal(relayConnectionAttempts, initialAttempts + 1, 'relay probe calibration failed');
      const beforeBadCertificates = relayConnectionAttempts;
      await timed(page.evaluate(() => gecko.load('https://expired.badssl.com/')), 30000, 'expired-certificate navigation');
      const expiredNavigationStatus = await page.evaluate(() => gecko.evalChrome('outpost:fixture-nav-status'));
      await timed(page.evaluate(() => gecko.load('https://self-signed.badssl.com/')), 30000, 'self-signed navigation');
      const selfSignedNavigationStatus = await page.evaluate(() => gecko.evalChrome('outpost:fixture-nav-status'));
      await new Promise(resolve => setTimeout(resolve, 500));
      const bridgeFailures = await page.evaluate(() => window.fixtureTransportFailures || []);
      assert.deepEqual(bridgeFailures.map(f => f.kind), ['expired', 'self-signed']);
      assert.match(bridgeFailures[0].networkError || '', /^net::ERR_CERT_/);
      assert.match(bridgeFailures[1].networkError || '', /^net::ERR_CERT_/);
      assert.equal(expiredNavigationStatus, 'failed');
      assert.equal(selfSignedNavigationStatus, 'failed');
      assert.equal(relayConnectionAttempts, beforeBadCertificates, 'invalid certificate fell back to relay');
      httpsEvidence = { validStatus: external.valid.status, hostSecurity: external.valid.security, expired: external.expired,
        selfSigned: external.selfSigned, gecko: site, channelSecurityInfo,
        badCertificateNavigations: bridgeFailures, expiredNavigationStatus, selfSignedNavigationStatus,
        relayFallbackAttempts: relayConnectionAttempts - beforeBadCertificates };
    }

    // The profile contains test data only. Copy its OPFS files to a separate
    // throwaway Chrome profile to test the Gecko cookie store itself. This is
    // not the product's encrypted workspace export/import implementation.
    await new Promise(resolve => setTimeout(resolve, 2000));
    const snapshot = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('outpost-fixture-profile');
      const result = [];
      let total = 0;
      async function visit(folder, parents = []) {
        for await (const [name, entry] of folder.entries()) {
          const current = [...parents, name];
          if (entry.kind === 'directory') { await visit(entry, current); continue; }
          const data = new Uint8Array(await (await entry.getFile()).arrayBuffer());
          total += data.length;
          if (total > 64 * 1024 * 1024) throw Error('fixture profile exceeds test limit');
          let binary = '';
          for (let i = 0; i < data.length; i += 16384)
            binary += String.fromCharCode(...data.subarray(i, i + 16384));
          result.push({ path: current, bytes: btoa(binary) });
        }
      }
      await visit(directory);
      return result;
    });
    assert.ok(snapshot.length > 0, 'expected synthetic Gecko profile files');
    await context.close();
    context = undefined;
    secondProfile = await fs.mkdtemp(path.join(dir, 'gecko-fixture-restore-profile-'));
    context = await chromium.launchPersistentContext(secondProfile, {
      ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
      headless: true, ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging',
        ...(securityInfoFlag ? ['--enable-features=WebRequestSecurityInfo'] : [])]
    });
    const cdp = await context.browser().newBrowserCDPSession();
    const restoredExtension = (await cdp.send('Extensions.loadUnpacked', { path: dir })).id;
    await cdp.detach();
    await context.addInitScript(seed => { globalThis.__fixtureSeed = seed; }, snapshot);
    const restoredPage = await context.newPage();
    await restoredPage.goto(origin + '/?extension=' + restoredExtension);
    await restoredPage.waitForFunction(() => window.ready || window.failure, null, { timeout: 180000 });
    const restoredFailure = await restoredPage.evaluate(() => window.failure);
    if (restoredFailure) throw Error(restoredFailure);
    assert.equal(await restoredPage.evaluate(() => gecko.evalChrome('outpost:fixture-install')), 'ok');
    await timed(restoredPage.evaluate(() => gecko.load('http://fixture.test/account')), 30000, 'restored account');
    restoredLogin = await restoredPage.evaluate(() => gecko.evalChrome('document.title'));
    assert.equal(restoredLogin, 'BRIDGE SESSION OK');
    assert.deepEqual(egressCases.at(-1), { kind: 'account', cookie: 'workspace_session=alpha' });
    assert.deepEqual(await context.cookies(origin), []);
  } else if (patched) {
    assert.equal(title, 'ERROR:TypeError|OK:fixture-cors');
    assert.equal(stats, '2,2');
    assert.equal(order, 'POPO', 'the observer currently sees POST before OPTIONS');
    assert.match(cookieResult.cookie, /fixture_session=synthetic/);
  } else {
    assert.equal(title, 'OK:fixture-cors|OK:fixture-cors', 'baseline CORS bypass reproduction changed');
    assert.equal(stats, '0,2', 'expected zero preflights and two POSTs in this baseline build');
    assert.equal(order, 'PP');
    assert.doesNotMatch(cookieResult.cookie, /fixture_session=synthetic/);
  }
  console.log(JSON.stringify({ build: ordered ? 'ordered fixture' : patched ? 'patched fixture' : 'baseline fixture',
    installed, corsTitle: title, preflightAndPostCounts: stats, observerOrder: order,
    egressCases, bridgeLogin, restoredLogin, httpsEvidence, cookieControl,
    redirectResult: cookieResult }, null, 2));
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  if (profile) await fs.rm(profile, { recursive: true, force: true });
  if (secondProfile) await fs.rm(secondProfile, { recursive: true, force: true });
}
