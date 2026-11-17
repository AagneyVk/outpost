// TEST ONLY: one outstanding anonymous request to a three-URL allowlist.
const ALLOWED = ['https://example.com/', 'https://expired.badssl.com/', 'https://self-signed.badssl.com/', 'https://example.org/'];
let active = null;
browser.webRequest.onHeadersReceived.addListener(async function (details) {
  if (!active || details.url !== active.url) return {};
  if (!details.originUrl || !details.originUrl.startsWith(browser.runtime.getURL(''))) {
    active.metadataError = 'request initiator does not match extension origin';
    return {};
  }
  try {
    const info = await browser.webRequest.getSecurityInfo(details.requestId,
      { certificateChain: true, rawDER: true });
    active.response = { id: details.requestId, status: details.statusCode, state: info.state,
      protocol: info.protocolVersion || null, hsts: info.hsts === true,
      certificates: (info.certificates || []).map(cert => Array.from(cert.rawDER || [])) };
  } catch (error) { active.metadataError = String(error); }
  return {};
}, { urls: ALLOWED.map(url => url + '*'), types: ['xmlhttprequest'] }, ['blocking']);
browser.webRequest.onErrorOccurred.addListener(function (details) {
  if (active && details.url === active.url) active.networkError = details.error;
}, { urls: ALLOWED.map(url => url + '*'), types: ['xmlhttprequest'] });

browser.runtime.onMessage.addListener(async function (message, sender) {
  if (!message || message.type !== 'fixture-fetch') return;
  if (!sender.tab || sender.frameId !== 0 || sender.url !== TEST_PAGE ||
      !ALLOWED.includes(message.url) || active) return { ok: false, error: 'fixture request rejected' };
  active = { url: message.url };
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 10000);
  try {
    const response = await fetch(message.url, { credentials: 'omit', cache: 'no-store',
      redirect: 'error', signal: controller.signal });
    const body = await response.text();
    const metadata = active.response;
    if (!metadata || metadata.state !== 'secure' || metadata.status !== response.status ||
        !metadata.certificates.length || metadata.certificates.some(cert => !cert.length))
      return { ok: false, error: 'missing request-bound verified certificate metadata' };
    if (body.length > 10000) return { ok: false, error: 'fixture body too large' };
    return { ok: true, status: response.status, body: body, security: metadata };
  } catch (error) {
    await new Promise(function (resolve) { setTimeout(resolve, 250); });
    return { ok: false, error: String(error), networkError: active.networkError || null };
  } finally { clearTimeout(timer); active = null; }
});

browser.tabs.create({ url: TEST_PAGE });
