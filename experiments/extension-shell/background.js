// The preview opens its own tab and requests no access to ordinary browser tabs.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('gecko-lab/index.html') });
});
