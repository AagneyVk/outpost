// TEST ONLY: restricted to the runner's localhost page. This unauthenticated
// window-message bridge is not suitable for real workspaces or credentials.
window.addEventListener('message', function (event) {
  if (event.source !== window || event.origin !== location.origin || !event.data ||
      event.data.type !== 'outpost-test-request' || !Number.isSafeInteger(event.data.id)) return;
  browser.runtime.sendMessage({ type: 'fixture-fetch', url: event.data.url }).then(function (result) {
    window.postMessage({ type: 'outpost-test-response', id: event.data.id, result: result }, location.origin);
  }, function (error) {
    window.postMessage({ type: 'outpost-test-response', id: event.data.id,
      result: { ok: false, error: String(error) } }, location.origin);
  });
});
