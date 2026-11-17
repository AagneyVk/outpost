// Disposable feasibility test. No messages from ordinary pages are accepted.
import { Gecko } from './gecko.js';
globalThis.fixtureResult = { phase: 'capabilities', crossOriginIsolated,
  sharedArrayBuffer: typeof SharedArrayBuffer,
  suspending: typeof WebAssembly.Suspending,
  promising: typeof WebAssembly.promising };
try {
  const mode = new URLSearchParams(location.search).get('mode') || '';
  const directLogout = mode === 'public-demo-logout-direct';
  const pointerLogout = mode === 'public-demo-logout-pointer';
  const publicLogout = mode === 'public-demo-logout' || directLogout || pointerLogout;
  const publicSave = mode === 'public-demo-save';
  const publicRestore = mode === 'public-demo-restore';
  const publicDemo = mode === 'public-demo' || publicLogout || publicSave || publicRestore;
  const matrix = mode === 'cookie-cache-matrix';
  const matrixExtended = matrix && new URLSearchParams(location.search).get('extended') === '1';
  const matrixFailures = matrixExtended && new URLSearchParams(location.search).get('failures') === '1';
  const signIn = mode === 'signin' || mode === 'signin-form' || mode === 'signin-form-bad';
  const formSignIn = mode === 'signin-form' || mode === 'signin-form-bad';
  const internal = mode.startsWith('internal');
  const stateOnly = internal || mode === 'state' || mode === 'state-tamper' || mode === 'state-no-evidence';
  const httpsMode = mode === 'https' || mode === 'delegated' || stateOnly;
  let httpsFixture;
  let signInFixture;
  let publicFixture;
  let matrixFixture;
  if (httpsMode) httpsFixture = await (await import('./https-fixture.mjs')).createHttpsFixture({ delegated: mode === 'delegated', stateOnly, internal, tamper: mode.endsWith('-tamper'), noEvidence: mode.endsWith('-no-evidence'), noScriptEvidence: mode.endsWith('-no-script-evidence') });
  if (signIn) signInFixture = await (await import('./local-signin.mjs')).createLocalSignInFixture(new URLSearchParams(location.search).get('origin'), { form: formSignIn });
  if (publicDemo) publicFixture = await (await import('./public-signin.mjs')).createPublicSignInFixture({ logout: publicLogout });
  if (matrix) matrixFixture = await (await import('./cookie-cache-fixture.mjs')).createCookieCacheFixture(new URLSearchParams(location.search).get('origin'), { extended: matrixExtended });
  const gecko = new Gecko({ canvas: document.querySelector('#screen'), width: 800, height: 600,
    wispUrl: 'ws://127.0.0.1:1/wisp/',
    wasm: { url: chrome.runtime.getURL('gecko.wasm.zst'), compressed: true },
    profile: 'outpost-chrome-context-fixture', fs: httpsFixture?.fs || signInFixture?.fs || publicFixture?.fs || matrixFixture?.fs,
    env: { GECKO_NOWASMJIT: '1', GRE_DIR: '/gre-baked' },
    print: message => console.log('[gecko]', message), printErr: message => console.error('[gecko]', message) });
  globalThis.fixtureResult.phase = 'initializing';
  await gecko.init();
  globalThis.fixtureResult.phase = 'initialized';
  await gecko.load('data:text/html,%3Ctitle%3EOUTPOST%20isolated%20fixture%3C%2Ftitle%3E');
  globalThis.fixtureResult.document = await gecko.evalChrome('document.title');
  if (matrix) {
    if (await gecko.evalChrome('outpost:fixture-install') !== 'ok') throw Error('Fixture install failed');
    await gecko.load('http://fixture.test/matrix/home');
    let matrixReady = false;
    for (let i = 0; i < 120; i++) {
      matrixReady = (await gecko.evalChrome('document.title')) === 'Matrix fixture';
      if (matrixReady) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!matrixReady) throw Error('Matrix fixture home did not load');
    await gecko.evalChrome(`window.fixtureMatrix = 'pending';
      (async () => {
        const get = async path => (await fetch(path)).text();
        await get('/matrix/set');
        await get('/matrix/set-extra');
        document.cookie = 'client=synthetic; Path=/';
        const visible = document.cookie;
        const privateCookie = await get('/matrix/private/echo');
        const publicCookie = await get('/matrix/echo');
        const cacheFirst = await get('/matrix/cache');
        const cacheSecond = await get('/matrix/cache');
        const conditional = await fetch('/matrix/cache', {headers:{'If-None-Match':'"fixture-v1"'}});
        const conditionalStatus = conditional.status, conditionalBody = await conditional.text();
        const versionFirst = await get('/matrix/versioned');
        const versionSecond = await get('/matrix/versioned');
        const versionThird = await get('/matrix/versioned');
        const freshFirst = await get('/matrix/fresh');
        const cacheCookieSet = document.cookie.includes('cached_token=synthetic');
        document.cookie = 'cached_token=; Max-Age=0; Path=/';
        const freshSecond = await get('/matrix/fresh');
        const cacheCookieReplayed = document.cookie.includes('cached_token=synthetic');
        document.cookie = 'cached_token=; Max-Age=0; Path=/';
        const noStoreFirst = await get('/matrix/no-store');
        const noStoreSecond = await get('/matrix/no-store');
        const cookieVaryFirst = ${matrixExtended} ? await get('/matrix/cookie-vary') : null;
        document.cookie = 'client=; Max-Age=0; Path=/';
        const cookieVarySecond = ${matrixExtended} ? await get('/matrix/cookie-vary') : null;
        const cookieVaryThird = ${matrixExtended} ? await get('/matrix/cookie-vary') : null;
        await get('/matrix/delete');
        const afterDelete = await get('/matrix/echo');
        let extended = null;
        if (${matrixExtended}) {
          const vary = async language => (await fetch('/matrix/vary', {headers:{'Accept-Language':language}})).text();
          const varyValues = [await vary('en'), await vary('en'), await vary('fr'), await vary('fr')];
          const binary = Array.from(new Uint8Array(await (await fetch('/matrix/binary')).arrayBuffer()));
          const image = await new Promise(resolve => {
            const img = new Image(), timer = setTimeout(() => resolve({ok:false}), 5000);
            img.onload = () => { clearTimeout(timer); resolve({ok:true,width:img.naturalWidth,height:img.naturalHeight}); };
            img.onerror = () => { clearTimeout(timer); resolve({ok:false}); };
            img.src = '/matrix/image';
          });
          let truncated = null;
          if (${matrixFailures}) {
            const attempt = async () => {
              try {
                return await Promise.race([
                  fetch('/matrix/truncated').then(response => response.text()).then(() => 'unexpected-success', () => 'failed'),
                  new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))
                ]);
              } catch { return 'failed'; }
            };
            truncated = [await attempt(), await attempt()];
          }
          extended = {varyValues, cookieVary: [cookieVaryFirst, cookieVarySecond, cookieVaryThird], binary, image, truncated};
        }
        return { visible, privateCookie, publicCookie, cacheFirst, cacheSecond, conditionalStatus, conditionalBody,
          versionFirst, versionSecond, versionThird, freshFirst, freshSecond, cacheCookieSet, cacheCookieReplayed, noStoreFirst, noStoreSecond, afterDelete, extended };
      })().then(value => window.fixtureMatrix = JSON.stringify(value), error => window.fixtureMatrix = JSON.stringify({error:String(error)}));
      'started'`);
    for (let i = 0; i < 240; i++) {
      const value = await gecko.evalChrome('String(window.fixtureMatrix)');
      if (value !== 'pending' && value !== 'undefined') { globalThis.fixtureResult.matrix = JSON.parse(value); break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    globalThis.fixtureResult.matrixTransport = matrixFixture.report;
    globalThis.fixtureResult.matrixErrors = matrixFixture.errors;
    await matrixFixture.close();
  }
  if (publicDemo) {
    if (await gecko.evalChrome('outpost:fixture-install') !== 'ok') throw Error('Fixture install failed');
    if (publicRestore) {
      const { unseal } = await import('./portable.js');
      const encrypted = Uint8Array.from(globalThis.fixtureSeed || []);
      if (!encrypted.length) throw Error('Encrypted fixture snapshot missing');
      let wrongPasswordRejected = false, tamperingRejected = false;
      try { await unseal(new Blob([encrypted]), 'incorrect-password-1!', 'a'.repeat(64)); } catch { wrongPasswordRejected = true; }
      const damaged = encrypted.slice(); damaged[damaged.length - 1] ^= 1;
      try { await unseal(new Blob([damaged]), 'synthetic-passphrase-1!', 'a'.repeat(64)); } catch { tamperingRejected = true; }
      const before = await gecko.evalChrome('outpost:fixture-cookies-save');
      if (before) throw Error('Fresh fixture unexpectedly contains demo cookies');
      const plaintext = await unseal(new Blob([encrypted]), 'synthetic-passphrase-1!', 'a'.repeat(64));
      let restore, attributesRoundTripped = false, duplicateRejected = false;
      try {
        const snapshot = new TextDecoder().decode(plaintext);
        const normalize = value => value.trim().split('\n').sort().join('\n');
        restore = await gecko.evalChrome('outpost:fixture-cookies-restore:' + snapshot);
        const roundTrip = await gecko.evalChrome('outpost:fixture-cookies-save');
        attributesRoundTripped = normalize(snapshot) === normalize(roundTrip);
        const duplicate = await gecko.evalChrome('outpost:fixture-cookies-restore:' + snapshot);
        const afterDuplicate = await gecko.evalChrome('outpost:fixture-cookies-save');
        duplicateRejected = duplicate !== 'ok' && normalize(roundTrip) === normalize(afterDuplicate);
      }
      finally { plaintext.fill(0); }
      if (restore !== 'ok') throw Error('Synthetic cookie restore failed');
      globalThis.fixtureResult.restored = { wrongPasswordRejected, tamperingRejected, freshProfile: !before, restore, attributesRoundTripped, duplicateRejected };
      await gecko.load('https://practice.expandtesting.com/secure');
      for (let i = 0; i < 120; i++) {
        globalThis.fixtureResult.restoredDocument = JSON.parse(await gecko.evalChrome("JSON.stringify({href:location.href,logout:!!document.querySelector('a[href*=logout]')})"));
        if (publicFixture.report.requests.length >= 1 && globalThis.fixtureResult.restoredDocument.href === 'https://practice.expandtesting.com/secure' && globalThis.fixtureResult.restoredDocument.logout) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      globalThis.fixtureResult.publicTransport = publicFixture.report;
      globalThis.fixtureResult.publicErrors = publicFixture.errors;
      await publicFixture.close();
    } else {
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
    if (publicSave) {
      if (!globalThis.fixtureResult.publicDocument.success || !globalThis.fixtureResult.publicDocument.logout) throw Error('Demo sign-in failed before snapshot');
      const serialized = await gecko.evalChrome('outpost:fixture-cookies-save');
      if (!serialized) throw Error('Synthetic demo cookie snapshot failed');
      const { seal } = await import('./portable.js');
      const plaintext = new TextEncoder().encode(serialized);
      try { globalThis.fixtureEncrypted = Array.from(new Uint8Array(await (await seal(plaintext, 'synthetic-passphrase-1!', 'a'.repeat(64))).arrayBuffer())); }
      finally { plaintext.fill(0); }
      globalThis.fixtureResult.snapshotEncrypted = true;
    }
    globalThis.fixtureResult.publicTransport = publicFixture.report;
    globalThis.fixtureResult.publicErrors = publicFixture.errors;
    if (publicLogout) {
      if (!globalThis.fixtureResult.publicDocument.success || !globalThis.fixtureResult.publicDocument.logout)
        throw Error('Public demo did not sign in before logout');
      globalThis.fixtureResult.logoutLink = JSON.parse(await gecko.evalChrome("JSON.stringify({href:document.querySelector('a[href*=logout]').href,target:document.querySelector('a[href*=logout]').target,outerHTML:document.querySelector('a[href*=logout]').outerHTML})"));
      if (pointerLogout) {
        globalThis.fixtureResult.logoutRect = JSON.parse(await gecko.evalChrome("(() => {const a=document.querySelector('a[href*=logout]'); a.scrollIntoView({block:'center'}); const r=a.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight});})()"));
        globalThis.fixtureResult.phase = 'awaiting-logout-pointer';
        for (let i = 0; i < 200 && globalThis.fixtureResult.phase === 'awaiting-logout-pointer'; i++)
          await new Promise(resolve => setTimeout(resolve, 50));
        if (globalThis.fixtureResult.phase !== 'logout-pointer-sent') throw Error('Pointer test did not send a click');
      } else if (directLogout) await gecko.load(globalThis.fixtureResult.logoutLink.href);
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
