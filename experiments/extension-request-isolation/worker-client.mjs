// Synthetic test page. Its CSP forbids direct WebSocket connections.
const port = chrome.runtime.connect({ name: 'worker-socket-fixture' });
let connected = true, sequence = 0, resolveReady, rejectReady;
const pending = new Map();
globalThis.workerDisconnected = false;
globalThis.workerReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
port.onMessage.addListener(message => {
  if (message.type === 'ready') return resolveReady();
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  message.ok ? request.resolve(message.echo || 'staged') : request.reject(Error('Worker socket fixture failed: ' + (message.error || 'unknown')));
});
port.onDisconnect.addListener(() => {
  connected = false; globalThis.workerDisconnected = true;
  const error = Error('Worker disconnected'); rejectReady(error);
  for (const request of pending.values()) request.reject(error);
  pending.clear();
});
globalThis.workerCall = async (op, cookie) => {
  await workerReady;
  if (!connected) throw Error('Worker disconnected');
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); try { port.disconnect(); } catch {} reject(Error('Worker timed out')); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    try { port.postMessage({ id, op, cookie }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
};
