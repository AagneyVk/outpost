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
});
