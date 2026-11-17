// Isolated, anonymous single-request capability probe; not product code.
const url = 'https://example.com/';
const events = [];
const controlEvents = [];
chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.url === url) controlEvents.push({ requestId: details.requestId, statusCode: details.statusCode });
}, { urls: [url + '*'], types: ['xmlhttprequest'] });
let registration = 'ok';
try {
  chrome.webRequest.onHeadersReceived.addListener(details => {
    if (details.url !== url) return;
    const security = details.securityInfo;
    const certs = security?.certificates || [];
    events.push({ requestId: details.requestId, url: details.url, statusCode: details.statusCode,
      state: security?.state || null, certs: certs.map(cert => ({
        fingerprint: cert.fingerprint?.sha256 || null,
        rawDER: cert.rawDER ? Array.from(new Uint8Array(cert.rawDER)) : null
      })) });
  }, { urls: [url + '*'], types: ['xmlhttprequest'] }, ['securityInfo', 'securityInfoRawDer']);
} catch (error) { registration = String(error); }
let fetchResult;
try {
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(10000) });
  await response.arrayBuffer();
  fetchResult = { status: response.status, finalURL: response.url };
} catch (error) { fetchResult = { error: String(error) }; }
await new Promise(resolve => setTimeout(resolve, 200));
for (const event of events) {
  for (const cert of event.certs) {
    if (cert.rawDER?.length) {
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(cert.rawDER));
      cert.computedFingerprint = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
      cert.derLength = cert.rawDER.length;
      delete cert.rawDER;
    }
  }
}
globalThis.probeResult = { registration, fetch: fetchResult, controlEvents, events };
