// Synthetic test only. Does not coordinate handshakes within the same tab.
const params = new URLSearchParams(location.search);
const url = params.get('url');
if (!/^ws:\/\/127\.0\.0\.1:\d+\/socket$/.test(url)) throw Error('Invalid fixture URL');
const tab = await chrome.tabs.getCurrent();
const ruleId = params.get('scope') === 'shared' ? 101 : tab.id;
globalThis.fixtureInstallRule = async cookie => {
  if (!['workspace_session=alpha', 'workspace_session=beta'].includes(cookie)) throw Error('Synthetic cookie required');
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId], addRules: [{ id: ruleId, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'set', value: cookie }] },
    condition: { regexFilter: '^' + escaped + '$', initiatorDomains: [chrome.runtime.id],
      tabIds: [tab.id], resourceTypes: ['websocket'] } }] });
  return { tabId: tab.id, ruleId };
};
globalThis.fixtureOpenSocket = () => new Promise(resolve => {
  const socket = new WebSocket(url);
  const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 5000);
  socket.onopen = () => socket.send('echo');
  socket.onmessage = event => { clearTimeout(timer); socket.close(); resolve(event.data); };
  socket.onerror = () => { clearTimeout(timer); resolve('socket error'); };
});
globalThis.fixtureRemoveRule = () => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
globalThis.fixtureRuleIds = async () => (await chrome.declarativeNetRequest.getSessionRules()).map(rule => rule.id);
// Test-only same-tab gate. Keep the rule only until its own handshake opens;
// established sockets can then run concurrently while another handshake starts.
let handshakeGate = Promise.resolve();
globalThis.fixtureOpenSerialized = cookie => {
  const opening = handshakeGate.then(async () => {
    await fixtureInstallRule(cookie);
    let socket;
    try {
      socket = new WebSocket(url);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('handshake timeout')), 5000);
        socket.onopen = () => { clearTimeout(timer); resolve(); };
        socket.onerror = () => { clearTimeout(timer); reject(Error('handshake failed')); };
      });
      return socket;
    } catch (error) { socket?.close(); throw error; }
    finally { await fixtureRemoveRule(); }
  });
  handshakeGate = opening.then(() => {}, () => {});
  return opening.then(socket => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(Error('echo timeout')); }, 5000);
    socket.onmessage = event => { clearTimeout(timer); socket.close(); resolve(event.data); };
    socket.onerror = () => { clearTimeout(timer); reject(Error('echo failed')); };
    socket.send('echo');
  }));
};
