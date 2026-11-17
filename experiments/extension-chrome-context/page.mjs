// Disposable feasibility test. No messages from ordinary pages are accepted.
import { Gecko } from './gecko.js';
globalThis.fixtureResult = { phase: 'capabilities', crossOriginIsolated,
  sharedArrayBuffer: typeof SharedArrayBuffer,
  suspending: typeof WebAssembly.Suspending,
  promising: typeof WebAssembly.promising };
try {
  const mode = new URLSearchParams(location.search).get('mode');
  const httpsMode = mode === 'https' || mode === 'delegated';
  let httpsFixture;
  if (httpsMode) httpsFixture = await (await import('./https-fixture.mjs')).createHttpsFixture({ delegated: mode === 'delegated' });
  const gecko = new Gecko({ canvas: document.querySelector('#screen'), width: 800, height: 600,
    wispUrl: 'ws://127.0.0.1:1/wisp/',
    wasm: { url: chrome.runtime.getURL('gecko.wasm.zst'), compressed: true },
    profile: 'outpost-chrome-context-fixture', fs: httpsFixture?.fs,
    env: { GECKO_NOWASMJIT: '1', GRE_DIR: '/gre-baked' },
    print: message => console.log('[gecko]', message), printErr: message => console.error('[gecko]', message) });
  globalThis.fixtureResult.phase = 'initializing';
  await gecko.init();
  globalThis.fixtureResult.phase = 'initialized';
  await gecko.load('data:text/html,%3Ctitle%3EOUTPOST%20isolated%20fixture%3C%2Ftitle%3E');
  globalThis.fixtureResult.document = await gecko.evalChrome('document.title');
  if (httpsMode) {
    if (await gecko.evalChrome('outpost:fixture-install') !== 'ok') throw Error('Fixture install failed');
    await gecko.load('https://example.com/');
    globalThis.fixtureResult.navigation = await gecko.evalChrome('outpost:fixture-nav-status');
    if (mode === 'delegated' && !httpsFixture.report.requestBoundCertificate)
      throw Error('Missing request-bound HTTPS evidence');
    globalThis.fixtureResult.httpsTitle = await gecko.evalChrome('document.title');
    globalThis.fixtureResult.httpsDocument = JSON.parse(await gecko.evalChrome("JSON.stringify({href:location.href,secureContext:window.isSecureContext})"));
    globalThis.fixtureResult.securityInfo = await gecko.evalChrome('outpost:fixture-security-info');
    if (mode === 'delegated' && globalThis.fixtureResult.securityInfo === 'present')
      globalThis.fixtureResult.geckoFingerprint = (await gecko.evalChrome('outpost:fixture-cert-fingerprint')).replace(/:/g, '').toUpperCase();
    globalThis.fixtureResult.transport = httpsFixture.report;
    await httpsFixture.close();
  }
  globalThis.fixtureResult.phase = 'complete';
} catch (error) {
  globalThis.fixtureResult.phase = 'failed';
  globalThis.fixtureResult.error = String(error && error.stack || error);
}
