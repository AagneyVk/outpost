// Test only: one public echo endpoint and synthetic messages, never credentials.
const url = 'wss://echo.websocket.org/';
const tab = await chrome.tabs.getCurrent();
const ruleId = 101;
const matches = [], handshakes = [], sentHandshakes = [], socketIds = new Set();
const debugTarget = { tabId: tab.id };
const debugListener = (source, method, event) => {
  if (source.tabId !== tab.id) return;
  if (method === 'Network.webSocketCreated' && event.url === url) socketIds.add(event.requestId);
  if (method === 'Network.webSocketWillSendHandshakeRequest' && socketIds.has(event.requestId)) {
    const cookies = Object.entries(event.request.headers || {}).filter(([name]) => name.toLowerCase() === 'cookie').map(([, value]) => String(value));
    sentHandshakes.push({ cookieHeaderVisible: cookies.length > 0 });
  }
};
const before = event => {
  if (event.url !== url) return;
  const cookie = (event.requestHeaders || []).filter(header => header.name.toLowerCase() === 'cookie').map(header => header.value || '');
  handshakes.push({ hostCanaryPresent: cookie.some(value => value.includes('host_canary')) });
};
const match = event => { if (event.rule.ruleId === ruleId) matches.push(event.request.url); };
try {
  chrome.debugger.onEvent.addListener(debugListener);
  await chrome.debugger.attach(debugTarget, '1.3');
  await chrome.debugger.sendCommand(debugTarget, 'Network.enable');
  chrome.webRequest.onBeforeSendHeaders.addListener(before,
    { urls: ['wss://echo.websocket.org/*'], types: ['websocket'] }, ['requestHeaders', 'extraHeaders']);
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(match);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId], addRules: [{
    id: ruleId, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'remove' }] },
    condition: { regexFilter: '^wss://echo\\.websocket\\.org/$', initiatorDomains: [chrome.runtime.id],
      tabIds: [tab.id], resourceTypes: ['websocket'] }
  }] });
  let textEcho = false, binaryEcho = false, sentBinary = false;
  const outcome = await new Promise(resolve => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 15000);
    socket.onopen = () => socket.send('OUTPOST-synthetic-echo');
    socket.onmessage = event => {
      if (typeof event.data === 'string' && event.data === 'OUTPOST-synthetic-echo') {
        textEcho = true;
        if (!sentBinary) { sentBinary = true; socket.send(new Uint8Array([0, 127, 128, 255])); }
      } else if (event.data instanceof ArrayBuffer && JSON.stringify([...new Uint8Array(event.data)]) === '[0,127,128,255]') {
        binaryEcho = true;
      }
      if (textEcho && binaryEcho) { clearTimeout(timer); socket.close(); resolve('ok'); }
    };
    socket.onerror = () => { clearTimeout(timer); resolve('socket error'); };
  });
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  globalThis.fixtureResult = { outcome, textEcho, binaryEcho, matches, handshakes, sentHandshakes, cookieIsolationVerified: false,
    remainingRules: (await chrome.declarativeNetRequest.getSessionRules()).map(rule => rule.id) };
} catch (error) { globalThis.fixtureResult = { error: String(error?.stack || error), matches, handshakes }; }
finally {
  chrome.webRequest.onBeforeSendHeaders.removeListener(before);
  chrome.declarativeNetRequest.onRuleMatchedDebug.removeListener(match);
  chrome.debugger.onEvent.removeListener(debugListener);
  await chrome.debugger.detach(debugTarget).catch(() => {});
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
}
