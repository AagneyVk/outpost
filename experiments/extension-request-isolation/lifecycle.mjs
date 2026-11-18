// Synthetic localhost fixture. This does not provide a production security boundary.
const url = new URL(location.href).searchParams.get('url');
if (!/^wss:\/\/localhost:\d+\/socket$/.test(url)) throw Error('Invalid fixture destination');
const port = chrome.runtime.connect({ name: 'lifecycle-fixture' });
const pending = new Map();
let sequence = 0, connected = true;
globalThis.lifecycleDisconnected = false;
let readyResolve, readyReject;
globalThis.fixtureReady = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
port.onMessage.addListener(message => {
  if (message.type === 'ready') return readyResolve();
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  message.ok ? request.resolve() : request.reject(Error('Fixture operation failed'));
});
port.onDisconnect.addListener(() => {
  connected = false; globalThis.lifecycleDisconnected = true;
  const error = Error('Fixture worker disconnected');
  readyReject(error);
  for (const request of pending.values()) request.reject(error);
  pending.clear();
});
async function rpc(op, cookie) {
  await fixtureReady;
  if (!connected) throw Error('Fixture worker disconnected');
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      try { port.disconnect(); } catch {}
      reject(Error('Fixture worker timed out'));
    }, 5000);
    pending.set(id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } });
    try { port.postMessage({ id, op, cookie }); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}
globalThis.fixtureStage = cookie => rpc('install', cookie);
globalThis.fixtureOpenStaged = async () => {
  await rpc('ping');
  let socket;
  try {
    if (!connected) throw Error('Fixture worker disconnected');
    socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Handshake timeout')), 5000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(Error('Handshake failed')); };
    });
    await rpc('remove');
    return socket;
  } catch (error) { socket?.close(); if (connected) await rpc('remove').catch(() => {}); throw error; }
};
let gate = Promise.resolve();
globalThis.fixtureOpen = cookie => {
  const opening = gate.then(async () => { await fixtureStage(cookie); return fixtureOpenStaged(); });
  gate = opening.then(() => {}, () => {});
  return opening.then(socket => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(Error('Echo timeout')); }, 5000);
    socket.onmessage = event => { clearTimeout(timer); socket.close(); resolve(event.data); };
    socket.onerror = () => { clearTimeout(timer); reject(Error('Echo failed')); };
    socket.send('echo');
  }));
};
