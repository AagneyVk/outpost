// Isolated test fixture: loopback, same-origin and synthetic cookies only.
// This is not a general extension, security boundary, or production transport.
const RULE = 1001;
const MAX_PENDING_REQUESTS = 16;
let active = null;
let pendingRequests = 0;
// Session rules can outlive a service-worker restart. Remove this fixture's
// rule before accepting the next request as well as in each request's cleanup.
let queue = chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE] });
const ownOrigin = chrome.runtime.getURL('').slice(0, -1);
const targets = ['http://127.0.0.1/*', 'https://example.com/*',
  'https://expired.badssl.com/*', 'https://self-signed.badssl.com/*'];

chrome.webRequest.onErrorOccurred.addListener(d => {
  if (active && d.initiator === ownOrigin && d.url === active.url) {
    active.networkError = d.error;
    active.resolveNetworkError(d.error);
  }
}, { urls: targets, types: ['xmlhttprequest'] });

chrome.webRequest.onHeadersReceived.addListener(d => {
  if (!active || d.initiator !== ownOrigin || d.url !== active.url) return;
  active.events.push({
    id: d.requestId,
    status: d.statusCode,
    headers: (d.responseHeaders || []).filter(h =>
      ['location', 'set-cookie', 'content-type'].includes(h.name.toLowerCase())
    ).map(h => ({ name: h.name.toLowerCase(), value: h.value || '' }))
  });
}, { urls: targets, types: ['xmlhttprequest'] }, ['responseHeaders', 'extraHeaders']);

// Diagnostic only: this listener may be unavailable unless a Chrome feature
// flag is enabled. The normal response listener above must remain independent.
chrome.webRequest.onHeadersReceived.addListener(d => {
  if (!active || d.initiator !== ownOrigin || d.url !== active.url || !d.securityInfo) return;
  active.securityById.set(d.requestId, {
    state: d.securityInfo.state,
    certificateCount: d.securityInfo.certificates?.length || 0,
    firstCertificateDerBytes: d.securityInfo.certificates?.[0]?.rawDER?.byteLength || 0
  });
}, { urls: ['https://example.com/*'], types: ['xmlhttprequest'] }, ['securityInfo', 'securityInfoRawDer']);

function validate(message, sender) {
  if (!sender.tab || sender.frameId !== 0 || !sender.url) throw Error('top-level page required');
  const source = new URL(sender.url);
  const url = new URL(message.url);
  if (source.protocol !== 'http:' || source.hostname !== '127.0.0.1' ||
      url.username || url.password || url.hash || url.href.length > 300)
    throw Error('fixture origin or path rejected');
  const publicTest = ['https://example.com/', 'https://example.com/s.js', 'https://expired.badssl.com/',
    'https://self-signed.badssl.com/'].includes(url.href);
  if (publicTest) {
    if (message.method !== 'GET' || message.body !== undefined || message.cookie !== undefined)
      throw Error('public fixture is GET-only and anonymous');
  } else if (url.origin !== source.origin || !['/login', '/account', '/slow'].includes(url.pathname)) {
    throw Error('fixture origin or path rejected');
  }
  if (!['GET', 'POST'].includes(message.method)) throw Error('method rejected');
  if (message.body !== undefined && (typeof message.body !== 'string' || message.body.length > 100))
    throw Error('body rejected');
  if (message.cookie !== undefined && !/^workspace_session=(alpha|beta)$/.test(message.cookie))
    throw Error('only test cookies allowed');
  return url.href;
}

function ruleFor(url, cookie) {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    id: RULE, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'set', value: cookie }] },
    condition: { regexFilter: '^' + escaped + '$', isUrlFilterCaseSensitive: true,
      initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] }
  };
}

async function readLimited(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 4096) {
        await reader.cancel();
        throw Error('fixture response too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

async function perform(message, sender, url) {
  // Drop any stale fixture rule before starting; all operations use one queue.
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE],
    addRules: message.cookie ? [ruleFor(url, message.cookie)] : [] });
  let resolveNetworkError;
  const networkErrorPromise = new Promise(resolve => { resolveNetworkError = resolve; });
  active = { url, events: [], securityById: new Map(), resolveNetworkError };
  try {
    const r = await fetch(url, { method: message.method, body: message.body,
      credentials: 'omit', cache: 'no-store', redirect: 'manual',
      signal: AbortSignal.timeout(10000) });
    const event = active.events.at(-1);
    if (!event) throw Error('missing response metadata');
    let body = '';
    if (r.type === 'opaqueredirect') {
      const locations = event.headers.filter(header => header.name === 'location');
      if (locations.length !== 1) throw Error('fixture redirect must have one location');
      const destination = new URL(locations[0].value, url);
      if (destination.origin !== new URL(url).origin)
        throw Error('cross-origin fixture redirect rejected');
      validate({ url: destination.href, method: 'GET' }, sender);
    } else {
      body = await readLimited(r);
    }
    return { ok: true, status: event.status, headers: event.headers, body, security: active.securityById.get(event.id) || null };
  } catch (error) {
    const networkError = active.networkError || await Promise.race([
      networkErrorPromise, new Promise(resolve => setTimeout(() => resolve(null), 1000))
    ]);
    return { ok: false, error: String(error.message || error), networkError };
  } finally {
    active = null;
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE] });
  }
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'fixture-request') return;
  let url;
  try {
    url = validate(message, sender);
    if (pendingRequests >= MAX_PENDING_REQUESTS) throw Error('fixture request queue full');
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
    return;
  }
  pendingRequests++;
  const task = queue.then(() => perform(message, sender, url)).finally(() => { pendingRequests--; });
  queue = task.catch(() => {});
  task.then(sendResponse, error => sendResponse({ ok: false, error: String(error.message || error) }));
  return true;
});
