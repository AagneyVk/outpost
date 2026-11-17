import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const fixtureBuild = process.env.OUTPOST_FIXTURE_BUILD && path.resolve(process.env.OUTPOST_FIXTURE_BUILD);
const directLogout = process.env.OUTPOST_PUBLIC_DEMO_LOGOUT_DIRECT === '1';
const publicLogout = directLogout || process.env.OUTPOST_PUBLIC_DEMO_LOGOUT === '1';
const publicDemo = publicLogout || process.env.OUTPOST_PUBLIC_DEMO_FORM === '1';
const wrongSignIn = process.env.OUTPOST_LOCAL_SIGNIN_WRONG === '1';
const formSignIn = wrongSignIn || process.env.OUTPOST_LOCAL_SIGNIN_FORM === '1';
const signInTest = formSignIn || process.env.OUTPOST_LOCAL_SIGNIN === '1';
const delegated = process.env.OUTPOST_DELEGATED_TEST === '1';
const internal = process.env.OUTPOST_INTERNAL_TEST === '1';
const stateOnly = internal || process.env.OUTPOST_STATE_TEST === '1';
const tamper = process.env.OUTPOST_STATE_TAMPER === '1';
const noEvidence = process.env.OUTPOST_STATE_NO_EVIDENCE === '1';
const noScriptEvidence = process.env.OUTPOST_INTERNAL_NO_SCRIPT_EVIDENCE === '1';
if (delegated && stateOnly || (tamper || noEvidence) && !stateOnly || tamper && noEvidence || noScriptEvidence && (!internal || tamper || noEvidence)) throw Error('Choose one HTTPS fixture mode');
if (stateOnly && !fixtureBuild) throw Error('State test requires its matching test engine');
if (signInTest && (!fixtureBuild || stateOnly || delegated)) throw Error('Sign-in test requires its own fixture mode and matching engine');
if (publicDemo && (!fixtureBuild || stateOnly || delegated || signInTest)) throw Error('Public demo requires its own fixture mode and matching engine');
if (delegated && !fixtureBuild) throw Error('Delegated test requires its matching test engine');
const addon = await fs.mkdtemp(path.join(dir, 'temporary-addon-'));
const profile = await fs.mkdtemp(path.join(dir, 'temporary-profile-'));
let context, server;
try {
  for (const name of ['index.html', 'page.mjs', 'https-fixture.mjs', 'response-binding.mjs', 'local-signin.mjs', 'public-signin.mjs'])
    await fs.copyFile(path.join(dir, name), path.join(addon, name));
  await fs.copyFile(path.join(root, 'experiments/extension-request-isolation/redirect-binding.mjs'), path.join(addon, 'redirect-binding.mjs'));
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  if (fixtureBuild) {
    manifest.permissions = ['debugger', 'tabs', ...(delegated ? ['webRequest'] : [])];
    manifest.host_permissions = publicDemo ? ['https://practice.expandtesting.com/*'] : signInTest ? ['http://127.0.0.1/*'] :
      ['https://example.com/*', 'https://expired.badssl.com/*', 'https://self-signed.badssl.com/*'];
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
  const observed = [];
  server = http.createServer((req, res) => {
    if (signInTest && ['/login', '/authenticate', '/account'].includes(req.url)) {
      const item = { path: req.url, method: req.method, cookie: req.headers.cookie || '', marker: req.headers['x-outpost-fixture-id'] || '' };
      observed.push(item);
      if (req.url === '/login') {
        if (formSignIn) return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
          '<!doctype html><title>Fixture sign in</title><form method="post" action="/authenticate">' +
          '<input name="username" value="demo"><input name="password" value="' + (wrongSignIn ? 'wrong' : 'synthetic') + '" type="password"><button>Sign in</button></form>');
        return res.writeHead(302, { Location: '/account', 'Set-Cookie': 'workspace_session=alpha; HttpOnly; Path=/' }).end();
      }
      if (req.url === '/authenticate') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        return req.on('end', () => {
          item.body = body;
          if (req.method !== 'POST' || body !== 'username=demo&password=synthetic') return res.writeHead(401).end();
          res.writeHead(302, { Location: '/account', 'Set-Cookie': 'workspace_session=alpha; HttpOnly; Path=/' }).end();
        });
      }
      const signedIn = req.headers.cookie === 'workspace_session=alpha';
      return res.writeHead(signedIn ? 200 : 401, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<!doctype html><title>Fixture signed ' + (signedIn ? 'in' : 'out') + '</title>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Attacker fixture</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const args = ['--enable-unsafe-extension-debugging'];
  if (delegated && process.env.OUTPOST_ENABLE_SECURITY_INFO === '1') args.push('--enable-features=WebRequestSecurityInfo');
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args
  });
  const fixtureOrigin = 'http://127.0.0.1:' + server.address().port;
  if (signInTest) await context.addCookies([{ name: 'host_canary', value: 'must-not-leak', url: fixtureOrigin }]);
  if (publicDemo) await context.addCookies([{ name: 'host_canary', value: 'must-not-leak', domain: 'practice.expandtesting.com', path: '/', secure: true, sameSite: 'None' }]);
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: addon });
  await cdp.detach();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 500)); });
  const stateMode = internal ? 'internal' : 'state';
  const query = publicDemo ? (directLogout ? '?mode=public-demo-logout-direct' : publicLogout ? '?mode=public-demo-logout' : '?mode=public-demo') : signInTest ? '?' + new URLSearchParams({ mode: wrongSignIn ? 'signin-form-bad' : formSignIn ? 'signin-form' : 'signin', origin: fixtureOrigin }) :
    fixtureBuild ? (stateOnly ? '?mode=' + stateMode + (tamper ? '-tamper' : noEvidence ? '-no-evidence' : noScriptEvidence ? '-no-script-evidence' : '') : delegated ? '?mode=delegated' : '?mode=https') : '';
  await page.goto('chrome-extension://' + id + '/index.html' + query);
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
  console.log(JSON.stringify({ chrome: context.browser().version(), result, boundary, observed, errors: errors.slice(-10) }, null, 2));
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
  if (publicDemo) {
    assert.deepEqual(result.publicErrors, []);
    assert.deepEqual(result.publicDocument, { href: 'https://practice.expandtesting.com/secure', success: true, logout: true });
    assert.equal(result.publicSecurityInfo, 'present');
    assert.deepEqual(result.publicTransport.requests.map(item => [item.path, item.method, item.status]), [
      ['/login', 'GET', 200], ['/authenticate', 'POST', 302], ['/secure', 'GET', 200],
      ...(publicLogout ? [['/logout', 'GET', 302], ['/secure', 'GET', 302]] : [])
    ]);
    assert.ok(result.publicTransport.requests.every(item => item.secure && !item.hostCookieSent));
    assert.equal(result.publicTransport.requests[1].redirectBlocked, true);
    if (publicLogout) {
      assert.deepEqual(result.afterLogout, { href: 'https://practice.expandtesting.com/login', loginForm: true });
      assert.deepEqual(result.afterRevisit, { href: 'https://practice.expandtesting.com/login', loginForm: true, logout: false });
      assert.equal(result.publicTransport.requests[3].redirectBlocked, true);
      assert.equal(result.publicTransport.requests[4].redirectBlocked, true);
    }
    const hostCookies = await context.cookies('https://practice.expandtesting.com');
    assert.deepEqual(hostCookies.map(cookie => cookie.name), ['host_canary']);
  }
  if (signInTest) {
    assert.deepEqual(result.signInErrors, []);
    if (wrongSignIn) {
      assert.notEqual(result.signInDocument.title, 'Fixture signed in');
      assert.notEqual(result.signInDocument.href, 'http://fixture.test/account');
      assert.deepEqual(result.signInTransport.requests, [{ path: '/login', method: 'GET', cookieSent: false, status: 200 }]);
      assert.deepEqual(observed.map(item => item.path), ['/login']);
    } else {
      assert.deepEqual(result.signInDocument, { href: 'http://fixture.test/account', title: 'Fixture signed in' });
      assert.deepEqual(result.signInTransport.requests, formSignIn ? [
      { path: '/login', method: 'GET', cookieSent: false, status: 200 },
      { path: '/authenticate', method: 'POST', cookieSent: false, status: 302 },
      { path: '/account', method: 'GET', cookieSent: true, status: 200 }
    ] : [
      { path: '/login', method: 'GET', cookieSent: false, status: 302 },
      { path: '/account', method: 'GET', cookieSent: true, status: 200 }
      ]);
      if (formSignIn) assert.equal(observed.find(item => item.path === '/authenticate')?.body, 'username=demo&password=synthetic');
    }
    assert.ok(observed.every(item => !item.marker && !item.cookie.includes('host_canary')));
    assert.equal((await context.cookies()).some(cookie => cookie.name === 'host_canary'), true);
    assert.equal((await context.cookies()).some(cookie => cookie.name === 'workspace_session'), false);
  }
  if (fixtureBuild && !signInTest && !publicDemo && !expectMissingInfo && !tamper) {
    assert.equal(result.transport?.hostSecure, true);
    assert.equal(result.transport?.bodyMatched, true);
    assert.equal(result.transport?.expiredRejected, true);
    assert.equal(result.transport?.selfSignedRejected, true);
    if (delegated) assert.equal(result.transport?.requestBoundCertificate, true);
    if (stateOnly) {
      assert.equal(result.transport?.requestBoundState, true);
      assert.equal(result.transport?.certificateAvailable, false);
      assert.equal(result.beforeHsts, 'absent');
      if (internal) assert.equal(result.spoofHeader, 'present');
      if (noEvidence) {
        assert.equal(result.transport.evidenceSuppressed, true);
        assert.equal(result.navigation, 'failed');
        assert.equal(result.securityInfo, 'absent');
        assert.equal(result.afterHsts, 'absent');
      } else {
        assert.equal(result.certificate, 'absent');
        assert.equal(result.afterHsts, 'present');
        if (internal) {
          assert.equal(result.navigation, noScriptEvidence ? 'failed' : 'ok');
          assert.deepEqual(result.transport.resources, [
            { url: 'https://example.com/', status: 200 },
            { url: 'https://example.com/s.js', status: 200 }
          ]);
          assert.deepEqual(result.transport.suppressedURLs, noScriptEvidence ? ['https://example.com/s.js'] : []);
        }
      }
    }
    if (!delegated && !stateOnly) assert.equal(result.navigation, process.env.OUTPOST_EXPECT_REJECTION === '1' ? 'failed' : 'ok');
    if (process.env.OUTPOST_EXPECT_ERROR) {
      assert.ok(errors.some(message => message.includes('OUTPOST_FIXTURE_CERT_VERIFY_RESULT=' + process.env.OUTPOST_EXPECT_ERROR)),
        'Expected certificate verification error was not observed');
    }
    if (process.env.OUTPOST_EXPECT_REJECTION !== '1' && !noEvidence) {
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
