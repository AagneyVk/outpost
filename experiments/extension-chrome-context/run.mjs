import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const fixtureBuild = process.env.OUTPOST_FIXTURE_BUILD && path.resolve(process.env.OUTPOST_FIXTURE_BUILD);
const delegated = process.env.OUTPOST_DELEGATED_TEST === '1';
const stateOnly = process.env.OUTPOST_STATE_TEST === '1';
const tamper = process.env.OUTPOST_STATE_TAMPER === '1';
if (delegated && stateOnly || tamper && !stateOnly) throw Error('Choose one HTTPS fixture mode');
if (stateOnly && !fixtureBuild) throw Error('State test requires its matching test engine');
if (delegated && !fixtureBuild) throw Error('Delegated test requires its matching test engine');
const addon = await fs.mkdtemp(path.join(dir, 'temporary-addon-'));
const profile = await fs.mkdtemp(path.join(dir, 'temporary-profile-'));
let context, server;
try {
  for (const name of ['index.html', 'page.mjs', 'https-fixture.mjs', 'response-binding.mjs'])
    await fs.copyFile(path.join(dir, name), path.join(addon, name));
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  if (fixtureBuild) {
    manifest.permissions = ['debugger', 'tabs', ...(delegated ? ['webRequest'] : [])];
    manifest.host_permissions = ['https://example.com/*', 'https://expired.badssl.com/*', 'https://self-signed.badssl.com/*'];
  }
  await fs.writeFile(path.join(addon, 'manifest.json'), JSON.stringify(manifest));
  // The web loader creates blob: scripts, which extension CSP disallows. Extract
  // the exact bundled glue into a packaged file, without evaluating it here.
  const bundle = await fs.readFile(fixtureBuild ? path.join(fixtureBuild, 'gecko.js') :
    path.join(root, 'public/gecko-lab/engine/gecko-input-v7.js'), 'utf8');
  const prefix = 'const geckosource_namespaceObject = ';
  const begin = bundle.indexOf(prefix);
  const end = bundle.indexOf('\n', begin);
  if (begin < 0 || end < 0) throw Error('Unexpected Gecko bundle format');
  const encodedGlue = bundle.slice(begin + prefix.length, end).trim().replace(/;$/, '');
  const glue = JSON.parse(encodedGlue);
  const blobLoader = 'const geckoBlobUrl = ()=>_geckoUrl ??= toBlobUrl(geckosource_namespaceObject);';
  if (!bundle.includes(blobLoader)) throw Error('Unexpected Gecko loader');
  const packaged = (bundle.slice(0, begin) + bundle.slice(end + 1)).replace(blobLoader,
    "const geckoBlobUrl = ()=>chrome.runtime.getURL('engine-glue.js');");
  await fs.writeFile(path.join(addon, 'gecko.js'), packaged);
  await fs.writeFile(path.join(addon, 'engine-glue.js'), glue);
  await fs.copyFile(fixtureBuild ? path.join(fixtureBuild, 'gecko.wasm.zst') :
    path.join(root, 'public/gecko-lab/engine/gecko-input-v7.wasm.zst'), path.join(addon, 'gecko.wasm.zst'));
  server = http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Attacker fixture</title>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const args = ['--enable-unsafe-extension-debugging'];
  if (delegated && process.env.OUTPOST_ENABLE_SECURITY_INFO === '1') args.push('--enable-features=WebRequestSecurityInfo');
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: addon });
  await cdp.detach();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 500)); });
  await page.goto('chrome-extension://' + id + '/index.html' + (fixtureBuild ? (stateOnly ? (tamper ? '?mode=state-tamper' : '?mode=state') : delegated ? '?mode=delegated' : '?mode=https') : ''));
  await page.waitForFunction(() => ['complete', 'failed'].includes(globalThis.fixtureResult?.phase), null, { timeout: 180000 });
  const result = await page.evaluate(() => globalThis.fixtureResult);
  const attacker = await context.newPage();
  await attacker.goto('http://127.0.0.1:' + server.address().port + '/');
  const boundary = await attacker.evaluate(async id => {
    const runtime = typeof chrome?.runtime?.sendMessage;
    let messaging = 'unavailable';
    if (runtime === 'function') {
      try { await chrome.runtime.sendMessage(id, { type: 'outpost-test-response', body: 'forged' }); messaging = 'accepted'; }
      catch { messaging = 'rejected'; }
    }
    let read = 'unexpected success';
    try { await fetch('chrome-extension://' + id + '/index.html'); }
    catch { read = 'rejected'; }
    return { messaging, read };
  }, id);
  console.log(JSON.stringify({ chrome: context.browser().version(), result, boundary, errors: errors.slice(-10) }, null, 2));
  assert.equal(result.crossOriginIsolated, true);
  assert.equal(result.sharedArrayBuffer, 'function');
  assert.equal(result.suspending, 'function');
  assert.equal(result.promising, 'function');
  const expectMissingInfo = process.env.OUTPOST_EXPECT_MISSING_INFO === '1';
  if (tamper) {
    assert.equal(result.phase, 'failed');
    assert.match(result.error, /Response body did not match the network request/);
  } else if (expectMissingInfo) {
    assert.equal(result.phase, 'failed');
    assert.match(result.error, /Missing request-bound HTTPS evidence/);
  } else {
    assert.equal(result.phase, 'complete');
    assert.equal(result.document, 'OUTPOST isolated fixture');
  }
  if (fixtureBuild && !expectMissingInfo && !tamper) {
    assert.equal(result.transport?.hostSecure, true);
    assert.equal(result.transport?.bodyMatched, true);
    assert.equal(result.transport?.expiredRejected, true);
    assert.equal(result.transport?.selfSignedRejected, true);
    if (delegated) assert.equal(result.transport?.requestBoundCertificate, true);
    if (stateOnly) {
      assert.equal(result.transport?.requestBoundState, true);
      assert.equal(result.transport?.certificateAvailable, false);
      assert.equal(result.certificate, 'absent');
      assert.equal(result.beforeHsts, 'absent');
      assert.equal(result.afterHsts, 'present');
    }
    if (!delegated && !stateOnly) assert.equal(result.navigation, process.env.OUTPOST_EXPECT_REJECTION === '1' ? 'failed' : 'ok');
    if (process.env.OUTPOST_EXPECT_ERROR) {
      assert.ok(errors.some(message => message.includes('OUTPOST_FIXTURE_CERT_VERIFY_RESULT=' + process.env.OUTPOST_EXPECT_ERROR)),
        'Expected certificate verification error was not observed');
    }
    if (process.env.OUTPOST_EXPECT_REJECTION !== '1') {
      assert.equal(result.httpsTitle, 'Example Domain');
      assert.equal(result.securityInfo, 'present');
      assert.equal(result.httpsDocument.href, 'https://example.com/');
      assert.equal(result.httpsDocument.secureContext, true);
      if (delegated) assert.equal(result.geckoFingerprint, result.transport.leafFingerprint);
    }
  }
  assert.notEqual(boundary.messaging, 'accepted');
  assert.equal(boundary.read, 'rejected');
} finally {
  if (context) await context.close();
  if (server) await new Promise(resolve => server.close(resolve));
  for (const temporary of [addon, profile]) {
    if (path.dirname(temporary) !== dir) throw Error('Invalid temporary path');
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
