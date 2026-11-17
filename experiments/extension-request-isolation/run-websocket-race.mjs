import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright-core';
const dir = path.dirname(fileURLToPath(import.meta.url));
const addon = await fs.mkdtemp(path.join(dir, 'temporary-addon-'));
const profile = await fs.mkdtemp(path.join(dir, 'temporary-profile-'));
const shared = process.env.OUTPOST_SHARED_RULE_CONTROL === '1';
const closeTest = process.env.OUTPOST_WS_CLOSE_TEST === '1';
const noCloseCleanup = process.env.OUTPOST_NO_CLOSE_CLEANUP === '1';
const sameTab = process.env.OUTPOST_SAME_TAB_CONTROL === '1';
const sameTabQueue = process.env.OUTPOST_SAME_TAB_QUEUE === '1';
if ([closeTest, shared, sameTab, sameTabQueue].filter(Boolean).length > 1) throw Error('Choose one race test');
const observed = [];
let openSockets = 0, maxOpenSockets = 0;
let context, server, sockets;
try {
  server = http.createServer((_req, res) => res.writeHead(404).end());
  sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/socket') return socket.destroy();
    observed.push(req.headers.cookie || '');
    sockets.handleUpgrade(req, socket, head, ws => {
      openSockets++;
      maxOpenSockets = Math.max(maxOpenSockets, openSockets);
      ws.on('close', () => { openSockets--; });
      ws.on('message', data => {
        if (sameTabQueue) setTimeout(() => { if (ws.readyState === ws.OPEN) ws.send(data, { binary: false }); }, 100);
        else ws.send(data, { binary: false });
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'ws://127.0.0.1:' + server.address().port + '/socket';
  for (const name of ['race.html', 'race.mjs', 'race-worker.js']) await fs.copyFile(path.join(dir, name), path.join(addon, name));
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  if (!noCloseCleanup) manifest.background = { service_worker: 'race-worker.js' };
  await fs.writeFile(path.join(addon, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.OUTPOST_CHROME ? { executablePath: process.env.OUTPOST_CHROME } : { channel: 'chrome' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  await context.addCookies([{ name: 'host_canary', value: 'must-not-leak', domain: '127.0.0.1',
    path: '/', sameSite: 'None', secure: true }]);
  assert.ok((await context.cookies()).some(cookie => cookie.name === 'host_canary'));
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: addon });
  await cdp.detach();
  const pages = [await context.newPage(), await context.newPage()];
  const href = 'chrome-extension://' + id + '/race.html?' + new URLSearchParams({ url, scope: shared ? 'shared' : 'tab' });
  for (const page of pages) await page.goto(href);
  if (sameTabQueue) {
    const echoes = await pages[0].evaluate(() => Promise.all([
      fixtureOpenSerialized('workspace_session=alpha'), fixtureOpenSerialized('workspace_session=beta')
    ]));
    const rules = await pages[0].evaluate(() => fixtureRuleIds());
    console.log(JSON.stringify({ browser: context.browser().version(), sameTabQueue, echoes, rules, observed, maxOpenSockets }, null, 2));
    assert.deepEqual(echoes, ['echo', 'echo']);
    assert.deepEqual(observed, ['workspace_session=alpha', 'workspace_session=beta']);
    assert.equal(maxOpenSockets, 2, 'established sockets should overlap');
    assert.deepEqual(rules, []);
  } else {
  const a = await pages[0].evaluate(() => fixtureInstallRule('workspace_session=alpha'));
  const b = await pages[sameTab ? 0 : 1].evaluate(() => fixtureInstallRule('workspace_session=beta'));
  if (sameTab) {
    const first = await pages[0].evaluate(() => fixtureOpenSocket());
    await pages[0].evaluate(() => fixtureRemoveRule());
    console.log(JSON.stringify({ browser: context.browser().version(), sameTab, a, b, first, observed }, null, 2));
    assert.equal(a.tabId, b.tabId);
    assert.equal(first, 'echo');
    assert.deepEqual(observed, ['workspace_session=beta']);
    console.log('KNOWN UNSAFE CONTROL: same-tab rule replacement sent the wrong synthetic cookie.');
  } else if (closeTest) {
    await pages[0].close();
    let rules = [];
    for (let i = 0; i < 100; i++) {
      rules = await pages[1].evaluate(() => fixtureRuleIds());
      if (!rules.includes(a.ruleId)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const second = await pages[1].evaluate(() => fixtureOpenSocket());
    await pages[1].evaluate(() => fixtureRemoveRule());
    console.log(JSON.stringify({ browser: context.browser().version(), closeTest, noCloseCleanup, a, b, rules, second, observed }, null, 2));
    assert.equal(rules.includes(a.ruleId), noCloseCleanup);
    assert.equal(rules.includes(b.ruleId), true);
    assert.equal(second, 'echo');
    assert.deepEqual(observed, ['workspace_session=beta']);
  } else {
  const first = await pages[0].evaluate(() => fixtureOpenSocket());
  const second = await pages[1].evaluate(() => fixtureOpenSocket());
  await pages[0].evaluate(() => fixtureRemoveRule());
  await pages[1].evaluate(() => fixtureRemoveRule());
  console.log(JSON.stringify({ browser: context.browser().version(), sharedRule: shared, a, b, first, second, observed }, null, 2));
  assert.equal(first, 'echo');
  assert.equal(second, 'echo');
  assert.notEqual(a.tabId, b.tabId);
  assert.deepEqual(observed, shared
    ? ['host_canary=must-not-leak', 'workspace_session=beta']
    : ['workspace_session=alpha', 'workspace_session=beta']);
  if (shared) console.log('KNOWN UNSAFE CONTROL: a shared rule exposed the synthetic host cookie.');
  }
  }
} finally {
  if (context) await context.close();
  if (sockets) await new Promise(resolve => sockets.close(resolve));
  if (server) await new Promise(resolve => server.close(resolve));
  for (const temporary of [addon, profile]) {
    if (path.dirname(temporary) !== dir) throw Error('Invalid temporary path');
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
