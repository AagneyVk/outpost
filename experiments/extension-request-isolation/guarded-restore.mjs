// Disposable local research only; this page is not included in OUTPOST builds.
globalThis.fixtureGuardedReady = false;
globalThis.fixtureGuardedError = null;
try {
  if (window !== window.top) throw Error('Top-level page required');
  const result = await chrome.runtime.sendMessage({ type: 'prepare-restore' });
  if (result?.ready !== true) throw Error('Restore rule cleanup failed');
  const iframe = document.createElement('iframe');
  iframe.id = 'guarded-frame';
  iframe.credentialless = true;
  iframe.src = chrome.runtime.getURL('empty.html');
  const loaded = new Promise((resolve, reject) => { iframe.onload = resolve; iframe.onerror = reject; });
  document.body.append(iframe);
  await loaded;
  globalThis.fixtureGuardedReady = true;
} catch (error) { globalThis.fixtureGuardedError = String(error.message || error); }
