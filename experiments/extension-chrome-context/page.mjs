// Disposable feasibility test. No messages from ordinary pages are accepted.
import { Gecko } from './gecko.js';
globalThis.fixtureResult = { phase: 'capabilities', crossOriginIsolated,
  sharedArrayBuffer: typeof SharedArrayBuffer,
  suspending: typeof WebAssembly.Suspending,
  promising: typeof WebAssembly.promising };
try {
  const mode = new URLSearchParams(location.search).get('mode') || '';
  const directLogout = mode === 'public-demo-logout-direct';
  const publicLogout = mode === 'public-demo-logout' || directLogout;
  const publicDemo = mode === 'public-demo' || publicLogout;
  const signIn = mode === 'signin' || mode === 'signin-form' || mode === 'signin-form-bad';
  const formSignIn = mode === 'signin-form' || mode === 'signin-form-bad';
  const internal = mode.startsWith('internal');
  const stateOnly = internal || mode === 'state' || mode === 'state-tamper' || mode === 'state-no-evidence';
  const httpsMode = mode === 'https' || mode === 'delegated' || stateOnly;
  let httpsFixture;
  let signInFixture;
  let publicFixture;
  if (httpsMode) httpsFixture = await (await import('./https-fixture.mjs')).createHttpsFixture({ delegated: mode === 'delegated', stateOnly, internal, tamper: mode.endsWith('-tamper'), noEvidence: mode.endsWith('-no-evidence'), noScriptEvidence: mode.endsWith('-no-script-evidence') });
  if (signIn) signInFixture = await (await import('./local-signin.mjs')).createLocalSignInFixture(new URLSearchParams(location.search).get('origin'), { form: formSignIn });
  if (publicDemo) publicFixture = await (await import('./public-signin.mjs')).createPublicSignInFixture({ logout: publicLogout });
  const gecko = new Gecko({ canvas: document.querySelector('#screen'), width: 800, height: 600,
    wispUrl: 'ws://127.0.0.1:1/wisp/',
    wasm: { url: chrome.runtime.getURL('gecko.wasm.zst'), compressed: true },
    profile: 'outpost-chrome-context-fixture', fs: httpsFixture?.fs || signInFixture?.fs || publicFixture?.fs,
    env: { GECKO_NOWASMJIT: '1', GRE_DIR: '/gre-baked' },
    print: message => console.log('[gecko]', message), printErr: message => console.error('[gecko]', message) });
  globalThis.fixtureResult.phase = 'initializing';
  await gecko.init();
  globalThis.fixtureResult.phase = 'initialized';
  await gecko.load('data:text/html,%3Ctitle%3EOUTPOST%20isolated%20fixture%3C%2Ftitle%3E');
  globalThis.fixtureResult.document = await gecko.evalChrome('document.title');
  if (publicDemo) {
    if (await gecko.evalChrome('outpost:fixture-install') !== 'ok') throw Error('Fixture install failed');
    await gecko.load('https://practice.expandtesting.com/login');
    let ready = false;
    for (let i = 0; i < 120; i++) {
      ready = (await gecko.evalChrome("String(!!document.querySelector('[name=username]') && !!document.querySelector('[name=password]') && !!document.querySelector('form'))")) === 'true';
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw Error('Public demo form did not load');
    await gecko.evalChrome("document.querySelector('[name=username]').value='practice'; document.querySelector('[name=password]').value='SuperSecretPassword!'; document.querySelector('form').requestSubmit(); 'submitted'");
    for (let i = 0; i < 120; i++) {
      globalThis.fixtureResult.publicDocument = JSON.parse(await gecko.evalChrome("JSON.stringify({href:location.href,success:document.body?.innerText?.includes('You logged into a secure area') || false,logout:!!document.querySelector('a[href*=logout]')})"));
      if (globalThis.fixtureResult.publicDocument.success && globalThis.fixtureResult.publicDocument.logout) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    globalThis.fixtureResult.publicSecurityInfo = await gecko.evalChrome('outpost:fixture-security-info');
    globalThis.fixtureResult.publicTransport = publicFixture.report;
    globalThis.fixtureResult.publicErrors = publicFixture.errors;
    if (publicLogout) {
      if (!globalThis.fixtureResult.publicDocument.success || !globalThis.fixtureResult.publicDocument.logout)
        throw Error('Public demo did not sign in before logout');
      globalThis.fixtureResult.logoutLink = JSON.parse(await gecko.evalChrome("JSON.stringify({href:document.querySelector('a[href*=logout]').href,target:document.querySelector('a[href*=logout]').target,outerHTML:document.querySelector('a[href*=logout]').outerHTML})"));
      if (directLogout) await gecko.load(globalThis.fixtureResult.logoutLink.href);
      else await gecko.evalChrome("document.querySelector('a[href*=logout]').click(); 'clicked'");
      for (let i = 0; i < 120; i++) {
        globalThis.fixtureResult.afterLogout = JSON.parse(await gecko.evalChrome("JSON.stringify({href:location.href,loginForm:!!document.querySelector('[name=username]')})"));
        if (publicFixture.report.requests.length >= 4 && globalThis.fixtureResult.afterLogout.href === 'https://practice.expandtesting.com/login' && globalThis.fixtureResult.afterLogout.loginForm) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (globalThis.fixtureResult.afterLogout.href !== 'https://practice.expandtesting.com/login' || !globalThis.fixtureResult.afterLogout.loginForm)
        throw Error('Public demo logout navigation did not complete');
      await gecko.load('https://practice.expandtesting.com/secure');
      for (let i = 0; i < 120; i++) {
        globalThis.fixtureResult.afterRevisit = JSON.parse(await gecko.evalChrome("JSON.stringify({href:location.href,loginForm:!!document.querySelector('[name=username]'),logout:!!document.querySelector('a[href*=logout]')})"));
        if (publicFixture.report.requests.length >= 5 && globalThis.fixtureResult.afterRevisit.href === 'https://practice.expandtesting.com/login' && globalThis.fixtureResult.afterRevisit.loginForm && !globalThis.fixtureResult.afterRevisit.logout) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    globalThis.fixtureResult.publicTransport = publicFixture.report;
    globalThis.fixtureResult.publicErrors = publicFixture.errors;
    await publicFixture.close();
  }
  if (signIn) {
    if (await gecko.evalChrome('outpost:fixture-install') !== 'ok') throw Error('Fixture install failed');
    await gecko.load('http://fixture.test/bridge-login');
    if (formSignIn) {
      let formReady = false;
      for (let i = 0; i < 100; i++) {
        formReady = (await gecko.evalChrome("String(!!document.querySelector('form'))")) === 'true';
        if (formReady) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!formReady) throw Error('Synthetic sign-in form did not load');
      await gecko.evalChrome("document.querySelector('form').requestSubmit(); 'submitted'");
    }
    for (let i = 0; i < 100; i++) {
      globalThis.fixtureResult.signInDocument = JSON.parse(await gecko.evalChrome("JSON.stringify({href:location.href,title:document.title})"));
      if (globalThis.fixtureResult.signInDocument.title === 'Fixture signed in') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    globalThis.fixtureResult.signInTransport = signInFixture.report;
    globalThis.fixtureResult.signInErrors = signInFixture.errors;
    await signInFixture.close();
  }
  if (httpsMode) {
    if (await gecko.evalChrome('outpost:fixture-install') !== 'ok') throw Error('Fixture install failed');
    if (stateOnly) globalThis.fixtureResult.beforeHsts = await gecko.evalChrome('outpost:fixture-hsts');
    await gecko.load('https://example.com/');
    globalThis.fixtureResult.navigation = await gecko.evalChrome('outpost:fixture-nav-status');
    if (mode === 'delegated' && !httpsFixture.report.requestBoundCertificate)
      throw Error('Missing request-bound HTTPS evidence');
    if (stateOnly && !httpsFixture.report.requestBoundState)
      throw Error('Missing request-bound HTTPS state: ' + (httpsFixture.report.bindingError || 'unavailable'));
    for (let i = 0; i < 100; i++) {
      globalThis.fixtureResult.httpsTitle = await gecko.evalChrome('document.title');
      if (globalThis.fixtureResult.httpsTitle || mode.endsWith('-no-evidence')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    globalThis.fixtureResult.httpsDocument = JSON.parse(await gecko.evalChrome("JSON.stringify({href:location.href,secureContext:window.isSecureContext})"));
    globalThis.fixtureResult.securityInfo = await gecko.evalChrome('outpost:fixture-security-info');
    if (internal) globalThis.fixtureResult.spoofHeader = await gecko.evalChrome('outpost:fixture-spoof-header');
    if (stateOnly) globalThis.fixtureResult.afterHsts = await gecko.evalChrome('outpost:fixture-hsts');
    if (stateOnly && globalThis.fixtureResult.securityInfo === 'present') {
      globalThis.fixtureResult.certificate = await gecko.evalChrome('outpost:fixture-cert-present');
    }
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
