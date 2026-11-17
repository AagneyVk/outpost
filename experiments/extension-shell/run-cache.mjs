// Exercise the packaged Gecko engine's native HTTP cache over a synthetic relay.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const flag = process.argv.indexOf('--addon');
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--addon requires a directory path');
const addon = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(root, '../outpost-extension-preview'));
const profile = await fs.mkdtemp(path.join(here, 'temporary-profile-'));
let context;
const requests = [], counts = new Map();
let report;
const html = `<!doctype html><title>Cache fixture</title><script>
(async()=>{
  const read=async (path,options)=>(await fetch(path,options)).text();
  const fresh=[await read('/fresh'),await read('/fresh')];
  const validated=[await read('/validated'),await read('/validated')];
  const noStore=[await read('/no-store'),await read('/no-store')];
  const language=async value=>read('/vary-language',{headers:{'Accept-Language':value}});
  const vary=[await language('en'),await language('en'),await language('fr'),await language('fr')];
  document.cookie='cache_user=first; Path=/';
  const first=await read('/vary-cookie');
  document.cookie='cache_user=second; Path=/';
  const second=await read('/vary-cookie'), again=await read('/vary-cookie');
  await fetch('/report?data='+encodeURIComponent(JSON.stringify({fresh,validated,noStore,vary,cookie:[first,second,again]})));
})().catch(error=>fetch('/error?message='+encodeURIComponent(String(error))));
</script>`;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, viewport: { width: 1100, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  await context.addCookies([{ name: 'host_canary', value: 'must-not-leak', domain: 'extension-fixture.test', path: '/' }]);
  await context.routeWebSocket('wss://wisp.mercurywork.shop/**', socket => {
    const send = (type, id, body) => { const header = Buffer.alloc(5); header[0] = type; header.writeUInt32LE(id, 1); socket.send(Buffer.concat([header, body])); };
    send(3, 0, Buffer.from([128, 0, 0, 0]));
    const partial = new Map(), done = new Set();
    socket.onMessage(data => {
      const packet = Buffer.from(data);
      if (packet.length < 5 || packet[0] !== 2) return;
      const id = packet.readUInt32LE(1);
      if (done.has(id)) return;
      const request = (partial.get(id) || '') + packet.subarray(5).toString('latin1');
      partial.set(id, request);
      if (!request.includes('\r\n\r\n')) return;
      done.add(id);
      const url = new URL(request.split('\r\n')[0].split(' ')[1], 'http://extension-fixture.test');
      const header = name => new RegExp('^' + name + ':\\s*(.*)$', 'im').exec(request)?.[1] || '';
      const item = { path: url.pathname, cookie: header('cookie'), validator: header('if-none-match'), language: header('accept-language') };
      requests.push(item);
      counts.set(item.path, (counts.get(item.path) || 0) + 1);
      let status = '200 OK', extra = '', body = '';
      if (item.path === '/') { extra = 'Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\n'; body = html; }
      else if (item.path === '/fresh') { extra = 'Cache-Control: private, max-age=600\r\n'; body = 'fresh'; }
      else if (item.path === '/validated') {
        extra = 'Cache-Control: no-cache\r\nETag: "v1"\r\n';
        if (item.validator === '"v1"') status = '304 Not Modified'; else body = 'validated';
      } else if (item.path === '/no-store') { extra = 'Cache-Control: no-store\r\n'; body = 'visit-' + counts.get(item.path); }
      else if (item.path === '/vary-language') { extra = 'Cache-Control: private, max-age=600\r\nVary: Accept-Language\r\n'; body = item.language; }
      else if (item.path === '/vary-cookie') { extra = 'Cache-Control: private, max-age=600\r\nVary: Cookie\r\n'; body = item.cookie.includes('cache_user=first') ? 'first' : 'second'; }
      else if (item.path === '/report') { report = JSON.parse(url.searchParams.get('data')); body = 'ok'; }
      else if (item.path === '/error') { report = { error: url.searchParams.get('message') }; status = '500 Error'; }
      else { status = '404 Not Found'; }
      const response = `HTTP/1.1 ${status}\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
      send(2, id, Buffer.from(response)); send(4, id, Buffer.from([1]));
    });
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: addon });
  await cdp.detach();
  const page = await context.newPage(), pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto('chrome-extension://' + id + '/gecko-lab/index.html');
  await page.locator('#start').click();
  await page.waitForFunction(() => !document.querySelector('#address').disabled || !document.querySelector('#start-error').hidden, null, { timeout: 180000 });
  assert.equal(await page.locator('#start-error').isHidden(), true, await page.locator('#start-error').textContent());
  await page.locator('#address').fill('http://extension-fixture.test/');
  await page.locator('#address').press('Enter');
  const deadline = Date.now() + 45000;
  while (!report && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(report, 'cache fixture did not complete');
  assert.deepEqual(report, { fresh: ['fresh', 'fresh'], validated: ['validated', 'validated'], noStore: ['visit-1', 'visit-2'],
    vary: ['en', 'en', 'fr', 'fr'], cookie: ['first', 'second', 'second'] });
  assert.equal(counts.get('/fresh'), 1);
  assert.deepEqual(requests.filter(item => item.path === '/validated').map(item => item.validator), ['', '"v1"']);
  assert.equal(counts.get('/no-store'), 2);
  assert.deepEqual(requests.filter(item => item.path === '/vary-language').map(item => item.language), ['en', 'fr']);
  assert.equal(counts.get('/vary-cookie'), 2);
  assert.ok(requests.every(item => !item.cookie.includes('host_canary')));
  assert.deepEqual((await context.cookies('http://extension-fixture.test')).map(cookie => cookie.name), ['host_canary']);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ chrome: context.browser().version(), nativeCache: true, revalidation: true,
    noStore: true, varyLanguage: true, varyCookie: true, hostCookieIsolated: true }, null, 2));
} finally {
  if (context) await context.close();
  if (path.dirname(profile) !== here) throw Error('Invalid temporary profile path');
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
