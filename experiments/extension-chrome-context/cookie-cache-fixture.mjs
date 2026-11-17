// Disposable loopback-only research fixture. Never pass real cookies or data.
export async function createCookieCacheFixture(origin, { extended = false } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw Error('Invalid loopback origin');
  const target = { tabId: (await chrome.tabs.getCurrent()).id };
  const pending = new Map(), paused = new Map(), extra = new Map(), expectedInterruptions = new Map(), errors = [];
  const report = { requests: [], interruptions: [] }, marker = 'x-outpost-fixture-id';
  const listener = (source, method, event) => {
    if (source.tabId !== target.tabId) return;
    if (method === 'Network.responseReceivedExtraInfo') {
      extra.set(event.requestId, { status: event.statusCode, headers: event.headers }); return;
    }
    if (method !== 'Fetch.requestPaused') return;
    (async () => {
      if (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined) {
        if (event.responseErrorReason && expectedInterruptions.has(event.networkId)) {
          clearTimeout(expectedInterruptions.get(event.networkId)); expectedInterruptions.delete(event.networkId);
          report.interruptions.push({ reason: event.responseErrorReason });
          try { await chrome.debugger.sendCommand(target, 'Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }); } catch {}
          return;
        }
        const item = paused.get(event.requestId);
        if (!item || event.responseErrorReason) throw Error('Unexpected fixture response');
        item.status = event.responseStatusCode;
        await chrome.debugger.sendCommand(target, 'Fetch.continueResponse', { requestId: event.requestId });
        item.resolve(); paused.delete(event.requestId); return;
      }
      const headers = Object.entries(event.request.headers || {});
      const token = headers.find(([name]) => name.toLowerCase() === marker)?.[1];
      const item = pending.get(token);
      if (!item || item.url !== event.request.url || event.request.method !== 'GET') throw Error('Unexpected fixture request');
      item.networkId = event.networkId;
      if (item.url.endsWith('/matrix/truncated') && item.networkId)
        expectedInterruptions.set(item.networkId, setTimeout(() => expectedInterruptions.delete(item.networkId), 15000));
      const forwarded = headers.filter(([name]) => ![marker, 'cookie', 'if-none-match', ...(item.language ? ['accept-language'] : [])].includes(name.toLowerCase()))
        .map(([name, value]) => ({ name, value: String(value) }));
      if (item.cookie) forwarded.push({ name: 'Cookie', value: item.cookie });
      if (item.validator) forwarded.push({ name: 'If-None-Match', value: item.validator });
      if (item.language) forwarded.push({ name: 'Accept-Language', value: item.language });
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
    { urlPattern: origin + '/*', requestStage: 'Request' }, { urlPattern: origin + '/*', requestStage: 'Response' }
  ] });
  async function get(path, cookie, validator, language = '') {
    const paths = ['/matrix/home', '/matrix/set', '/matrix/set-extra', '/matrix/private/echo', '/matrix/echo', '/matrix/delete', '/matrix/cache', '/matrix/versioned', '/matrix/fresh', '/matrix/no-store', ...(extended ? ['/matrix/vary', '/matrix/cookie-vary', '/matrix/binary', '/matrix/image', '/matrix/truncated'] : [])];
    const cookieParts = cookie ? cookie.split('; ') : [];
    if (!paths.includes(path) || cookieParts.some(part => !['workspace=alpha', 'scoped=beta', 'client=synthetic', 'cached_token=synthetic'].includes(part)) ||
        new Set(cookieParts).size !== cookieParts.length ||
        !['', '"fixture-v1"', '"fixture-v2"'].includes(validator) ||
        (path === '/matrix/vary' ? !['en', 'fr'].includes(language) : !!language)) throw Error('Unexpected synthetic fixture input');
    const url = origin + path, token = crypto.randomUUID();
    let resolve;
    const observed = new Promise(done => { resolve = done; });
    const item = { url, cookie, validator, language, resolve };
    pending.set(token, item);
    try {
      const response = await fetch(url, { headers: { 'X-Outpost-Fixture-Id': token }, credentials: 'omit',
        cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(10000) });
      let timer;
      try { await Promise.race([observed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Fixture response timeout')), 5000); })]); }
      finally { clearTimeout(timer); }
      const body = new Uint8Array(await response.arrayBuffer());
      for (let i = 0; i < 100 && !extra.has(item.networkId); i++) await new Promise(done => setTimeout(done, 25));
      const metadata = extra.get(item.networkId);
      if (!metadata || metadata.status !== item.status) throw Error('Missing request-bound headers');
      const headers = Object.entries(metadata.headers).flatMap(([name, value]) =>
        String(value).split('\n').map(part => ({ name: name.toLowerCase(), value: part })));
      report.requests.push({ path, status: item.status, cookie, validator, ...(language ? { language } : {}) });
      return { status: item.status, headers, body };
    } finally { pending.delete(token); extra.delete(item.networkId); }
  }
  const fs = {
    async stat(path) { return path.startsWith('outpost-fixture-matrix-') ? { size: 262144, isDir: false } : null; },
    async readdir() { return []; },
    async readFile(file) {
      const encoded = file.slice('outpost-fixture-matrix-'.length).replace(/~/g, '+').replace(/_/g, '/');
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')), c => c.charCodeAt(0)));
      const parts = decoded.split('\n');
      if (parts.length !== (extended ? 5 : 4) || !/^[1-9]\d{0,9}$/.test(parts.at(-1))) throw Error('Malformed synthetic fixture input');
      const response = await get(...parts.slice(0, extended ? 4 : 3));
      const pick = name => response.headers.find(header => header.name === name)?.value || '';
      const cookies = response.headers.filter(header => header.name === 'set-cookie').map(header => header.value);
      const values = [pick('location'), ...cookies, pick('cache-control'), pick('etag'), pick('vary'), pick('content-type')];
      if (cookies.length > 2 || values.some(value => /[\r\n]/.test(value))) throw Error('Invalid fixture headers');
      const fields = [String(response.status), pick('location'), cookies[0] || '', cookies[1] || '',
        pick('content-type') || 'text/html; charset=utf-8', '', '', pick('cache-control'), pick('etag')];
      const prefix = new TextEncoder().encode(extended
        ? [...fields, pick('vary'), String(response.body.length), ''].join('\n')
        : [...fields, ''].join('\n'));
      if (prefix.length + response.body.length >= 262144) throw Error('Fixture response too large');
      const padded = new Uint8Array(262144); padded.set(prefix); padded.set(response.body, prefix.length); return padded;
    }
  };
  return { fs, report, errors, async close() {
    for (const timer of expectedInterruptions.values()) clearTimeout(timer);
    expectedInterruptions.clear(); chrome.debugger.onEvent.removeListener(listener); await chrome.debugger.detach(target);
  } };
}
