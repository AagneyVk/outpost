// Research-only: local WebSockets, synthetic cookies and a disposable profile.
// This fixture is not a production transport and never uses real credentials.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';

const dir = path.dirname(fileURLToPath(import.meta.url));
const addon = await fs.mkdtemp(path.join(dir, 'temporary-addon-'));
const profile = await fs.mkdtemp(path.join(dir, 'temporary-profile-'));
const observed = [], httpObserved = [];
let server, sockets, context;
try {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/http') return response.writeHead(404).end();
    httpObserved.push({ label: url.searchParams.get('label'), cookie: request.headers.cookie || '', origin: request.headers.origin || '' });
    const headers = { 'Access-Control-Allow-Origin': request.headers.origin || '*',
      'Access-Control-Allow-Credentials': 'true', 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' };
    if (['a-http-set', 'a-debug-set'].includes(url.searchParams.get('label'))) headers['Set-Cookie'] = [
      'preference=alpha; Secure; SameSite=None; Path=/',
      'http_token=synthetic; HttpOnly; Secure; SameSite=None; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/',
      'rejected_synthetic=bad; Domain=example.invalid; Secure; SameSite=None; Path=/'
    ];
    response.writeHead(200, headers).end('synthetic');
  });
  sockets = new WebSocketServer({ noServer: true });
  sockets.on('headers', (headers, request) => {
    const label = new URL(request.url, 'http://localhost').searchParams.get('label');
    if (label === 'a-seed' || label === 'b-seed')
      headers.push('Set-Cookie: workspace_session=' + (label === 'a-seed' ? 'alpha' : 'beta') + '; HttpOnly; Secure; SameSite=None; Path=/');
  });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/socket') return socket.destroy();
    observed.push({ label: url.searchParams.get('label'), cookie: request.headers.cookie || '', origin: request.headers.origin || '' });
    sockets.handleUpgrade(request, socket, head, connection => connection.on('message', bytes => connection.send(bytes, { binary: false })));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'ws://localhost:' + server.address().port + '/socket';
  await fs.writeFile(path.join(addon, 'manifest.json'), JSON.stringify({ manifest_version: 3,
    name: 'OUTPOST credentialless isolation research', version: '0.0.1', permissions: ['cookies', 'debugger', 'tabs', 'webRequest'],
    background: { service_worker: 'credentialless-listener.js' },
    host_permissions: ['http://localhost/*', 'https://localhost/*', 'ws://localhost/*'] }));
  await fs.copyFile(path.join(dir, 'credentialless-listener.js'), path.join(addon, 'credentialless-listener.js'));
  await fs.writeFile(path.join(addon, 'empty.html'), '<!doctype html><meta charset="utf-8"><title>Disposable fixture</title>');
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  await context.addCookies([{ name: 'host_canary', value: 'synthetic-only', domain: 'localhost', path: '/', sameSite: 'None', secure: true }]);
  assert.ok((await context.cookies()).some(cookie => cookie.name === 'host_canary'));
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: addon });
  await cdp.detach();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + id + '/empty.html');
  assert.equal(await page.evaluate(() => chrome.runtime.sendMessage('ping')), 'ready');
  assert.equal(await page.evaluate(() => 'credentialless' in HTMLIFrameElement.prototype), true, 'Chrome must support the feature for this test');
  async function frame(owner, credentialless) {
    const element = await owner.evaluateHandle(({ src, credentialless }) => {
      const iframe = document.createElement('iframe');
      iframe.credentialless = credentialless;
      iframe.src = src;
      document.body.append(iframe);
      return iframe;
    }, { src: 'chrome-extension://' + id + '/empty.html', credentialless });
    const child = await element.asElement().contentFrame();
    await child.waitForURL('chrome-extension://' + id + '/empty.html');
    return child;
  }
  const normal = await frame(page, false), isolated = await frame(page, true);
  const states = await Promise.all([normal.evaluate(() => window.credentialless), isolated.evaluate(() => window.credentialless)]);
  async function open(child, label) {
    const url = endpoint + '?' + new URLSearchParams({ label });
    assert.equal(await child.evaluate(url => new Promise(resolve => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 5000);
      socket.onopen = () => socket.send('synthetic');
      socket.onmessage = event => { clearTimeout(timer); socket.close(); resolve(event.data); };
      socket.onerror = () => { clearTimeout(timer); resolve('error'); };
    }), url), 'synthetic');
  }
  const secondPage = await context.newPage();
  await secondPage.goto('chrome-extension://' + id + '/empty.html');
  const second = await frame(secondPage, true);
  const frameIds = await Promise.all([normal, isolated, second].map(child => child.evaluate(() => chrome.runtime.sendMessage('whoami'))));
  await open(normal, 'normal-before');
  await open(isolated, 'a-seed');
  await open(isolated, 'a-follow');
  const sameDocument = await frame(page, true);
  await open(sameDocument, 'a-sibling');
  await open(second, 'b-before');
  await open(second, 'b-seed');
  await open(second, 'b-follow');
  await open(isolated, 'a-after-b');
  async function fetchProbe(child, label) {
    const url = 'http://localhost:' + server.address().port + '/http?' + new URLSearchParams({ label });
    assert.equal(await child.evaluate(async url => (await fetch(url, { credentials: 'include', cache: 'no-store' })).text(), url), 'synthetic');
  }
  await fetchProbe(normal, 'normal-http');
  await fetchProbe(isolated, 'a-http');
  await fetchProbe(second, 'b-http');
  await fetchProbe(isolated, 'a-http-set');
  assert.deepEqual(httpObserved.map(({ label, cookie }) => [label, cookie]), [
    ['normal-http', 'host_canary=synthetic-only'], ['a-http', 'workspace_session=alpha'], ['b-http', 'workspace_session=beta'],
    ['a-http-set', 'workspace_session=alpha']
  ]);
  const responseEvents = await page.evaluate(() => chrome.runtime.sendMessage('events'));
  const seedEvents = responseEvents.filter(event => /[?&]label=(?:a|b)-seed(?:&|$)/.test(event.url));
  assert.equal(seedEvents.length, 2);
  for (const [index, name] of [[1, 'alpha'], [2, 'beta']]) {
    const event = seedEvents.find(item => item.url.includes('label=' + (name === 'alpha' ? 'a' : 'b') + '-seed'));
    assert.deepEqual([event.tabId, event.frameId], [frameIds[index].tabId, frameIds[index].frameId]);
    assert.ok(event.headers.some(header => header.value.startsWith('workspace_session=' + name + ';')));
  }
  const httpSetEvent = responseEvents.find(event => event.url.includes('label=a-http-set'));
  assert.deepEqual([httpSetEvent.tabId, httpSetEvent.frameId], [frameIds[1].tabId, frameIds[1].frameId]);
  assert.equal(httpSetEvent.headers.length, 3);
  assert.ok(httpSetEvent.headers.some(header => header.value.includes('Wed, 21 Oct 2037')));
  assert.ok(httpSetEvent.headers.some(header => header.value.startsWith('rejected_synthetic=')));
  const cookieApi = await page.evaluate(async () => (await chrome.cookies.getAll({ domain: 'localhost' })).map(cookie => ({
    name: cookie.name, value: cookie.value, partitionKey: cookie.partitionKey || null
  })));
  assert.ok(cookieApi.some(cookie => cookie.name === 'host_canary'), 'cookie API control must see the synthetic host cookie');
  assert.equal(cookieApi.some(cookie => cookie.name === 'workspace_session'), false, 'default cookie API lookup does not expose these isolated cookies');
  const pageCdp = await context.newCDPSession(page);
  const pageCookies = (await pageCdp.send('Network.getCookies', { urls: ['https://localhost/'] })).cookies.map(cookie => ({
    name: cookie.name, value: cookie.value, partitionKey: cookie.partitionKey || null, partitionKeyOpaque: cookie.partitionKeyOpaque || false
  }));
  await pageCdp.detach();
  const storageCdp = await context.browser().newBrowserCDPSession();
  const storageCookies = (await storageCdp.send('Storage.getCookies')).cookies.map(cookie => ({
    name: cookie.name, value: cookie.value, partitionKey: cookie.partitionKey || null, partitionKeyOpaque: cookie.partitionKeyOpaque || false
  }));
  await storageCdp.detach();
  assert.equal(storageCookies.some(cookie => cookie.name === 'rejected_synthetic'), false, 'observing Set-Cookie does not mean Chrome accepted it');
  assert.ok(['alpha', 'beta'].every(value => storageCookies.some(cookie => cookie.name === 'workspace_session' && cookie.value === value)));
  const extensionDebuggerCookies = await page.evaluate(async () => {
    const target = { tabId: (await chrome.tabs.getCurrent()).id };
    await chrome.debugger.attach(target, '1.3');
    try {
      const result = await chrome.debugger.sendCommand(target, 'Storage.getCookies');
      return result.cookies.map(cookie => ({ name: cookie.name, value: cookie.value,
        partitionKey: cookie.partitionKey || null, partitionKeyOpaque: cookie.partitionKeyOpaque || false }));
    } finally { await chrome.debugger.detach(target); }
  });
  assert.ok(extensionDebuggerCookies.some(cookie => cookie.name === 'host_canary'));
  const workspaceCookies = extensionDebuggerCookies.filter(cookie => cookie.name === 'workspace_session');
  assert.deepEqual(workspaceCookies.map(cookie => cookie.value).sort(), ['alpha', 'beta']);
  assert.ok(workspaceCookies.every(cookie => cookie.partitionKey === null && !cookie.partitionKeyOpaque), 'fixture expects the observed ambiguous partition metadata');
  const debuggerTarget = await page.evaluate(async () => {
    const target = { tabId: (await chrome.tabs.getCurrent()).id };
    globalThis.syntheticNetworkEvents = [];
    globalThis.syntheticNetworkListener = (source, method, params) => {
      if (source.tabId === target.tabId && ['Network.requestWillBeSent', 'Network.responseReceivedExtraInfo'].includes(method))
        syntheticNetworkEvents.push({ method, params });
    };
    chrome.debugger.onEvent.addListener(syntheticNetworkListener);
    await chrome.debugger.attach(target, '1.3');
    await chrome.debugger.sendCommand(target, 'Network.enable');
    return target;
  });
  await fetchProbe(isolated, 'a-debug-set');
  await page.waitForFunction(() => syntheticNetworkEvents.some(event => event.method === 'Network.responseReceivedExtraInfo' &&
    (event.params.blockedCookies || []).some(cookie => cookie.cookieLine?.startsWith('rejected_synthetic='))), null, { timeout: 10000 });
  const rejectedBinding = await page.evaluate(async target => {
    const request = syntheticNetworkEvents.find(event => event.method === 'Network.requestWillBeSent' && event.params.request.url.includes('label=a-debug-set'));
    const response = syntheticNetworkEvents.find(event => event.method === 'Network.responseReceivedExtraInfo' && event.params.requestId === request?.params.requestId);
    await chrome.debugger.detach(target);
    chrome.debugger.onEvent.removeListener(syntheticNetworkListener);
    return { frameId: request?.params.frameId, blocked: response?.params.blockedCookies || [] };
  }, debuggerTarget);
  assert.ok(rejectedBinding.frameId, 'request must include a debugger frame ID');
  assert.ok(rejectedBinding.blocked.some(cookie => cookie.cookieLine.startsWith('rejected_synthetic=') && cookie.blockedReasons.length));
  let frameCdpCookies;
  try {
    const frameCdp = await context.newCDPSession(isolated);
    const result = await frameCdp.send('Network.getCookies', { urls: ['http://localhost:' + server.address().port + '/'] });
    frameCdpCookies = result.cookies.map(cookie => ({ name: cookie.name, value: cookie.value, partitionKey: cookie.partitionKey || null, partitionKeyOpaque: cookie.partitionKeyOpaque || false }));
    await frameCdp.detach();
  } catch (error) { frameCdpCookies = { error: String(error.message || error) }; }
  await open(normal, 'normal-after');
  await page.reload();
  const afterReload = await frame(page, true);
  await open(afterReload, 'a-after-reload');
  await open(second, 'b-after-a-reload');
  const expected = [
    ['normal-before', 'host_canary=synthetic-only'], ['a-seed', ''], ['a-follow', 'workspace_session=alpha'],
    ['a-sibling', 'workspace_session=alpha'], ['b-before', ''], ['b-seed', ''], ['b-follow', 'workspace_session=beta'],
    ['a-after-b', 'workspace_session=alpha'], ['normal-after', 'host_canary=synthetic-only'],
    ['a-after-reload', ''], ['b-after-a-reload', 'workspace_session=beta']
  ];
  assert.deepEqual(states, [false, true]);
  assert.deepEqual(observed.map(({ label, cookie }) => [label, cookie]), expected);
  assert.ok(observed.every(item => item.origin === 'chrome-extension://' + id), 'site sees the extension origin in the handshake');
  console.log(JSON.stringify({ chrome: context.browser().version(), frameCredentiallessFlags: states,
    hostCookieIsolated: true, isolatedSessionRetained: true, siblingFramesShareSession: true,
    otherTopLevelIsolated: true, reloadDiscardedSession: true, siteSeesExtensionOrigin: true,
    syntheticHttpAndWebSocketCookiesIsolated: true, responseEventsBoundToFrames: true,
    rejectedCookieAlsoAppearedInResponseEvent: true, defaultCookieApiOnlySawHostCookie: true,
    debuggerReportedRejectedCookieOnSameHttpRequest: true,
    debuggerListMixedHostAndWorkspaces: true, debuggerListDidNotIdentifyTheirPartitions: true,
    frameDebuggerSession: frameCdpCookies.error || 'available',
    note: 'Local synthetic evidence only; a positive result would not establish Gecko integration or production safety.' }, null, 2));
} finally {
  if (context) await context.close();
  if (sockets) await new Promise(resolve => sockets.close(resolve));
  if (server) await new Promise(resolve => server.close(resolve));
  for (const temporary of [addon, profile]) {
    if (path.dirname(temporary) !== dir || !/^temporary-(addon|profile)-/.test(path.basename(temporary))) throw Error('Invalid temporary path');
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
