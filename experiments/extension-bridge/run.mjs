import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const dir = path.dirname(fileURLToPath(import.meta.url));
const seen = [];
const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const u = new URL(req.url, 'http://' + req.headers.host);
  if (u.pathname === '/app') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>OUTPOST bridge test fixture</title>');
  } else if (u.pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!['alpha', 'beta'].includes(body)) return res.writeHead(403).end();
      res.writeHead(302, { Location: '/account',
        'Set-Cookie': 'workspace_session=' + body + '; HttpOnly; Path=/; SameSite=Lax' }).end();
    });
  } else if (u.pathname === '/account' || u.pathname === '/slow') {
    const received = req.headers.cookie || '';
    seen.push(received);
    if (u.pathname === '/slow' && u.searchParams.has('large')) {
      res.writeHead(200).end('x'.repeat(4097));
      return;
    }
    setTimeout(() => {
      res.writeHead(received ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cookie: received }));
    }, u.pathname === '/slow' ? 50 : 0);
  } else res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const profile = await fs.mkdtemp(path.join(dir, 'temporary-profile-'));
const profile2 = await fs.mkdtemp(path.join(dir, 'temporary-profile-'));
let context;
try {
  const launch = async profileDir => {
    const browserContext = await chromium.launchPersistentContext(profileDir, {
      ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
      headless: true, ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging']
    });
    const cdp = await browserContext.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: dir });
    await cdp.detach();
    return { browserContext, id };
  };
  let opened = await launch(profile);
  context = opened.browserContext;
  const id = opened.id;
  await context.addCookies([{ name: 'host_canary', value: 'must-not-leak', url: origin }]);
  const page = await context.newPage();
  await page.goto(origin + '/app');
  const result = await page.evaluate(async ({ id, origin }) => {
    const request = (route, options = {}) => chrome.runtime.sendMessage(id, {
      type: 'fixture-request', url: origin + route, method: 'GET', ...options
    });
    const login = await request('/login', { method: 'POST', body: 'alpha' });
    const cookie = login.headers?.find(h => h.name === 'set-cookie')?.value.split(';')[0];
    const location = login.headers?.find(h => h.name === 'location')?.value;
    const account = await request(location, { cookie });
    const parallel = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      request('/slow', { cookie: 'workspace_session=' + (i % 2 ? 'beta' : 'alpha') })
    ));
    const oversized = await request('/slow?large=1');
    const withoutCookie = await request('/account');
    const rejectedTarget = await chrome.runtime.sendMessage(id, {
      type: 'fixture-request', url: 'https://example.com/', method: 'GET'
    });
    const rejectedCookie = await request('/account', { cookie: 'host_canary=must-not-leak' });
    return { login, account, parallel, oversized, withoutCookie, rejectedTarget, rejectedCookie };
  }, { id, origin });
  assert.equal(result.login.status, 302);
  assert.equal(result.login.body, '');
  assert.equal(result.account.status, 200);
  assert.equal(JSON.parse(result.account.body).cookie, 'workspace_session=alpha');
  for (const [i, item] of result.parallel.entries())
    assert.equal(JSON.parse(item.body).cookie, 'workspace_session=' + (i % 2 ? 'beta' : 'alpha'));
  assert.equal(result.withoutCookie.status, 401);
  assert.equal(result.oversized.ok, false);
  assert.match(result.oversized.error, /fixture response too large/);
  assert.equal(result.rejectedTarget.ok, false);
  assert.equal(result.rejectedCookie.ok, false);
  assert.equal(seen.some(cookie => cookie.includes('host_canary')), false);
  const frameHandle = await page.evaluateHandle(() => {
    const frame = document.createElement('iframe');
    frame.src = '/app';
    document.body.append(frame);
    return frame;
  });
  const frame = await frameHandle.asElement().contentFrame();
  await frame.waitForLoadState('load');
  const frameRequest = await frame.evaluate(async ({ id, origin }) =>
    chrome.runtime.sendMessage(id, { type: 'fixture-request', url: origin + '/account',
      method: 'GET', cookie: 'workspace_session=alpha' }), { id, origin });
  assert.equal(frameRequest.ok, false);
  const hostCookies = await context.cookies(origin);
  assert.deepEqual(hostCookies.map(c => c.name), ['host_canary']);
  const browserVersion = context.browser().version();
  // Transfer only the synthetic cookie value to a new browser profile: this is
  // a protocol test, not OUTPOST's encrypted export/import implementation.
  const portableCookie = result.login.headers.find(h => h.name === 'set-cookie').value.split(';')[0];
  await context.close();
  context = undefined;
  opened = await launch(profile2);
  context = opened.browserContext;
  const page2 = await context.newPage();
  await page2.goto(origin + '/app');
  const restored = await page2.evaluate(async ({ id, origin, cookie }) =>
    chrome.runtime.sendMessage(id, { type: 'fixture-request', url: origin + '/account',
      method: 'GET', cookie }), { id: opened.id, origin, cookie: portableCookie });
  assert.equal(restored.status, 200);
  assert.equal(JSON.parse(restored.body).cookie, 'workspace_session=alpha');
  assert.deepEqual(await context.cookies(origin), []);
  console.log(JSON.stringify({ browser: browserVersion, redirectStatus: result.login.status,
    capturedCookie: true, authenticatedStatus: result.account.status, concurrentRequests: result.parallel.length,
    isolatedConcurrentCookies: true, hostCookieLeaked: false, guestCookieInHostJar: false,
    arbitraryTargetRejected: !result.rejectedTarget.ok, arbitraryCookieRejected: !result.rejectedCookie.ok,
    nestedFrameRejected: !frameRequest.ok,
    oversizedResponseRejected: !result.oversized.ok, missingCookieStatus: result.withoutCookie.status,
    restoredInFreshProfile: restored.status === 200 }, null, 2));
} finally {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
  await fs.rm(profile2, { recursive: true, force: true });
}
