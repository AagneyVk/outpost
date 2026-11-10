import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 650 }, deviceScaleFactor: 1 });
  await context.routeWebSocket('**/network/', socket => {
    const send = (type, id, payload) => {
      const header = Buffer.alloc(5);
      header[0] = type;
      header.writeUInt32LE(id, 1);
      socket.send(Buffer.concat([header, payload]));
    };
    send(3, 0, Buffer.from([128, 0, 0, 0]));
    const replied = new Set();
    socket.onMessage(data => {
      const packet = Buffer.from(data);
      if (packet[0] !== 2) return;
      const id = packet.readUInt32LE(1);
      if (replied.has(id)) return;
      replied.add(id);
      const body = '<body style="margin:0;background:#123456"><div style="width:100px;height:100px;background:#aa2233"></div></body>';
      send(2, id, Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
      send(4, id, Buffer.from([1]));
    });
  });
  const page = await context.newPage();
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:3002/');
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 30000 });
  await page.getByText('Network settings', { exact: true }).click();
  await page.getByLabel('Custom Wisp endpoint').fill('');
  await page.locator('#start').click();
  await page.locator('#address').fill('http://zoom-fixture.test/');
  await page.locator('#address').press('Enter');
  await page.locator('#status').filter({ hasText: 'Loaded zoom-fixture.test' }).waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#surface').getContext('2d').getImageData(120, 40, 1, 1).data[0] === 18);
  const surface = page.locator('#surface');
  const size = await surface.evaluate(canvas => [canvas.width, canvas.height]);
  for (let i = 0; i < 5; i++) await page.locator('#zoom-in').click();
  await page.waitForFunction(width => document.querySelector('#surface').width < width, size[0], {timeout: 20000});
  assert.equal(await page.locator('#zoom-reset').textContent(), '150%');
  let pixel;
  for (let i = 0; i < 60; i++) {
    const image = PNG.sync.read(await surface.screenshot());
    pixel = image.data[(40 * image.width + 120) * 4];
    if (pixel === 170) break;
    await page.waitForTimeout(50);
  }
  assert.equal(pixel, 170, 'zoomed fixture must paint at the expected display position');
  console.log('PASS 150% zoom remains usable with the existing rendering path');
} finally {
  await browser.close();
}
