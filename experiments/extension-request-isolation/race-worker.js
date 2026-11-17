// Disposable fixture: this addon reserves every session-rule ID for its tab ID.
// A real extension must allocate a namespace and coordinate worker restarts.
chrome.tabs.onRemoved.addListener(tabId => {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
});
