// Test only. This uses the site's published synthetic practice credentials.
globalThis.runDemoLogin = async (options = {}) => {
  const origin = 'https://practice.expandtesting.com';
  const initiator = chrome.runtime.getURL('').slice(0, -1);
  const events = new Map();
  const cookies = new Map(options.session || []);
  const listener = details => {
    if (details.initiator !== initiator) return;
    events.set(details.requestId, {
      url: details.url, status: details.statusCode,
      headers: (details.responseHeaders || []).map(h => ({ name: h.name.toLowerCase(), value: h.value || '' }))
    });
  };
  chrome.webRequest.onHeadersReceived.addListener(listener,
    { urls: [origin + '/*'], types: ['xmlhttprequest'] }, ['responseHeaders', 'extraHeaders']);
  const cookieString = () => [...cookies].map(([name, value]) => name + '=' + value).join('; ');
  async function request(path, options = {}, rewriteOrigin = false) {
    const url = origin + path;
    const headers = [];
    if (cookies.size) headers.push({ header: 'Cookie', operation: 'set', value: cookieString() });
    if (rewriteOrigin) {
      headers.push({ header: 'Origin', operation: 'set', value: origin });
      headers.push({ header: 'Referer', operation: 'set', value: origin + '/login' });
    }
    const rules = headers.length ? [{
      id: 1, priority: 1, action: { type: 'modifyHeaders', requestHeaders: headers },
      condition: { urlFilter: '|' + url + '|', initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] }
    }] : [];
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1], addRules: rules });
    try {
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'manual',
        signal: AbortSignal.timeout(15000), ...options });
      const event = [...events.values()].filter(item => item.url === url).at(-1);
      if (!event) throw Error('Missing response headers');
      const setCookies = event.headers.filter(h => h.name === 'set-cookie');
      for (const entry of setCookies) {
        const first = entry.value.split(';', 1)[0];
        const i = first.indexOf('=');
        if (i > 0) cookies.set(first.slice(0, i), first.slice(i + 1));
      }
      return { status: event.status, cookieCount: setCookies.length,
        location: event.headers.find(h => h.name === 'location')?.value || null,
        body: response.type === 'opaqueredirect' ? '' : await response.text() };
    } finally {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] });
    }
  }
  try {
    if (options.restoreOnly) {
      const secure = await request('/secure');
      return { secure: secure.status, success: /logout/i.test(secure.body) };
    }
    const login = await request('/login');
    const auth = await request('/authenticate', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'practice', password: 'SuperSecretPassword!' }).toString()
    }, true);
    const location = auth.location && new URL(auth.location, origin);
    if (!location || location.origin !== origin || location.pathname !== '/secure')
      return { login: login.status, auth: auth.status, authCookieCount: auth.cookieCount,
        redirectPath: location?.pathname || null, success: false };
    const secure = await request('/secure');
    return { login: login.status, auth: auth.status, authCookieCount: auth.cookieCount,
      redirectPath: location.pathname, secure: secure.status,
      success: secure.body.includes('You logged into a secure area'), session: [...cookies] };
  } catch (error) {
    return { error: String(error.message || error) };
  } finally {
    chrome.webRequest.onHeadersReceived.removeListener(listener);
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] });
  }
};
