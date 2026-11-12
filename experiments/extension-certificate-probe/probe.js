// Diagnostic only: this test attaches the extension debugger to its own tab.
globalThis.runCertificateProbe = async () => {
  const tab = await chrome.tabs.getCurrent();
  const target = { tabId: tab.id };
  const responses = new Map();
  const failures = new Set();
  const requests = new Map();
  const listener = (source, method, params) => {
    if (source.tabId !== tab.id) return;
    if (method === 'Network.requestWillBeSent' && !params.redirectResponse)
      requests.set(params.requestId, params.request.url);
    if (method === 'Network.responseReceived')
      responses.set(params.requestId, params.response);
    if (method === 'Network.loadingFailed') failures.add(params.requestId);
  };
  chrome.debugger.onEvent.addListener(listener);
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
    await chrome.debugger.sendCommand(target, 'Network.enable');
    const url = 'https://example.com/';
    const expiredUrl = 'https://expired.badssl.com/';
    const options = { credentials: 'omit', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(10000) };
    const valid = await fetch(url, options);
    const body = await valid.text();
    for (let i = 0; i < 40 && ![...responses.values()].some(response => response.url === url); i++)
      await new Promise(resolve => setTimeout(resolve, 25));
    const matches = [...responses].filter(([id, response]) =>
      requests.get(id) === url && response.url === url);
    if (matches.length !== 1) throw Error('Expected exactly one matching network response');
    const [[requestId, response]] = matches;
    if (response.status !== valid.status || response.securityState !== 'secure' ||
        !response.securityDetails || response.fromDiskCache || response.fromServiceWorker)
      throw Error('The network response lacked verified connection metadata');
    const captured = await chrome.debugger.sendCommand(target, 'Network.getResponseBody', { requestId });
    const capturedBody = captured.base64Encoded
      ? new TextDecoder().decode(Uint8Array.from(atob(captured.body), char => char.charCodeAt(0)))
      : captured.body;
    if (capturedBody !== body) throw Error('Response body did not match the request with connection metadata');
    const security = response.securityDetails;
    let bad;
    try { await fetch(expiredUrl, options); bad = 'unexpected success'; }
    catch (error) { bad = error.name; }
    for (let i = 0; i < 40 && ![...requests].some(([id, requestUrl]) =>
      requestUrl === expiredUrl && failures.has(id)); i++)
      await new Promise(resolve => setTimeout(resolve, 25));
    const expiredFailedWithoutResponse = [...requests].some(([id, requestUrl]) =>
      requestUrl === expiredUrl && failures.has(id) && !responses.has(id));
    const cert = await chrome.debugger.sendCommand(target, 'Network.getCertificate', { origin: 'https://example.com' });
    return { valid: valid.status, expired: bad, expiredFailedWithoutResponse, bodyMatched: true,
      events: [{ protocol: security.protocol, issuer: security.issuer, securityState: response.securityState }],
      certificateCount: cert?.tableNames?.length ?? null,
      firstCertificateBase64Bytes: cert?.tableNames?.[0]?.length ?? 0 };
  } catch (error) { return { error: String(error.message || error) }; }
  finally {
    chrome.debugger.onEvent.removeListener(listener);
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
};
