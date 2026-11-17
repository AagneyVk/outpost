// Synthetic loopback test only. No real credentials or arbitrary destinations.
const params = new URLSearchParams(location.search);
const allowedOrigins = [params.get('a'), params.get('b')];
const valid = allowedOrigins.every(origin => /^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
if (!valid) throw Error('Invalid fixture origins');
const target = { tabId: (await chrome.tabs.getCurrent()).id };
const pending = new Map();
const paused = new Map();
const errors = [];
const cancelledRequests = new Set(), cancellationEvents = [];
const progress = {};
const socketRequests = [], matchedRules = [];
const socketIds = new Set(), sentHandshakes = [];
chrome.webRequest.onBeforeRequest.addListener(event => {
  if (event.type === 'websocket') socketRequests.push({ url: event.url, tabId: event.tabId, initiator: event.initiator });
}, { urls: ['<all_urls>'], types: ['websocket'] });
chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(event => {
  if (event.rule.ruleId === 101) matchedRules.push({ url: event.request.url, tabId: event.request.tabId });
});
const networkExtra = [];
const networkResponses = new Map();
const marker = 'x-outpost-fixture-id';
const listener = (source, method, event) => {
  if (source.tabId !== target.tabId) return;
  if (method === 'Network.webSocketCreated' && allowedOrigins.some(origin => event.url === origin.replace('http:', 'ws:') + '/socket'))
    socketIds.add(event.requestId);
  if (method === 'Network.webSocketWillSendHandshakeRequest' && socketIds.has(event.requestId)) {
    const cookie = Object.entries(event.request.headers || {}).find(([name]) => name.toLowerCase() === 'cookie')?.[1] || '';
    sentHandshakes.push({ cookie });
  }
  if (method === 'Network.responseReceivedExtraInfo') {
    networkExtra.push({ id: event.requestId, status: event.statusCode, headers: event.headers });
    return;
  }
  if (method === 'Network.responseReceived') {
    networkResponses.set(event.requestId, { status: event.response.status, securityState: event.response.securityState });
    return;
  }
  if (method !== 'Fetch.requestPaused') return;
  (async () => {
    const id = event.requestId;
    if (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined) {
      if (event.responseErrorReason && cancelledRequests.has(event.networkId)) {
        cancelledRequests.delete(event.networkId);
        cancellationEvents.push({ networkId: event.networkId, reason: event.responseErrorReason });
        try { await chrome.debugger.sendCommand(target, 'Fetch.failRequest', { requestId: id, errorReason: 'Aborted' }); } catch {}
        return;
      }
      const item = paused.get(id);
      if (!item) throw Error('Unmatched paused response: ' + JSON.stringify({ id, networkId: event.networkId,
        status: event.responseStatusCode, reason: event.responseErrorReason }));
      item.status = event.responseStatusCode;
      item.headers = event.responseHeaders || [];
      await chrome.debugger.sendCommand(target, 'Fetch.continueResponse', { requestId: id });
      item.resolveResponse();
      paused.delete(id);
      return;
    }
    const headers = Object.entries(event.request.headers || {});
    const idHeader = headers.filter(([name]) => name.toLowerCase() === marker);
    const item = idHeader.length === 1 ? pending.get(idHeader[0][1]) : null;
    if (!item || item.url !== event.request.url || item.method !== event.request.method)
      throw Error('Unmatched paused request');
    item.networkId = event.networkId || null;
    const forwarded = headers.filter(([name]) => ![marker, 'cookie'].includes(name.toLowerCase()))
      .map(([name, value]) => ({ name, value: String(value) }));
    if (item.cookie) forwarded.push({ name: 'Cookie', value: item.cookie });
    paused.set(id, item);
    await chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId: id, headers: forwarded });
  })().catch(async error => {
    errors.push(String(error));
    try { await chrome.debugger.sendCommand(target, 'Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }); } catch {}
  });
};

async function request(url, { method = 'GET', body, cookie, stream = false, cancelAfterFirst = false } = {}) {
  if (!allowedOrigins.includes(new URL(url).origin) || !['GET', 'POST'].includes(method))
    throw Error('Fixture destination rejected');
  const token = crypto.randomUUID();
  let resolveResponse;
  const responseObserved = new Promise(resolve => { resolveResponse = resolve; });
  const item = { url, method, cookie, resolveResponse };
  pending.set(token, item);
  try {
    const result = await fetch(url, { method, body, credentials: 'omit', cache: 'no-store',
      redirect: 'manual', headers: { 'X-Outpost-Fixture-Id': token }, signal: AbortSignal.timeout(10000) });
    let responseTimer;
    try {
      await Promise.race([responseObserved, new Promise((_, reject) => { responseTimer = setTimeout(() => reject(Error('Response event timeout')), 5000); })]);
    } finally { clearTimeout(responseTimer); }
    let text = '', streamed = null;
    if (stream) {
      if (!result.body) throw Error('Missing response stream');
      const reader = result.body.getReader();
      streamed = { length: 0, chunks: 0, checksum: 0 };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          streamed.chunks++;
          streamed.length += value.length;
          for (const byte of value) streamed.checksum = (streamed.checksum + byte) % 1000000007;
          if (cancelAfterFirst) {
            cancelledRequests.add(item.networkId);
            setTimeout(() => cancelledRequests.delete(item.networkId), 5000);
            await reader.cancel(); streamed.cancelled = true; break;
          }
        }
      } finally { reader.releaseLock(); }
    } else if (result.type !== 'opaqueredirect') text = await result.text();
    for (let i = 0; i < 100 && !networkExtra.some(event => event.id === item.networkId); i++)
      await new Promise(resolve => setTimeout(resolve, 25));
    const matches = networkExtra.filter(event => event.id === item.networkId);
    if (!item.networkId || matches.length !== 1 || matches[0].status !== item.status)
      throw Error('Missing or ambiguous request-bound response headers');
    const headers = Object.entries(matches[0].headers).flatMap(([name, value]) =>
      String(value).split('\n').map(part => ({ name, value: part })));
    return { status: item.status, type: result.type, headers, networkId: item.networkId,
      networkResponse: networkResponses.get(item.networkId) || null, body: text, streamed };
  } finally {
    pending.delete(token);
    networkResponses.delete(item.networkId);
    for (let i = networkExtra.length - 1; i >= 0; i--) if (networkExtra[i].id === item.networkId) networkExtra.splice(i, 1);
  }
}

