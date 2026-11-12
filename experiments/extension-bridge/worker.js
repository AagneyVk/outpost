// Isolated test fixture: loopback, same-origin and synthetic cookies only.
// This is not a general extension, security boundary, or production transport.
const RULE = 1001;
let active = null;
// Session rules can outlive a service-worker restart. Remove this fixture's
// rule before accepting the next request as well as in each request's cleanup.
let queue = chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE] });
const ownOrigin = chrome.runtime.getURL('').slice(0, -1);

chrome.webRequest.onHeadersReceived.addListener(d => {
  if (!active || d.initiator !== ownOrigin || d.url !== active.url) return;
  active.events.push({
    id: d.requestId,
    status: d.statusCode,
    headers: (d.responseHeaders || []).filter(h =>
      ['location', 'set-cookie', 'content-type'].includes(h.name.toLowerCase())
    ).map(h => ({ name: h.name.toLowerCase(), value: h.value || '' }))
  });
}, { urls: ['http://127.0.0.1/*'], types: ['xmlhttprequest'] }, ['responseHeaders', 'extraHeaders']);

function validate(message, sender) {
  if (!sender.tab || sender.frameId !== 0 || !sender.url) throw Error('top-level page required');
  const source = new URL(sender.url);
  const url = new URL(message.url);
  if (source.protocol !== 'http:' || source.hostname !== '127.0.0.1' ||
      url.origin !== source.origin || url.username || url.password || url.hash ||
      !['/login', '/account', '/slow'].includes(url.pathname) || url.href.length > 300)
    throw Error('fixture origin or path rejected');
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

async function perform(message, sender) {
  const url = validate(message, sender);
  // Drop any stale fixture rule before starting; all operations use one queue.
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE],
    addRules: message.cookie ? [ruleFor(url, message.cookie)] : [] });
  active = { url, events: [] };
  try {
    const r = await fetch(url, { method: message.method, body: message.body,
      credentials: 'omit', cache: 'no-store', redirect: 'manual',
      signal: AbortSignal.timeout(10000) });
    const event = active.events.at(-1);
    if (!event) throw Error('missing response metadata');
    let body = '';
    if (r.type !== 'opaqueredirect') {
      body = await readLimited(r);
    }
    return { ok: true, status: event.status, headers: event.headers, body };
  } finally {
    active = null;
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE] });
  }
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'fixture-request') return;
  const task = queue.then(() => perform(message, sender));
  queue = task.catch(() => {});
  task.then(sendResponse, error => sendResponse({ ok: false, error: String(error.message || error) }));
  return true;
});
