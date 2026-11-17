// Disposable fixed-origin test. Not a general network bridge.
export async function createHttpsFixture() {
  const target = { tabId: (await chrome.tabs.getCurrent()).id };
  const requests = new Map(), responses = new Map(), failures = new Map();
  const report = { requested: 0 };
  const listener = (source, method, params) => {
    if (source.tabId !== target.tabId) return;
    if (method === 'Network.requestWillBeSent' && !params.redirectResponse)
      requests.set(params.requestId, params.request.url);
    if (method === 'Network.responseReceived') responses.set(params.requestId, params.response);
    if (method === 'Network.loadingFailed') failures.set(params.requestId, params.errorText);
  };
  chrome.debugger.onEvent.addListener(listener);
  await chrome.debugger.attach(target, '1.3');
  await chrome.debugger.sendCommand(target, 'Network.enable');
  const expired = 'https://expired.badssl.com/';
  try { await fetch(expired, { credentials: 'omit', cache: 'no-store',
    redirect: 'error', signal: AbortSignal.timeout(10000) }); } catch { /* inspect the network error */ }
  for (let i = 0; i < 40 && ![...requests].some(([id, requestUrl]) => requestUrl === expired && failures.has(id)); i++)
    await new Promise(resolve => setTimeout(resolve, 25));
  report.expiredRejected = [...requests].some(([id, requestUrl]) => requestUrl === expired &&
    failures.get(id) === 'net::ERR_CERT_DATE_INVALID' && !responses.has(id));
  const url = 'https://example.com/';
  const fs = {
    async stat(path) { return path === 'outpost-fixture-example' ? { size: 262144, isDir: false } : null; },
    async readdir() { return []; },
    async readFile(path) {
      if (path !== 'outpost-fixture-example' || report.requested++) throw Error('Unexpected fixture request');
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
      const body = await response.text();
      for (let i = 0; i < 100 && ![...responses.values()].some(item => item.url === url); i++)
        await new Promise(resolve => setTimeout(resolve, 25));
      const matches = [...responses].filter(([id, item]) => requests.get(id) === url && item.url === url);
      if (matches.length !== 1) throw Error('No unique request-bound response');
      const [[requestId, event]] = matches;
      if (event.securityState !== 'secure' || event.status !== response.status || failures.has(requestId))
        throw Error('Host did not report a secure matching response');
      const captured = await chrome.debugger.sendCommand(target, 'Network.getResponseBody', { requestId });
      const capturedBody = captured.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(captured.body), c => c.charCodeAt(0))) : captured.body;
      if (capturedBody !== body) throw Error('Debugger body mismatch');
      const cert = await chrome.debugger.sendCommand(target, 'Network.getCertificate', { origin: 'https://example.com' });
      if (!cert.tableNames?.length) throw Error('No certificate chain');
      const protocol = event.securityDetails?.protocol === 'TLS 1.3' ? 'TLSv1.3' :
        event.securityDetails?.protocol === 'TLS 1.2' ? 'TLSv1.2' : null;
      if (!protocol) throw Error('Unsupported TLS version');
      report.hostSecure = true;
      report.hostIssuer = event.securityDetails.issuer;
      report.bodyMatched = true;
      report.chainCount = cert.tableNames.length;
      // getCertificate is origin-keyed, not request-keyed; this fixture does
      // not establish request-bound chain evidence. Gecko must verify it.
      const wire = [String(response.status), '', '', '', 'text/html; charset=utf-8',
        ['v1', protocol, ...cert.tableNames].join(':'), 'max-age=600', body].join('\n');
      const bytes = new TextEncoder().encode(wire);
      if (bytes.length >= 262144) throw Error('Fixture response too large');
      const padded = new Uint8Array(262144);
      padded.set(bytes);
      return padded;
    }
  };
  return { fs, report, async close() {
    chrome.debugger.onEvent.removeListener(listener);
    await chrome.debugger.detach(target);
  } };
}
