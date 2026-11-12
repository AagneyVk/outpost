// Diagnostic only: this test attaches the extension debugger to its own tab.
globalThis.runCertificateProbe = async () => {
  const tab = await chrome.tabs.getCurrent();
  const target = { tabId: tab.id };
  const events = [];
  const listener = (source, method, params) => {
    if (source.tabId !== tab.id || method !== 'Network.responseReceived' ||
        params.response.url !== 'https://example.com/') return;
    const security = params.response.securityDetails;
    events.push({ protocol: security?.protocol || null, issuer: security?.issuer || null,
      securityState: params.response.securityState || null });
  };
  chrome.debugger.onEvent.addListener(listener);
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
    await chrome.debugger.sendCommand(target, 'Network.enable');
    const valid = await fetch('https://example.com/', { credentials: 'omit', cache: 'no-store' });
    await valid.arrayBuffer();
    let bad;
    try { await fetch('https://expired.badssl.com/', { credentials: 'omit', cache: 'no-store' }); bad = 'unexpected success'; }
    catch (error) { bad = error.name; }
    const cert = await chrome.debugger.sendCommand(target, 'Network.getCertificate', { origin: 'https://example.com' });
    return { valid: valid.status, expired: bad, events, certificateCount: cert?.tableNames?.length ?? null,
      firstCertificateBase64Bytes: cert?.tableNames?.[0]?.length ?? 0 };
  } catch (error) { return { error: String(error.message || error), events }; }
  finally {
    chrome.debugger.onEvent.removeListener(listener);
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
};
