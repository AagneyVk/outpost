// Synthetic, anonymous, fixed-origin research only. Not a general proxy.
import { validateResponseBinding } from './response-binding.mjs';
import { combineBase64Capture } from './capture-bytes.mjs';
const urls = [
  'https://example.com/', 'https://example.org/',
  'https://www.rfc-editor.org/rfc/rfc9111.txt', 'https://www.iana.org/static/_img/2022/iana-logo-header.svg',
  'https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png'
];
const target = { tabId: (await chrome.tabs.getCurrent()).id }, marker = 'x-outpost-fixture-id';
const maxBodyBytes = 2 * 1024 * 1024;
const pending = new Map(), requests = new Map(), responses = new Map(), extra = new Map();
const streams = new Map();
const finished = new Set(), failures = new Map(), redirects = new Set(), redirectEvents = [], errors = [];
const listener = (source, method, event) => {
  if (source.tabId !== target.tabId) return;
  if (method === 'Network.requestWillBeSent') {
    if (event.redirectResponse) { redirects.add(event.requestId); redirectEvents.push({ from: event.redirectResponse.url, status: event.redirectResponse.status, to: event.request.url }); }
    else requests.set(event.requestId, event.request.url);
  }
  if (method === 'Network.requestWillBeSentExtraInfo') extra.set(event.requestId, event.headers);
  if (method === 'Network.responseReceived') {
    responses.set(event.requestId, event.response);
    const stream = { chunks: [] };
    streams.set(event.requestId, stream);
    stream.ready = chrome.debugger.sendCommand(target, 'Network.streamResourceContent', { requestId: event.requestId })
      .then(result => { stream.buffered = result.bufferedData; }, error => { stream.error = String(error); });
  }
  if (method === 'Network.dataReceived' && event.data && streams.has(event.requestId)) {
    const stream = streams.get(event.requestId);
    stream.encodedLength = (stream.encodedLength || 0) + event.data.length;
    if (stream.encodedLength > Math.ceil(maxBodyBytes / 3) * 4 + 4) stream.tooLarge = true;
    else stream.chunks.push(event.data);
  }
  if (method === 'Network.loadingFinished') finished.add(event.requestId);
  if (method === 'Network.loadingFailed') failures.set(event.requestId, event.errorText);
  if (method !== 'Fetch.requestPaused') return;
  (async () => {
    const headers = Object.entries(event.request.headers || {});
    const tokens = headers.filter(([name]) => name.toLowerCase() === marker);
    const item = tokens.length === 1 ? pending.get(tokens[0][1]) : null;
    if (!item || item.networkId || item.url !== event.request.url || event.request.method !== 'GET') {
      await chrome.debugger.sendCommand(target, 'Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' });
      return;
    }
    item.networkId = event.networkId;
    const forwarded = headers.filter(([name]) => ![marker, 'cookie'].includes(name.toLowerCase()))
      .map(([name, value]) => ({ name, value: String(value) }));
    await chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId: event.requestId, headers: forwarded });
  })().catch(async error => {
    errors.push(String(error));
    try { await chrome.debugger.sendCommand(target, 'Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }); } catch {}
  });
};
async function request(url) {
  const token = crypto.randomUUID(), item = { url };
  pending.set(token, item);
  try {
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { 'X-Outpost-Fixture-Id': token }, signal: AbortSignal.timeout(20000) });
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBodyBytes) throw Error('Response exceeds fixture limit');
    if (!response.body) throw Error('Missing response body');
    const reader = response.body.getReader(), parts = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBodyBytes) { await reader.cancel(); throw Error('Response exceeds fixture limit'); }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = new Uint8Array(total);
    let bodyOffset = 0;
    for (const part of parts) { body.set(part, bodyOffset); bodyOffset += part.length; }
    for (let i = 0; i < 200 && (!item.networkId || !responses.has(item.networkId) || !extra.has(item.networkId) || !finished.has(item.networkId)); i++)
      await new Promise(resolve => setTimeout(resolve, 25));
    if (!item.networkId || !extra.has(item.networkId) || !finished.has(item.networkId)) throw Error('Missing request-bound network evidence');
    const sent = Object.entries(extra.get(item.networkId));
    if (sent.some(([name]) => ['cookie', marker].includes(name.toLowerCase()))) throw Error('Unexpected private request header');
    const stream = streams.get(item.networkId);
    if (!stream) throw Error('Missing request-bound response stream');
    await stream.ready;
    let capturedBody, capture;
    if (!stream.error && typeof stream.buffered === 'string') {
      if (stream.tooLarge) throw Error('Response stream exceeds fixture limit');
      capturedBody = combineBase64Capture([stream.buffered, ...stream.chunks], maxBodyBytes);
      capture = 'stream';
    } else {
      const result = await chrome.debugger.sendCommand(target, 'Network.getResponseBody', { requestId: item.networkId });
      capturedBody = result.base64Encoded ? combineBase64Capture([result.body], maxBodyBytes) : new TextEncoder().encode(result.body);
      if (capturedBody.length > maxBodyBytes) throw Error('Response capture exceeds fixture limit');
      capture = result.base64Encoded ? 'body-base64' : 'body-text';
    }
    if (body.length !== capturedBody.length || body.some((byte, index) => byte !== capturedBody[index])) {
      const firstDifference = body.findIndex((byte, index) => byte !== capturedBody[index]);
      throw Error(`Response body did not match network stream (bytes ${body.length}/${capturedBody.length}, first difference ${firstDifference})`);
    }
    const binding = validateResponseBinding({ url, status: response.status, finalURL: response.url, body, capturedBody,
      requests: new Map([[item.networkId, requests.get(item.networkId)]]),
      responses: new Map([[item.networkId, responses.get(item.networkId)]]), failures, redirects });
    if (!['TLS 1.2', 'TLS 1.3'].includes(binding.security.protocol)) throw Error('Unsupported TLS state');
    const pngSignature = url.endsWith('.png') ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => body[index] === byte) : undefined;
    return { url, status: response.status, contentType: response.headers.get('content-type'), size: body.length,
      protocol: binding.security.protocol, capture, ...(pngSignature === undefined ? {} : { pngSignature }), hostCookieSent: false, privateMarkerSent: false };
  } catch (error) {
    for (let i = 0; i < 40 && item.networkId && !failures.has(item.networkId) && !finished.has(item.networkId); i++) await new Promise(resolve => setTimeout(resolve, 25));
    const failure = item.networkId && failures.get(item.networkId);
    const redirect = redirectEvents.find(event => event.from === url);
    throw Error(String(error) + (failure ? ' [' + failure + ']' : '') + (redirect ? ' [redirect ' + redirect.status + ']' : ''));
  } finally { pending.delete(token); }
}
try {
  chrome.debugger.onEvent.addListener(listener);
  await chrome.debugger.attach(target, '1.3');
  await chrome.debugger.sendCommand(target, 'Network.enable');
  await chrome.debugger.sendCommand(target, 'Fetch.enable', { patterns: [{ urlPattern: 'https://*/*', requestStage: 'Request' }] });
  const results = await Promise.allSettled(urls.map(request));
  globalThis.fixtureResult = { results: results.map((result, index) => result.status === 'fulfilled'
    ? result.value : { url: urls[index], error: String(result.reason) }), errors };
} catch (error) { globalThis.fixtureResult = { fatal: String(error), errors }; }
finally { chrome.debugger.onEvent.removeListener(listener); await chrome.debugger.detach(target).catch(() => {}); }
