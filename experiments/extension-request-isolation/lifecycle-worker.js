// Research fixture only: owns all session rules in this disposable extension.
// A real extension needs an explicit rule namespace and a reviewed lifecycle.
const queues = new Map(), connections = new Map();
globalThis.syntheticRequests = [];
chrome.webRequest.onBeforeRequest.addListener(details => globalThis.syntheticRequests.push({
  tabId: details.tabId, initiator: details.initiator, type: details.type
}), { urls: ['wss://localhost/*'] });
const workerRule = 2000000001;
const boot = chrome.declarativeNetRequest.getSessionRules().then(rules =>
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(rule => rule.id) }));
const remove = id => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
function enqueue(id, task) {
  const previous = queues.get(id) || boot;
  const result = previous.catch(() => {}).then(() => boot).then(task);
  queues.set(id, result);
  return result;
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'worker-socket-fixture') { connectWorkerSocket(port); return; }
  const tabId = port.sender?.tab?.id;
  let target;
  try {
    const sender = new URL(port.sender.url);
    if (port.name !== 'lifecycle-fixture' || sender.protocol !== 'chrome-extension:' ||
        sender.host !== chrome.runtime.id || sender.pathname !== '/lifecycle.html' || !Number.isInteger(tabId) || port.sender.frameId !== 0) throw Error('Invalid caller');
    target = sender.searchParams.get('url');
    if (!/^wss:\/\/localhost:\d+\/socket$/.test(target)) throw Error('Invalid synthetic destination');
  } catch { port.disconnect(); return; }
  const state = { port, live: true };
  const previous = connections.get(tabId);
  if (previous) { previous.live = false; try { previous.port.disconnect(); } catch {} }
  connections.set(tabId, state);
  const current = () => state.live && connections.get(tabId) === state;
  const post = message => { if (current()) try { port.postMessage(message); } catch {} };
  enqueue(tabId, async () => { await remove(tabId); if (current()) post({ type: 'ready' }); })
    .catch(() => { try { port.disconnect(); } catch {} });
  port.onMessage.addListener(message => {
    enqueue(tabId, async () => {
      if (!current()) throw Error('Disconnected');
      if (message.op === 'install') {
        if (!['workspace_session=alpha', 'workspace_session=beta'].includes(message.cookie)) throw Error('Synthetic cookie required');
        const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId], addRules: [{
          id: tabId, priority: 2, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'set', value: message.cookie }] },
          condition: { regexFilter: '^' + escaped + '$', initiatorDomains: [chrome.runtime.id], tabIds: [tabId], resourceTypes: ['websocket'] }
        }] });
        if (!current()) { await remove(tabId); throw Error('Disconnected during installation'); }
      } else if (message.op === 'remove') await remove(tabId);
      else if (message.op !== 'ping') throw Error('Unknown operation');
      post({ id: message.id, ok: true });
    }).catch(error => post({ id: message.id, ok: false, error: String(error.message || error) }));
  });
  port.onDisconnect.addListener(() => {
    state.live = false;
    if (connections.get(tabId) === state) {
      connections.delete(tabId);
      enqueue(tabId, () => remove(tabId)).catch(() => {});
    }
  });
});
chrome.tabs.onRemoved.addListener(tabId => enqueue(tabId, () => remove(tabId)).catch(() => {}));

// Worker-owned socket research: the page CSP blocks its own network access.
// This intentionally broad loopback-only rule is unsafe and is a negative control.
let workerGate = boot;
function connectWorkerSocket(port) {
  let target;
  try {
    const sender = new URL(port.sender.url);
    if (sender.protocol !== 'chrome-extension:' || sender.host !== chrome.runtime.id || sender.pathname !== '/worker-client.html' ||
        !Number.isInteger(port.sender?.tab?.id) || port.sender.frameId !== 0) throw Error('Invalid caller');
    target = sender.searchParams.get('url');
    if (!/^wss:\/\/localhost:\d+\/socket$/.test(target)) throw Error('Invalid destination');
  } catch { port.disconnect(); return; }
  let live = true;
  const schedule = task => {
    const result = workerGate.catch(() => {}).then(() => boot).then(task);
    workerGate = result;
    return result;
  };
  const post = message => { if (live) try { port.postMessage(message); } catch {} };
  const install = async cookie => {
    if (!['workspace_session=alpha', 'workspace_session=beta'].includes(cookie)) throw Error('Synthetic cookie required');
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [workerRule], addRules: [{
      id: workerRule, priority: 2, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'set', value: cookie }] },
      condition: { regexFilter: '^' + escaped + '$', resourceTypes: ['websocket'] }
    }] });
    if (!live) { await remove(workerRule); throw Error('Disconnected'); }
  };
  schedule(async () => { await remove(workerRule); post({ type: 'ready' }); }).catch(() => { try { port.disconnect(); } catch {} });
  port.onMessage.addListener(message => {
    schedule(async () => {
      if (!live) throw Error('Disconnected');
      if (message.op !== 'open') throw Error('Invalid operation');
      let socket;
      try {
        await install(message.cookie);
        if (!live) throw Error('Disconnected');
        socket = new WebSocket(target);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Handshake timeout')), 5000);
          socket.onopen = () => { clearTimeout(timer); resolve(); };
          socket.onerror = () => { clearTimeout(timer); reject(Error('Handshake failed')); };
        });
        await remove(workerRule);
        const echo = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Echo timeout')), 5000);
          socket.onmessage = event => { clearTimeout(timer); resolve(event.data); };
          socket.onerror = () => { clearTimeout(timer); reject(Error('Echo failed')); };
          socket.send('echo');
        });
        post({ id: message.id, ok: true, echo });
      } finally { socket?.close(); await remove(workerRule); }
    }).catch(error => post({ id: message.id, ok: false, error: String(error.message || error) }));
  });
  port.onDisconnect.addListener(() => { live = false; schedule(() => remove(workerRule)).catch(() => {}); });
}
