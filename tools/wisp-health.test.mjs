import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { Duplex, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeWisp } from './wisp-health.mjs';

test('probe verifies destination TLS and fails closed on relay and protocol failures', { timeout: 30000 }, async () => {
  const tempRoot = path.resolve(os.tmpdir()), temp = await fs.mkdtemp(path.join(tempRoot, 'outpost-probe-test-'));
  try {
    const openssl = process.env.OUTPOST_OPENSSL || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
    const caKey = path.join(temp, 'ca-key.pem'), caPath = path.join(temp, 'ca.pem');
    const keyPath = path.join(temp, 'key.pem'), certPath = path.join(temp, 'cert.pem'), csr = path.join(temp, 'request.pem'), ext = path.join(temp, 'leaf.ext');
    await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=OUTPOST Synthetic Test CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', caPath]);
    await promisify(execFile)(openssl, ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', keyPath, '-out', csr]);
    await fs.writeFile(ext, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
    await promisify(execFile)(openssl, ['x509', '-req', '-in', csr, '-CA', caPath, '-CAkey', caKey, '-CAcreateserial', '-days', '1', '-extfile', ext, '-out', certPath]);
    const key = await fs.readFile(keyPath), cert = await fs.readFile(certPath), ca = await fs.readFile(caPath);
    function factory(mode = 'success') {
      return () => {
        class FakeSocket extends EventEmitter {
          readyState = 1;
          constructor() {
            super();
            setImmediate(() => {
              if (mode === 'relay-error') this.emit('error', Error('synthetic relay certificate failure'));
              else if (mode !== 'stall') this.emit('message', Buffer.from([3, 0, 0, 0, 0, 128, 0, 0, 0]), true);
            });
          }
          send(packet, callback = () => {}) {
            if (packet[0] === 1) {
              this.input = new PassThrough(); this.output = new PassThrough();
              const pipe = Duplex.from({ readable: this.input, writable: this.output });
              this.target = new tls.TLSSocket(pipe, { isServer: true, secureContext: tls.createSecureContext({ key, cert }) });
              this.target.on('error', () => {});
              this.output.on('data', bytes => {
                const head = Buffer.from([2, 1, 0, 0, 0]); this.emit('message', Buffer.concat([head, bytes]), true);
              });
              this.output.on('end', () => this.emit('message', Buffer.from([4, 1, 0, 0, 0, 1]), true));
              this.target.once('data', () => this.target.end('HTTP/1.1 200 OK\r\nContent-Length: 14\r\nConnection: close\r\n\r\nExample Domain'));
            } else if (packet[0] === 2) this.input.write(packet.subarray(5));
            callback();
          }
          terminate() { this.readyState = 3; this.target?.destroy(); this.input?.destroy(); this.output?.destroy(); }
        }
        return new FakeSocket();
      };
    }
    const common = { relayUrl: 'wss://synthetic.invalid/', targetHost: 'localhost', ca };
    assert.equal((await probeWisp({ ...common, testSocketFactory: factory() })).ok, true);
    await assert.rejects(probeWisp({ ...common, ca: undefined, testSocketFactory: factory() }), /Destination TLS failed/);
    await assert.rejects(probeWisp({ ...common, targetHost: 'wrong.test', testSocketFactory: factory() }), /Destination TLS failed/);
    await assert.rejects(probeWisp({ ...common, testSocketFactory: factory('relay-error') }), /Relay connection failed/);
    await assert.rejects(probeWisp({ ...common, testSocketFactory: factory('stall'), timeoutMs: 200 }), /timed out/i);
    await assert.rejects(probeWisp({ ...common, testSocketFactory: factory(), expectedBody: 'missing marker' }), /unexpected response/i);
    await assert.rejects(probeWisp({ ...common, relayUrl: 'ws://synthetic.invalid/', testSocketFactory: factory() }), /must be a WSS URL/);
  } finally {
    if (path.dirname(temp) !== tempRoot || !path.basename(temp).startsWith('outpost-probe-test-')) throw Error('Invalid temporary path');
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});
