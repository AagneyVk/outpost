// Account-free synthetic health probe. It verifies both WSS and destination
// TLS; it does not observe user traffic or establish a service guarantee.
import { WebSocket } from 'ws';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function probeWisp({ relayUrl, targetHost = 'example.com', targetPort = 443, targetPath = '/', ca, timeoutMs = 15000, expectedBody = 'Example Domain', testSocketFactory }) {
  const endpoint = new URL(relayUrl);
  if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.hash) throw Error('Relay must be a WSS URL without credentials or fragment.');
  if (!/^[a-z0-9.-]+$/i.test(targetHost) || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535 ||
      !targetPath.startsWith('/') || /[\r\n]/.test(targetPath) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000)
    throw Error('Invalid probe parameters.');
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let finished = false, transport, secure, body = Buffer.alloc(0), connected = false;
    // The injectable socket is used only by deterministic in-process tests;
    // the command-line probe always uses ws with certificate validation.
    const ws = testSocketFactory ? testSocketFactory() : new WebSocket(endpoint.href, { ca, handshakeTimeout: timeoutMs, perMessageDeflate: false, maxPayload: 1024 * 1024 });
    const timer = setTimeout(() => finish(Error('Probe timed out.')), timeoutMs);
    function finish(error) {
      if (finished) return;
      finished = true; clearTimeout(timer);
      secure?.destroy(); transport?.destroy(); ws.terminate();
      if (error) reject(error);
      else resolve({ ok: true, elapsedMs: Math.round(performance.now() - started), relayOrigin: endpoint.origin, targetHost });
    }
    ws.on('error', error => finish(Error('Relay connection failed.', { cause: error })));
    ws.on('close', () => { if (!finished) finish(Error('Relay closed during probe.')); });
    ws.on('message', (data, binary) => {
      if (finished) return;
      const packet = Buffer.from(data);
      if (!binary || packet.length < 5) return finish(Error('Invalid relay frame.'));
      const type = packet[0], id = packet.readUInt32LE(1);
      if (type === 3 && id === 0 && !connected) {
        if (packet.length < 9) return finish(Error('Invalid relay credit.'));
        connected = true;
        const host = Buffer.from(targetHost), connect = Buffer.alloc(8 + host.length);
        connect[0] = 1; connect.writeUInt32LE(1, 1); connect[5] = 1; connect.writeUInt16LE(targetPort, 6); host.copy(connect, 8);
        ws.send(connect, error => { if (error) finish(error); });
        transport = new Duplex({
          read() {},
          write(data, _encoding, callback) {
            if (ws.readyState !== WebSocket.OPEN) return callback(Error('Relay is closed.'));
            const frame = Buffer.alloc(5 + data.length); frame[0] = 2; frame.writeUInt32LE(1, 1); data.copy(frame, 5);
            ws.send(frame, callback);
          }
        });
        transport.on('error', error => finish(error));
        secure = tls.connect({ socket: transport, servername: targetHost, ca, rejectUnauthorized: true });
        secure.on('error', error => finish(Error('Destination TLS failed.', { cause: error })));
        secure.once('secureConnect', () => secure.write(`GET ${targetPath} HTTP/1.1\r\nHost: ${targetHost}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`));
        secure.on('data', data => {
          if (body.length + data.length > 1024 * 1024) return finish(Error('Probe response is too large.'));
          body = Buffer.concat([body, data]);
        });
        secure.once('end', () => {
          const response = body.toString('utf8');
          const separator = response.indexOf('\r\n\r\n');
          if (separator < 0 || !/^HTTP\/1\.[01] 200(?:\s|\r)/.test(response.slice(0, separator)) || !response.slice(separator + 4).includes(expectedBody)) return finish(Error('Probe returned an unexpected response.'));
          finish();
        });
      } else if (id === 1 && type === 2 && transport) transport.push(packet.subarray(5));
      else if (id === 1 && type === 4 && transport) transport.push(null);
    });
  });
}

async function main() {
  const args = process.argv.slice(2), relayUrl = args[0] && !args[0].startsWith('--') ? args.shift() : 'wss://wisp.mercurywork.shop/';
  const readNumber = (flag, fallback) => {
    const i = args.indexOf(flag); if (i < 0) return fallback;
    const number = Number(args[i + 1]); if (!Number.isInteger(number)) throw Error('Invalid ' + flag);
    args.splice(i, 2); return number;
  };
  const samples = readNumber('--samples', 1), intervalMs = readNumber('--interval-ms', 1000), timeoutMs = readNumber('--timeout-ms', 15000);
  if (args.length || samples < 1 || samples > 100 || intervalMs < 0 || intervalMs > 60000) throw Error('Invalid probe options.');
  const results = [];
  for (let index = 0; index < samples; index++) {
    if (index) await new Promise(resolve => setTimeout(resolve, intervalMs));
    try { results.push(await probeWisp({ relayUrl, timeoutMs })); }
    catch (error) {
      const safeMessages = ['Probe timed out.', 'Relay connection failed.', 'Destination TLS failed.', 'Relay closed during probe.', 'Invalid relay frame.', 'Invalid relay credit.', 'Probe response is too large.', 'Probe returned an unexpected response.'];
      const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code :
        safeMessages.includes(error.message) ? error.message : 'NETWORK_OR_TLS_ERROR';
      results.push({ ok: false, error: code });
    }
  }
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), samples, passed: results.filter(item => item.ok).length,
    results, note: 'Synthetic samples only; not an uptime or reliability guarantee.' }, null, 2));
  if (results.some(item => !item.ok)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
