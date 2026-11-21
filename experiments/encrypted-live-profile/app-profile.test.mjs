import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryProfile } from '../memory-profile/memory-profile.mjs';
import { encryptedAppProfile } from './app-profile.mjs';

test('stores and restores tabs, history, and session snapshot through the provider', async () => {
  const fs = new MemoryProfile(), io = encryptedAppProfile(() => fs);
  const session = { tabs: [{ stack: ['https://example.test/a'], position: 0 }], active: 0, zoom: 100 };
  await io.writeBrowserSession(session);
  await io.writeBrowserHistory(new URL('https://example.test/a'));
  await io.writeBrowserHistory(new URL('https://example.test/b?q=synthetic'));
  assert.deepEqual(await io.readBrowserSession(), session);
  assert.deepEqual(await io.readBrowserHistory(), ['https://example.test/a', 'https://example.test/b?q=synthetic']);
  assert.equal(await io.hasSessionCookieSnapshot(), false);
  await fs.writeFile('outpost-session-cookies.dat', new Uint8Array([1]));
  assert.equal(await io.hasSessionCookieSnapshot(), true);
  await io.clearSessionCookieSnapshot();
  assert.equal(await io.hasSessionCookieSnapshot(), false);
  await io.writeBrowserHistory();
  assert.deepEqual(await io.readBrowserHistory(), []);
  fs.destroy();
});
