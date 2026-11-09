import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  await context.routeWebSocket('**/network/', socket => {
    const streams = new Map();
    const send = (type, id, body) => {
      const header = Buffer.alloc(5);
      header[0] = type;
      header.writeUInt32LE(id, 1);
      socket.send(Buffer.concat([header, body]));
    };
    send(3, 0, Buffer.from([128, 0, 0, 0]));
    socket.onMessage(data => {
      const packet = Buffer.from(data);
      const id = packet.readUInt32LE(1);
      if (packet[0] === 1) { streams.set(id, ''); return; }
      if (packet[0] !== 2 || !streams.has(id)) return;
      const request = streams.get(id) + packet.subarray(5).toString();
      streams.set(id, request);
      if (!request.includes('\r\n\r\n')) return;
      streams.delete(id);
      requests.push(request.split('\r\n')[0]);
      const body = '<body style="background:#123456">Redirect complete</body>';
      const response = request.startsWith('GET /start ')
        ? 'HTTP/1.1 302 Found\r\nLocation: /done\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
        : `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
      send(2, id, Buffer.from(response));
      send(4, id, Buffer.from([1]));
    });
  });
  await page.goto('http://127.0.0.1:3001/');
  await page.getByText('Network settings', { exact: true }).click();
  await page.getByLabel('Custom Wisp endpoint').fill('');
  await page.locator('#start').click();
  await page.locator('#address').fill('http://redirect.test/start');
  await page.locator('#address').press('Enter');
  await page.waitForFunction(() => document.querySelector('#browser-scene').hidden, null, { timeout: 20000 });
  await page.waitForFunction(() => {
    const pixel = document.querySelector('#surface').getContext('2d').getImageData(200, 200, 1, 1).data;
    return pixel[0] === 18 && pixel[1] === 52 && pixel[2] === 86;
  }, null, { timeout: 15000 });
  assert(requests.some(request => request.startsWith('GET /done ')));
  assert.equal(await page.locator('#address').inputValue(), 'http://redirect.test/done');
  console.log('PASS redirected page paints and updates the address');
} finally {
  await browser.close();
}