try {
  chrome.debugger.onEvent.addListener(listener);
  await chrome.debugger.attach(target, '1.3');
  await chrome.debugger.sendCommand(target, 'Network.enable');
  await chrome.debugger.sendCommand(target, 'Fetch.enable', { patterns: allowedOrigins.flatMap(origin => [
    { urlPattern: origin + '/*', requestStage: 'Request' },
    { urlPattern: origin + '/*', requestStage: 'Response' }
  ]) });
  const login = await request(allowedOrigins[0] + '/login', { method: 'POST', body: 'synthetic-login' });
  progress.login = login;
  const cookie = login.headers.find(h => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith('workspace_session='));
  if (!cookie) throw Error('Synthetic session cookie missing');
  const account = await request(allowedOrigins[0] + '/account', { cookie: cookie.value.split(';')[0] });
  const parallel = await Promise.all(['alpha', 'beta'].map(value =>
    request(allowedOrigins[0] + '/account', { cookie: 'workspace_session=' + value })));
  const parallelSet = await Promise.all(['alpha', 'beta'].map(value =>
    request(allowedOrigins[0] + '/set', { cookie: 'workspace_session=' + value })));
  const upload = await request(allowedOrigins[0] + '/upload', { method: 'POST', body: new Uint8Array([0, 127, 128, 255]) });
  const streamed = await request(allowedOrigins[0] + '/binary', { stream: true });
  const cancelled = await request(allowedOrigins[0] + '/cancel', { stream: true, cancelAfterFirst: true });
  const cross = await request(allowedOrigins[0] + '/cross', { cookie: 'workspace_session=alpha' });
  const external = await request(allowedOrigins[1] + '/external');
  let websocket = null;
  let remainingRules = null;
  if (params.get('websocket') === '1') {
    const socketUrl = allowedOrigins[0].replace('http:', 'ws:') + '/socket';
    const ruleId = 101;
    const useRule = params.get('socketRule') === '1';
    const emptyCookie = params.get('socketEmpty') === '1';
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    if (useRule) {
      const escaped = socketUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: ruleId, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [emptyCookie
          ? { header: 'Cookie', operation: 'remove' }
          : { header: 'Cookie', operation: 'set', value: 'workspace_session=alpha' }] },
        condition: { regexFilter: '^' + escaped + '$', initiatorDomains: [chrome.runtime.id],
          tabIds: [target.tabId], resourceTypes: ['websocket'] } }] });
    }
    try {
      websocket = await new Promise(resolve => {
        const socket = new WebSocket(socketUrl);
        socket.binaryType = 'arraybuffer';
        let first = null;
        const timeout = setTimeout(() => { socket.close(); resolve({ ok: false, error: 'timeout' }); }, 5000);
        socket.onopen = () => socket.send('synthetic-echo');
        socket.onmessage = event => {
          if (first === null) { first = event.data; socket.send(new Uint8Array([0, 127, 128, 255])); return; }
          clearTimeout(timeout); socket.close();
          resolve({ ok: true, text: first, binary: Array.from(new Uint8Array(event.data)) });
        };
        socket.onerror = () => { clearTimeout(timeout); resolve({ ok: false, error: 'socket error' }); };
      });
    } finally { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }); }
    remainingRules = (await chrome.declarativeNetRequest.getSessionRules()).map(rule => rule.id);
  }
  globalThis.fixtureResult = { login, account, parallel, parallelSet, upload, streamed, cancelled, cross, external, websocket, remainingRules, socketRequests, matchedRules, sentHandshakes, cancellationEvents, errors };
} catch (error) {
  globalThis.fixtureResult = { fatal: String(error?.stack || error), errors, progress };
} finally {
  chrome.debugger.onEvent.removeListener(listener);
  await chrome.debugger.detach(target).catch(() => {});
}
