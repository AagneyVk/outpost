// Anonymous public test. Never allows the next request or submits credentials.
import { validateRedirectBinding } from './redirect-binding.mjs';
const params = new URLSearchParams(location.search);
const local = params.get('local');
if (local && !/^http:\/\/127\.0\.0\.1:\d+\/start$/.test(local)) throw Error('Invalid local fixture');
const url = local || 'https://practice.expandtesting.com/secure';
const gate = params.get('gate') === '1';
const target = { tabId: (await chrome.tabs.getCurrent()).id };
const requests = new Map(), responses = new Map(), extra = new Map(), pauses = [];
const redirects = [], blocked = [], blockResults = [], commandErrors = [];
let initialAllowed = false;
const listener = (source, method, event) => {
  if (source.tabId !== target.tabId) return;
  if (method === 'Network.requestWillBeSent') {
    if (event.redirectResponse) redirects.push({ id: event.requestId, from: event.redirectResponse.url,
      status: event.redirectResponse.status, securityState: event.redirectResponse.securityState,
      hasSecurityDetails: !!event.redirectResponse.securityDetails, protocol: event.redirectResponse.securityDetails?.protocol || null,
      fromDiskCache: !!event.redirectResponse.fromDiskCache, fromServiceWorker: !!event.redirectResponse.fromServiceWorker,
      fromPrefetchCache: !!event.redirectResponse.fromPrefetchCache, to: event.request.url, nextMethod: event.request.method });
    else requests.set(event.requestId, event.request.url);
  }
  if (method === 'Network.responseReceived') responses.set(event.requestId, {
    status: event.response.status, securityState: event.response.securityState,
    hasSecurityDetails: !!event.response.securityDetails });
  if (method === 'Network.responseReceivedExtraInfo') {
    const locations = Object.entries(event.headers || {}).filter(([name]) => name.toLowerCase() === 'location');
    extra.set(event.requestId, { status: event.statusCode, location: locations.length === 1 ? String(locations[0][1]) : null });
  }
  if (method === 'Fetch.requestPaused') {
    if (gate) {
      if (!initialAllowed && event.request.url === url) {
        initialAllowed = true;
        chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId: event.requestId })
          .catch(error => commandErrors.push(String(error)));
      } else {
        blocked.push(event.request.url);
        chrome.debugger.sendCommand(target, 'Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' })
          .then(() => blockResults.push({ url: event.request.url, ok: true }), error => {
            blockResults.push({ url: event.request.url, ok: false }); commandErrors.push(String(error));
          });
      }
      return;
    }
    pauses.push({ networkId: event.networkId, status: event.responseStatusCode,
      hasSecurityDetails: Object.hasOwn(event, 'securityDetails') });
    chrome.debugger.sendCommand(target, 'Fetch.continueResponse', { requestId: event.requestId })
      .catch(error => commandErrors.push(String(error)));
  }
};
try {
  chrome.debugger.onEvent.addListener(listener);
  await chrome.debugger.attach(target, '1.3');
  await chrome.debugger.sendCommand(target, 'Network.enable');
  await chrome.debugger.sendCommand(target, 'Fetch.enable', { patterns: [{ urlPattern: gate ? '*' : url, requestStage: gate ? 'Request' : 'Response' }] });
  let type;
  try {
    const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: gate ? 'follow' : 'manual',
      ...(local ? { method: 'POST', body: 'synthetic=not-secret' } : {}), signal: AbortSignal.timeout(15000) });
    type = response.type;
  } catch (error) { type = error.name; }
  for (let i = 0; i < 80 && !(gate ? blockResults.length : pauses.length); i++) await new Promise(resolve => setTimeout(resolve, 25));
  await new Promise(resolve => setTimeout(resolve, 300));
  const ids = [...requests].filter(([, requestURL]) => requestURL === url).map(([id]) => id);
  let binding = null, bindingError = null;
  if (gate) {
    try { binding = validateRedirectBinding({ initialURL: url, requestId: ids[0], redirects, extra: extra.get(ids[0]), blockResults }); }
    catch (error) { bindingError = String(error.message || error); }
  }
  globalThis.fixtureResult = { type, requestCount: ids.length, redirects, blocked, blockResults, commandErrors, binding, bindingError,
    events: ids.map(id => ({ id, response: responses.get(id) || null, extra: extra.get(id) || null,
      pauses: pauses.filter(pause => pause.networkId === id) })) };
} catch (error) { globalThis.fixtureResult = { error: String(error?.stack || error) }; }
finally { chrome.debugger.onEvent.removeListener(listener); await chrome.debugger.detach(target).catch(() => {}); }
