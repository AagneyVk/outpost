// Chrome extension relay transport: use the WebSocket constructor belonging to
// a credentialless frame, so its handshake does not use the host cookie jar.
export async function createIsolatedRelaySocket(onDisconnected = () => {}) {
  const frame = document.createElement('iframe');
  if (!('credentialless' in frame)) throw Error('This browser cannot isolate relay cookies. Update Chrome to use OUTPOST.');
  frame.credentialless = true;
  if (frame.credentialless !== true) throw Error('This browser cannot isolate relay cookies.');
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  const expected = new URL('./relay-socket-frame.html', import.meta.url).href;
  frame.src = expected;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('The isolated relay frame did not load.')), 10000);
      frame.onload = () => { clearTimeout(timer); resolve(); };
      frame.onerror = () => { clearTimeout(timer); reject(Error('The isolated relay frame could not load.')); };
      document.body.append(frame);
    });
    if (frame.contentWindow.location.href !== expected || typeof frame.contentWindow.WebSocket !== 'function') {
      throw Error('The isolated relay frame is unavailable.');
    }
    const Socket = frame.contentWindow.WebSocket;
    let latest = 0;
    return function IsolatedRelaySocket(...args) {
      const id = ++latest, socket = new Socket(...args);
      socket.addEventListener('close', () => {
        // The Wisp v2-to-v1 fallback opens a replacement immediately. Do not
        // present that normal fallback as a persistent disconnection.
        setTimeout(() => { if (id === latest) onDisconnected(); }, 1500);
      }, { once: true });
      return socket;
    };
  } catch (error) { frame.remove(); throw error; }
}
