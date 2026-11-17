// Disposable fixed-origin test. Not a general network bridge.
import { validateResponseBinding } from './response-binding.mjs';
export async function createHttpsFixture({ delegated = false, stateOnly = false, internal = false, tamper = false, noEvidence = false, noScriptEvidence = false } = {}) {
  const target = { tabId: (await chrome.tabs.getCurrent()).id };
  const requests = new Map(), responses = new Map(), failures = new Map(), redirects = new Set(), completed = new Set();
  const report = { requested: 0 };
  const certEvents = [];
  const certListener = details => {
    if (details.url === 'https://example.com/') certEvents.push(details);
  };
  if (delegated) chrome.webRequest.onHeadersReceived.addListener(certListener,
    { urls: ['https://example.com/*'], types: ['xmlhttprequest'] }, ['securityInfo', 'securityInfoRawDer']);
  const listener = (source, method, params) => {
    if (source.tabId !== target.tabId) return;
    if (method === 'Network.requestWillBeSent') {
      if (params.redirectResponse) redirects.add(params.requestId);
      else requests.set(params.requestId, params.request.url);
    }
    if (method === 'Network.responseReceived') responses.set(params.requestId, params.response);
    if (method === 'Network.loadingFailed') failures.set(params.requestId, params.errorText);
    if (method === 'Network.loadingFinished') completed.add(params.requestId);
  };
  chrome.debugger.onEvent.addListener(listener);
  await chrome.debugger.attach(target, '1.3');
  // Passive capability probe only; never enable certificate overrides.
  try {
    await chrome.debugger.sendCommand(target, 'Security.enable');
    report.securityDomainAvailable = true;
    await chrome.debugger.sendCommand(target, 'Security.disable');
  } catch { report.securityDomainAvailable = false; }
  await chrome.debugger.sendCommand(target, 'Network.enable');
  async function rejectedWith(url, code) {
    try { await fetch(url, { credentials: 'omit', cache: 'no-store',
      redirect: 'error', signal: AbortSignal.timeout(10000) }); } catch { /* inspect the network error */ }
    for (let i = 0; i < 40 && ![...requests].some(([id, requestUrl]) => requestUrl === url && failures.has(id)); i++)
      await new Promise(resolve => setTimeout(resolve, 25));
    const observed = [...requests].filter(([, requestUrl]) => requestUrl === url)
      .map(([id]) => ({ error: failures.get(id) || null, receivedResponse: responses.has(id) }));
    (report.badCertificateResults ??= {})[url] = observed;
    return observed.some(item => item.error === code && !item.receivedResponse);
  }
  report.expiredRejected = await rejectedWith('https://expired.badssl.com/', 'net::ERR_CERT_DATE_INVALID');
  report.selfSignedRejected = await rejectedWith('https://self-signed.badssl.com/', 'net::ERR_CERT_AUTHORITY_INVALID');
  const fixtureURLs = new Map([['outpost-fixture-example', 'https://example.com/']]);
  if (internal) fixtureURLs.set('outpost-fixture-example-script', 'https://example.com/s.js');
  const attempted = new Set();
  report.resources = [];
  report.suppressedURLs = [];
  const fs = {
    async stat(path) { return fixtureURLs.has(path) ? { size: 262144, isDir: false } : null; },
    async readdir() { return []; },
    async readFile(path) {
      const url = fixtureURLs.get(path);
      if (!url || attempted.has(url) || report.requested >= 2) throw Error('Unexpected fixture request');
      attempted.add(url);
      report.requested++;
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
      const bodyBytes = new Uint8Array(await response.arrayBuffer());
      for (let i = 0; i < 100 && ![...responses.values()].some(item => item.url === url); i++)
        await new Promise(resolve => setTimeout(resolve, 25));
      const matches = [...responses].filter(([id, item]) => requests.get(id) === url && item.url === url);
      if (matches.length !== 1) throw Error('No unique request-bound response');
      const [[requestId, event]] = matches;
      for (let i = 0; i < 40 && !completed.has(requestId) && !failures.has(requestId); i++)
        await new Promise(resolve => setTimeout(resolve, 25));
      if (!completed.has(requestId)) throw Error('Request did not complete successfully');
      const captured = await chrome.debugger.sendCommand(target, 'Network.getResponseBody', { requestId });
      const capturedBody = captured.base64Encoded ? Uint8Array.from(atob(captured.body), c => c.charCodeAt(0)) : new TextEncoder().encode(captured.body);
      if (tamper && bodyBytes.length) bodyBytes[0] ^= 1;
      try {
        validateResponseBinding({ url, status: response.status, finalURL: response.url,
          body: bodyBytes, capturedBody, requests, responses, failures, redirects });
      } catch (error) {
        report.bindingError = String(error?.message || error);
        throw error;
      }
      const body = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);
      let chain;
      if (stateOnly) {
        chain = [];
        report.requestBoundState = true;
        report.certificateAvailable = false;
      } else if (delegated) {
        for (let i = 0; i < 40 && !certEvents.length; i++) await new Promise(resolve => setTimeout(resolve, 25));
        if (certEvents.length !== 1 || certEvents[0].statusCode !== response.status ||
            certEvents[0].securityInfo?.state !== 'secure') throw Error('No unique request-bound secure certificate');
        const certificates = certEvents[0].securityInfo.certificates || [];
        if (!certificates.length || certificates.some(item => !item.rawDER?.byteLength)) throw Error('Missing request-bound certificate bytes');
        for (const cert of certificates) {
          const digest = await crypto.subtle.digest('SHA-256', cert.rawDER);
          const fingerprint = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
          if (fingerprint !== cert.fingerprint.sha256.replace(/:/g, '').toUpperCase()) throw Error('Certificate fingerprint mismatch');
          if (!report.leafFingerprint) report.leafFingerprint = fingerprint;
        }
        chain = certificates.map(item => btoa(String.fromCharCode(...new Uint8Array(item.rawDER))));
        report.requestBoundCertificate = true;
      } else {
        const cert = await chrome.debugger.sendCommand(target, 'Network.getCertificate', { origin: 'https://example.com' });
        if (!cert.tableNames?.length) throw Error('No certificate chain');
        chain = cert.tableNames;
      }
      const protocol = event.securityDetails?.protocol === 'TLS 1.3' ? 'TLSv1.3' :
        event.securityDetails?.protocol === 'TLS 1.2' ? 'TLSv1.2' : null;
      if (!protocol) throw Error('Unsupported TLS version');
      report.hostSecure = true;
      report.hostIssuer = event.securityDetails.issuer;
      report.bodyMatched = true;
      report.chainCount = chain.length;
      report.evidenceSuppressed = noEvidence;
      report.resources.push({ url, status: response.status });
      const suppressEvidence = noEvidence || (noScriptEvidence && path === 'outpost-fixture-example-script');
      if (suppressEvidence) report.suppressedURLs.push(url);
      // getCertificate is origin-keyed, not request-keyed; this fixture does
      // not establish request-bound chain evidence. Gecko must verify it.
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      if (contentType.includes('\n') || contentType.includes('\r')) throw Error('Invalid content type');
      const wire = [String(response.status), '', '', '', contentType,
        suppressEvidence ? '' : [stateOnly ? 'v3' : delegated ? 'v2' : 'v1', protocol, ...chain].join(':'), 'max-age=600', body].join('\n');
      const bytes = new TextEncoder().encode(wire);
      if (bytes.length >= 262144) throw Error('Fixture response too large');
      const padded = new Uint8Array(262144);
      padded.set(bytes);
      return padded;
    }
  };
  return { fs, report, async close() {
    chrome.debugger.onEvent.removeListener(listener);
    if (delegated) chrome.webRequest.onHeadersReceived.removeListener(certListener);
    await chrome.debugger.detach(target);
  } };
}
