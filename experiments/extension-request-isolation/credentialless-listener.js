// Synthetic localhost test only. Never persist or log real website cookies.
const events = [];
chrome.webRequest.onHeadersReceived.addListener(details => {
  events.push({ url: details.url, tabId: details.tabId, frameId: details.frameId,
    initiator: details.initiator, headers: (details.responseHeaders || []).filter(header => header.name.toLowerCase() === 'set-cookie') });
}, { urls: ['ws://localhost/*', 'http://localhost/*'] }, ['responseHeaders', 'extraHeaders']);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message === 'whoami') respond({ tabId: sender.tab?.id, frameId: sender.frameId });
  else if (message === 'events') respond(events);
  else if (message === 'ping') respond('ready');
  else if (message?.type === 'prepare-restore') {
    const tabId = sender.tab?.id;
    try {
      const source = new URL(sender.url);
      if (sender.id !== chrome.runtime.id || !Number.isInteger(tabId) || sender.frameId !== 0 || source.protocol !== 'chrome-extension:' ||
          source.host !== chrome.runtime.id || !['/empty.html', '/guarded-restore.html'].includes(source.pathname)) throw Error('Invalid fixture caller');
      // Simulates an API failure only in this disposable test extension.
      if (source.searchParams.get('fixture-cleanup-failure') === '1') { respond({ ready: false }); return; }
    } catch { respond({ ready: false }); return; }
    // This disposable fixture reserves its own tab ID as its rule ID. A real
    // extension must allocate and serialize a separate namespace safely.
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] })
      .then(() => respond({ ready: true }), () => respond({ ready: false }));
    return true;
  }
});
