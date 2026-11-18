// Loopback-only research: synthetic cookies, disposable profiles and a private
// self-signed certificate. Never use this fixture for real websites or secrets.
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';

const dir = path.dirname(fileURLToPath(import.meta.url));
const temporary = await fs.mkdtemp(path.join(dir, 'temporary-wss-'));
const addon = path.join(temporary, 'addon');
const guardedAddon = path.join(temporary, 'guarded-addon');
const contexts = [];
const observed = [];
const observedMarkers = [];
let server, sockets;
const exec = promisify(execFile);
const openssl = process.env.OUTPOST_OPENSSL || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
try {
  await fs.mkdir(addon);
  await fs.mkdir(guardedAddon);
  const keyPath = path.join(temporary, 'key.pem'), certPath = path.join(temporary, 'cert.pem');
  await exec(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', keyPath, '-out', certPath],
    { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  const cert = await fs.readFile(certPath), key = await fs.readFile(keyPath);
  server = https.createServer({ key, cert }, (_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Loopback fixture</title>'));
  sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/socket') return socket.destroy();
    observed.push(req.headers.cookie || '');
    observedMarkers.push(req.headers['x-outpost-fixture'] || '');
    sockets.handleUpgrade(req, socket, head, ws => ws.on('message', data => ws.send(data, { binary: false })));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'wss://localhost:' + server.address().port + '/socket';
  for (const target of [addon, guardedAddon]) for (const name of ['race.html', 'race.mjs']) await fs.copyFile(path.join(dir, name), path.join(target, name));
  const manifest = { manifest_version: 3,
    name: 'OUTPOST local WSS research fixture', version: '0.0.1',
    permissions: ['tabs', 'debugger', 'declarativeNetRequest'], host_permissions: ['wss://localhost/*'] };
  await fs.writeFile(path.join(addon, 'manifest.json'), JSON.stringify(manifest));
  // A public key pins the disposable extension ID, allowing a static rule to
  // match only its own initiator. The generated private key is never persisted.
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const id = [...createHash('sha256').update(publicDer).digest().subarray(0, 16)]
    .flatMap(byte => [String.fromCharCode(97 + (byte >> 4)), String.fromCharCode(97 + (byte & 15))]).join('');
  await fs.writeFile(path.join(guardedAddon, 'rules.json'), JSON.stringify([{ id: 1, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'remove' }] },
    condition: { initiatorDomains: [id], resourceTypes: ['websocket'] } }]));
  await fs.writeFile(path.join(guardedAddon, 'manifest.json'), JSON.stringify({ ...manifest,
    name: 'OUTPOST guarded local WSS research fixture', key: publicDer.toString('base64'),
    declarative_net_request: { rule_resources: [{ id: 'baseline', enabled: true, path: 'rules.json' }] } }));

  async function openFixture(label, allowLocalhost, guarded) {
    const profile = path.join(temporary, label);
    const context = await chromium.launchPersistentContext(profile, {
      ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
      headless: true, ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', ...(allowLocalhost ? ['--allow-insecure-localhost'] : [])]
    });
    contexts.push(context);
    await context.addCookies([{ name: 'host_canary', value: 'synthetic-only', domain: 'localhost', path: '/', sameSite: 'None', secure: true }]);
    assert.ok((await context.cookies()).some(cookie => cookie.name === 'host_canary'));
    const cdp = await context.browser().newBrowserCDPSession();
    const { id: loadedId } = await cdp.send('Extensions.loadUnpacked', { path: guarded ? guardedAddon : addon });
    if (guarded) assert.equal(loadedId, id);
    await cdp.detach();
    const page = await context.newPage();
    await page.goto('chrome-extension://' + loadedId + '/race.html?' + new URLSearchParams({ url, scope: 'tab' }));
    return { context, page };
  }

  const untrusted = await openFixture('untrusted-profile', false, false);
  assert.equal(await untrusted.page.evaluate(() => fixtureOpenSocket()), 'socket error');
  assert.deepEqual(observed, [], 'an untrusted certificate must not reach the WebSocket upgrade');
  await untrusted.context.close();

  // This test-only localhost exception permits self-signed certificates on
  // localhost; it does not demonstrate normal public-CA validation.
  const unguarded = await openFixture('unguarded-profile', true, false);
  assert.equal(await unguarded.page.evaluate(() => fixtureOpenSocket()), 'echo'); // unsafe synthetic control
  const debugTarget = await unguarded.page.evaluate(async () => {
    const target = { tabId: (await chrome.tabs.getCurrent()).id };
    await chrome.debugger.attach(target, '1.3');
    await chrome.debugger.sendCommand(target, 'Network.enable');
    await chrome.debugger.sendCommand(target, 'Network.setExtraHTTPHeaders', { headers: { Cookie: 'workspace_session=alpha', 'X-Outpost-Fixture': 'synthetic-one' } });
    return target;
  });
  assert.equal(await unguarded.page.evaluate(() => fixtureOpenSocket()), 'echo');
  await unguarded.page.evaluate(async target => {
    await chrome.debugger.sendCommand(target, 'Network.setExtraHTTPHeaders', { headers: { Cookie: '', 'X-Outpost-Fixture': 'synthetic-two' } });
  }, debugTarget);
  assert.equal(await unguarded.page.evaluate(() => fixtureOpenSocket()), 'echo');
  await unguarded.page.evaluate(target => chrome.debugger.detach(target), debugTarget);
  assert.equal(await unguarded.page.evaluate(() => fixtureOpenSocket()), 'echo');
  console.log('Debugger-header synthetic control:', JSON.stringify({ cookies: observed, markers: observedMarkers }));
  assert.deepEqual(observed, Array(4).fill('host_canary=synthetic-only'));
  assert.deepEqual(observedMarkers, ['', 'synthetic-one', 'synthetic-two', '']);
  await unguarded.context.close();

  const trusted = await openFixture('guarded-profile', true, true);
  const { page, context } = trusted;
  assert.deepEqual(await page.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets()), ['baseline']);
  assert.equal(await page.evaluate(() => fixtureOpenSocket()), 'echo');
  for (const cookie of ['', 'workspace_session=alpha', 'workspace_session=beta']) {
    await page.evaluate(value => fixtureInstallRule(value), cookie);
    assert.equal(await page.evaluate(() => fixtureOpenSocket()), 'echo');
    await page.evaluate(() => fixtureRemoveRule());
  }
  assert.equal(await page.evaluate(() => fixtureOpenSocket()), 'echo');
  // Deliberately leave a synthetic override behind, then reload the same tab.
  // The static guard cannot protect against this higher-priority stale rule.
  await page.evaluate(() => fixtureInstallRule('workspace_session=alpha'));
  await page.reload();
  assert.equal((await page.evaluate(() => fixtureRuleIds())).length, 1);
  assert.equal(await page.evaluate(() => fixtureOpenSocket()), 'echo');
  await page.evaluate(() => fixtureRemoveRule());
  assert.equal(await page.evaluate(() => fixtureOpenSocket()), 'echo');
  // The origin-scoped baseline must not change normal host-browser requests.
  const ordinary = await context.newPage();
  await ordinary.goto('https://localhost:' + server.address().port + '/');
  assert.equal(await ordinary.evaluate(url => new Promise(resolve => {
    const socket = new WebSocket(url);
    socket.onopen = () => socket.send('echo');
    socket.onmessage = event => { socket.close(); resolve(event.data); };
    socket.onerror = () => resolve('socket error');
  }), url), 'echo');
  assert.deepEqual(observed.slice(4), ['', '', 'workspace_session=alpha', 'workspace_session=beta', '',
    'workspace_session=alpha', '', 'host_canary=synthetic-only']);
  assert.deepEqual(await page.evaluate(() => fixtureRuleIds()), []);
  const hostCookies = await context.cookies();
  assert.ok(hostCookies.some(cookie => cookie.name === 'host_canary'));
  assert.equal(hostCookies.some(cookie => cookie.name === 'workspace_session'), false);
  console.log(JSON.stringify({ chrome: context.browser().version(), untrustedCertificateRejected: true,
    unprotectedSyntheticCookieObserved: true, staticBaselineRemovedCookie: true, emptyWorkspaceRemovedCookie: true,
    workspaceCookiesReachedServer: true, hostJarUnchanged: true, remainingRules: 0,
    normalHostTabUnaffected: true, staleSyntheticWorkspaceRuleSurvivedReload: true,
    note: 'Loopback WSS only; a test-only localhost certificate exception was required.' }, null, 2));
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  if (sockets) await new Promise(resolve => sockets.close(resolve));
  if (server) await new Promise(resolve => server.close(resolve));
  if (path.dirname(temporary) !== dir || !path.basename(temporary).startsWith('temporary-wss-')) throw Error('Invalid temporary path');
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
