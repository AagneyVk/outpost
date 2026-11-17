// TEST ONLY. Three exact URLs and the public demo credentials; never use real credentials.
import { validateResponseBinding } from './response-binding.mjs';
import { validateRedirectBinding } from './redirect-binding.mjs';
export async function createPublicSignInFixture({ logout = false } = {}) {
  const origin = 'https://practice.expandtesting.com';
  const target = { tabId: (await chrome.tabs.getCurrent()).id };
  const pending = new Map(), byNetwork = new Map(), requests = new Map(), responses = new Map();
  const extra = new Map(), requestExtra = new Map(), completed = new Set(), failures = new Map();
  const redirects = [], blockResults = [], errors = [];
  const report = { requests: [] };
  const marker = 'x-outpost-fixture-id';
  const listener = (source, method, event) => {
    if (source.tabId !== target.tabId) return;
    if (method === 'Network.requestWillBeSent') {
      if (event.redirectResponse) redirects.push({ id: event.requestId, from: event.redirectResponse.url,
        status: event.redirectResponse.status, securityState: event.redirectResponse.securityState,
        protocol: event.redirectResponse.securityDetails?.protocol || null,
        fromDiskCache: !!event.redirectResponse.fromDiskCache, fromServiceWorker: !!event.redirectResponse.fromServiceWorker,
        fromPrefetchCache: !!event.redirectResponse.fromPrefetchCache, to: event.request.url });
      else requests.set(event.requestId, event.request.url);
    }
    if (method === 'Network.responseReceived') responses.set(event.requestId, event.response);
    if (method === 'Network.responseReceivedExtraInfo') extra.set(event.requestId, { status: event.statusCode, headers: event.headers });
    if (method === 'Network.requestWillBeSentExtraInfo') requestExtra.set(event.requestId, event.headers);
    if (method === 'Network.loadingFinished') completed.add(event.requestId);
    if (method === 'Network.loadingFailed') failures.set(event.requestId, event.errorText);
    if (method !== 'Fetch.requestPaused') return;
    (async () => {
      const headers = Object.entries(event.request.headers || {});
      const token = headers.find(([name]) => name.toLowerCase() === marker)?.[1];
      const item = pending.get(token);
      if (!item || item.networkId) {
        await chrome.debugger.sendCommand(target, 'Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' });
        blockResults.push({ url: event.request.url, networkId: event.networkId, ok: true });
        return;
      }
      if (item.url !== event.request.url || item.method !== event.request.method)
        throw Error('Unexpected or duplicate fixture request');
      item.networkId = event.networkId;
      byNetwork.set(item.networkId, item);
      const forwarded = headers.filter(([name]) => ![marker, 'cookie', 'origin', 'referer'].includes(name.toLowerCase()))
        .map(([name, value]) => ({ name, value: String(value) }));
      if (item.cookie) forwarded.push({ name: 'Cookie', value: item.cookie });
      if (item.method === 'POST') forwarded.push({ name: 'Origin', value: origin }, { name: 'Referer', value: origin + '/login' });
      await chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId: event.requestId, headers: forwarded });
    })().catch(async error => {
      errors.push(String(error));
      try { await chrome.debugger.sendCommand(target, 'Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }); } catch {}
    });
  };
  chrome.debugger.onEvent.addListener(listener);
  await chrome.debugger.attach(target, '1.3');
  await chrome.debugger.sendCommand(target, 'Network.enable');
  await chrome.debugger.sendCommand(target, 'Fetch.enable', { patterns: [
    { urlPattern: 'http://*/*', requestStage: 'Request' },
    { urlPattern: 'https://*/*', requestStage: 'Request' }
  ] });
  async function perform(path, method, body, cookie) {
    if (![['/login', 'GET'], ['/authenticate', 'POST'], ['/secure', 'GET'], ...(logout ? [['/logout', 'GET']] : [])].some(([p, m]) => p === path && m === method))
      throw Error('Unexpected public demo request');
    if (method === 'POST') {
      const form = new URLSearchParams(body);
      if (form.get('username') !== 'practice' || form.get('password') !== 'SuperSecretPassword!' ||
          [...form.keys()].length !== 2) throw Error('Only public demo credentials are permitted');
    } else if (body !== undefined) throw Error('Unexpected body');
    if (cookie && (!/^[\x20-\x7e]{1,170}$/.test(cookie) || cookie.includes('host_canary'))) throw Error('Invalid synthetic cookie');
    const url = origin + path, token = crypto.randomUUID(), item = { url, method, cookie };
    pending.set(token, item);
    let response, failure;
    try {
      try { response = await fetch(url, { method, body, headers: { 'X-Outpost-Fixture-Id': token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
        credentials: 'omit', cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(15000) }); }
      catch (error) { failure = error; }
      for (let i = 0; i < 200 && (!item.networkId || !extra.has(item.networkId) || !requestExtra.has(item.networkId) ||
        (failure ? !blockResults.length : !responses.has(item.networkId))); i++) await new Promise(resolve => setTimeout(resolve, 25));
      if (!item.networkId || !extra.has(item.networkId) || !requestExtra.has(item.networkId)) throw Error('Missing network metadata');
      const meta = extra.get(item.networkId);
      const outgoingHeaders = Object.entries(requestExtra.get(item.networkId));
      if (outgoingHeaders.some(([name]) => name.toLowerCase() === marker)) throw Error('Private fixture marker reached the network');
      const outgoingCookies = outgoingHeaders.filter(([name]) => name.toLowerCase() === 'cookie').map(([, value]) => String(value));
      if (outgoingCookies.some(value => value.includes('host_canary')) ||
          (cookie ? outgoingCookies.join('; ') !== cookie : outgoingCookies.length !== 0)) throw Error('Cookie isolation failed');
      const headers = Object.entries(meta.headers).flatMap(([name, value]) => String(value).split('\n').map(part => ({ name: name.toLowerCase(), value: part })));
      const locations = headers.filter(header => header.name === 'location');
      let protocol, responseBody = '', redirected = false;
      if (failure) {
        if (failure.name !== 'TypeError' || locations.length !== 1) throw Error('Unexpected fetch failure');
        const candidates = redirects.filter(event => event.id === item.networkId);
        const blocks = blockResults.filter(event => event.networkId === item.networkId && candidates.some(redirect => redirect.to === event.url));
        const binding = validateRedirectBinding({ initialURL: url, requestId: item.networkId, redirects: candidates,
          extra: { status: meta.status, location: locations[0].value }, blockResults: blocks });
        const expectedPath = path === '/authenticate' ? '/secure' : logout && (path === '/logout' || path === '/secure') ? '/login' : null;
        if (new URL(binding.to).origin !== origin || new URL(binding.to).pathname !== expectedPath) throw Error('Unexpected demo redirect');
        protocol = binding.protocol; redirected = true;
      } else {
        const bodyBytes = new Uint8Array(await response.arrayBuffer());
        for (let i = 0; i < 80 && !completed.has(item.networkId); i++) await new Promise(resolve => setTimeout(resolve, 25));
        if (!completed.has(item.networkId)) throw Error('Network response did not complete');
        const captured = await chrome.debugger.sendCommand(target, 'Network.getResponseBody', { requestId: item.networkId });
        const capturedBody = captured.base64Encoded ? Uint8Array.from(atob(captured.body), c => c.charCodeAt(0)) : new TextEncoder().encode(captured.body);
        const binding = validateResponseBinding({ url, status: response.status, finalURL: response.url, body: bodyBytes, capturedBody,
          requests: new Map([[item.networkId, requests.get(item.networkId)]]),
          responses: new Map([[item.networkId, responses.get(item.networkId)]]), failures,
          redirects: new Set(redirects.map(event => event.id)) });
        protocol = binding.security.protocol;
        responseBody = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);
      }
      const tls = protocol === 'TLS 1.3' ? 'TLSv1.3' : protocol === 'TLS 1.2' ? 'TLSv1.2' : null;
      if (!tls) throw Error('Unsupported test TLS version');
      const cookies = headers.filter(header => header.name === 'set-cookie').map(header => header.value);
      const hsts = headers.find(header => header.name === 'strict-transport-security')?.value || '';
      if (cookies.length > 2 || [hsts, ...cookies].some(value => /[\r\n]/.test(value))) throw Error('Invalid headers');
      report.requests.push({ path, method, status: meta.status, secure: true, redirectBlocked: redirected, cookieCount: cookies.length, hostCookieSent: false });
      return { status: meta.status, location: locations[0]?.value || '', cookies, hsts, body: responseBody, tls };
    } finally { pending.delete(token); }
  }
  const fs = {
    async stat(path) { return path === 'outpost-fixture-demo-login' || path.startsWith('outpost-fixture-demo-auth-') || path.startsWith('outpost-fixture-demo-secure-') ||
      (logout && path.startsWith('outpost-fixture-demo-logout-'))
      ? { size: 262144, isDir: false } : null; },
    async readdir() { return []; },
    async readFile(path) {
      let suffix, method = 'GET', body, cookie = '';
      const decode = value => value === '-' ? '' : new TextDecoder().decode(Uint8Array.from(atob(value.replace(/~/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0)));
      if (path === 'outpost-fixture-demo-login') suffix = '/login';
      else if (path.startsWith('outpost-fixture-demo-auth-')) { suffix = '/authenticate'; method = 'POST'; body = decode(path.slice('outpost-fixture-demo-auth-'.length)); }
      else if (path.startsWith('outpost-fixture-demo-secure-')) { suffix = '/secure'; cookie = decode(path.slice('outpost-fixture-demo-secure-'.length)); }
      else if (logout && path.startsWith('outpost-fixture-demo-logout-')) { suffix = '/logout'; cookie = decode(path.slice('outpost-fixture-demo-logout-'.length)); }
      else throw Error('Unexpected public fixture path');
      const r = await perform(suffix, method, body, cookie);
      const wire = [String(r.status), r.location, r.cookies[0] || '', r.cookies[1] || '', 'text/html; charset=utf-8',
        ['v3', r.tls].join(':'), r.hsts, r.body].join('\n');
      const bytes = new TextEncoder().encode(wire);
      if (bytes.length >= 262144) throw Error('Demo response too large');
      const padded = new Uint8Array(262144); padded.set(bytes); return padded;
    }
  };
  return { fs, report, errors, async close() { chrome.debugger.onEvent.removeListener(listener); await chrome.debugger.detach(target); } };
}
