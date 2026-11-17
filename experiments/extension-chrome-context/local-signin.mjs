// TEST ONLY: two fixed loopback GETs and a synthetic session cookie.
// This is neither a general transport nor suitable for real credentials.
export async function createLocalSignInFixture(origin, { form = false } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw Error('Invalid local fixture origin');
  const target = { tabId: (await chrome.tabs.getCurrent()).id };
  const pending = new Map(), paused = new Map(), extra = new Map();
  const errors = [], report = { requests: [] };
  const marker = 'x-outpost-fixture-id';
  const listener = (source, method, event) => {
    if (source.tabId !== target.tabId) return;
    if (method === 'Network.responseReceivedExtraInfo') {
      extra.set(event.requestId, { status: event.statusCode, headers: event.headers });
      return;
    }
    if (method !== 'Fetch.requestPaused') return;
    (async () => {
      if (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined) {
        const item = paused.get(event.requestId);
        if (!item || event.responseErrorReason) throw Error('Unexpected response event');
        item.status = event.responseStatusCode;
        await chrome.debugger.sendCommand(target, 'Fetch.continueResponse', { requestId: event.requestId });
        item.resolve();
        paused.delete(event.requestId);
        return;
      }
      const headers = Object.entries(event.request.headers || {});
      const token = headers.find(([name]) => name.toLowerCase() === marker)?.[1];
      const item = pending.get(token);
      if (!item || item.url !== event.request.url || event.request.method !== item.method) throw Error('Unexpected request');
      item.networkId = event.networkId;
      const forwarded = headers.filter(([name]) => ![marker, 'cookie'].includes(name.toLowerCase()))
        .map(([name, value]) => ({ name, value: String(value) }));
      if (item.cookie) forwarded.push({ name: 'Cookie', value: item.cookie });
      paused.set(event.requestId, item);
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
    { urlPattern: origin + '/*', requestStage: 'Request' },
    { urlPattern: origin + '/*', requestStage: 'Response' }
  ] });
  async function get(path, cookie = '', body) {
    if (!['/login', '/authenticate', '/account'].includes(path) || !['', 'workspace_session=alpha'].includes(cookie) ||
        (path === '/authenticate' ? body !== 'username=demo&password=synthetic' : body !== undefined))
      throw Error('Unexpected fixture destination or cookie');
    const url = origin + path, token = crypto.randomUUID();
    const method = path === '/authenticate' ? 'POST' : 'GET';
    let resolve;
    const observed = new Promise(done => { resolve = done; });
    const item = { url, cookie, resolve, method };
    pending.set(token, item);
    try {
      const response = await fetch(url, { method, body, headers: { 'X-Outpost-Fixture-Id': token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
        credentials: 'omit', cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(10000) });
      let timer;
      try { await Promise.race([observed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Fixture response timeout')), 5000); })]); }
      finally { clearTimeout(timer); }
      const responseBody = response.type === 'opaqueredirect' ? '' : await response.text();
      for (let i = 0; i < 100 && !extra.has(item.networkId); i++) await new Promise(done => setTimeout(done, 25));
      const metadata = extra.get(item.networkId);
      if (!metadata || metadata.status !== item.status) throw Error('Missing request-bound headers');
      const headers = Object.entries(metadata.headers).flatMap(([name, value]) =>
        String(value).split('\n').map(part => ({ name: name.toLowerCase(), value: part })));
      report.requests.push({ path, method, cookieSent: !!cookie, status: item.status });
      return { status: item.status, headers, body: responseBody };
    } finally { pending.delete(token); extra.delete(item.networkId); }
  }
  const fs = {
    async stat(path) {
      return (['outpost-fixture-login', 'outpost-fixture-account-with-cookie', 'outpost-fixture-account-without-cookie'].includes(path) ||
        (form && path.startsWith('outpost-fixture-local-auth-')))
        ? { size: 262144, isDir: false } : null;
    },
    async readdir() { return []; },
    async readFile(path) {
      const login = path === 'outpost-fixture-login';
      const hasCookie = path === 'outpost-fixture-account-with-cookie';
      const auth = form && path.startsWith('outpost-fixture-local-auth-');
      if (!login && !auth && !hasCookie && path !== 'outpost-fixture-account-without-cookie') throw Error('Unexpected fixture path');
      let body;
      if (auth) {
        const encoded = path.slice('outpost-fixture-local-auth-'.length).replace(/~/g, '+').replace(/_/g, '/');
        body = new TextDecoder().decode(Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')), c => c.charCodeAt(0)));
      }
      const response = await get(login ? '/login' : auth ? '/authenticate' : '/account', hasCookie ? 'workspace_session=alpha' : '', body);
      const location = response.headers.find(header => header.name === 'location')?.value || '';
      const cookies = response.headers.filter(header => header.name === 'set-cookie').map(header => header.value);
      if (cookies.length > 2 || [location, ...cookies].some(value => /[\r\n]/.test(value))) throw Error('Invalid fixture headers');
      const wire = [String(response.status), location, cookies[0] || '', cookies[1] || '',
        'text/html; charset=utf-8', '', '', response.body].join('\n');
      const bytes = new TextEncoder().encode(wire);
      if (bytes.length >= 262144) throw Error('Fixture response too large');
      const padded = new Uint8Array(262144); padded.set(bytes); return padded;
    }
  };
  return { fs, report, errors, async close() {
    chrome.debugger.onEvent.removeListener(listener);
    await chrome.debugger.detach(target);
  } };
}
