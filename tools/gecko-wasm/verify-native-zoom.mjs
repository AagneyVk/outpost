import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const dpr = Number(process.env.OUTPOST_TEST_DPR || 1);
  const context = await browser.newContext({ viewport: { width: 900, height: 650 }, deviceScaleFactor: dpr });
  await context.route('**/gecko-lab/start.mjs', async route => {
    const response = await route.fetch();
    let source = (await response.text()).replace('await gecko.init();', 'await gecko.init(); window.testGecko = gecko;');
    if (process.argv.includes('--experimental')) source = source.replace('    nativeZoom = false;', '    nativeZoom = true;');
    await route.fulfill({ response, body: source });
  });
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
      const body = '<body style="margin:0;background:#123456"><div onclick="window.clicked=true" style="width:100px;height:100px;background:#aa2233"></div><p style="color:white;font:20px sans-serif">Readable text at browser zoom: OUTPOST 123</p></body>';
      send(2, id, Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
      send(4, id, Buffer.from([1]));
    });
  });
  const page = await context.newPage();
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:3002/');
  await page.getByText('Network settings', { exact: true }).click();
  await page.getByLabel('Custom Wisp endpoint').fill('');
  await page.locator('#start').click();
  await page.locator('#address').fill('http://zoom-fixture.test/');
  await page.locator('#address').press('Enter');
  await page.locator('#status').filter({ hasText: 'Loaded zoom-fixture.test' }).waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForFunction(dpr => document.querySelector('#surface').getContext('2d').getImageData(Math.round(120*dpr), Math.round(40*dpr), 1, 1).data[0] === 18, dpr);
  const size = await page.locator('#surface').evaluate(canvas => [canvas.width, canvas.height]);
  console.log('Zoom capability:', await page.evaluate(() => window.testGecko.evalChrome('outpost:zoom-capability')));
  for (let i = 0; i < 5; i++) await page.locator('#zoom-in').click();
  try {
    await page.waitForFunction(dpr => document.querySelector('#surface').getContext('2d').getImageData(Math.round(120*dpr), Math.round(40*dpr), 1, 1).data[0] === 170, dpr, { timeout: 20000 });
  } catch (error) {
    console.error('Zoom diagnostics:', await page.evaluate(() => ({
      status: document.querySelector('#status').textContent,
      zoom: document.querySelector('#zoom-reset').textContent,
      width: document.querySelector('#surface').width,
      samples: [90, 110, 120, 140, 160].map(x => [...document.querySelector('#surface').getContext('2d').getImageData(x, 40, 1, 1).data]),
    })));
    console.error('Guest geometry:', await page.evaluate(() => window.testGecko.evalChrome('JSON.stringify({width:innerWidth,dpr:devicePixelRatio,rect:document.querySelector("div").getBoundingClientRect().toJSON()})')));
    throw error;
  }
  assert.equal(await page.locator('#zoom-reset').textContent(), '150%');
  assert.deepEqual(await page.locator('#surface').evaluate(canvas => [canvas.width, canvas.height]), size);
  if (process.argv.includes('--screenshot')) await page.locator('#surface').screenshot({ path:'../../work/gecko-zoom-text.png' });
  const bounds = await page.locator('#surface').boundingBox();
  await page.mouse.click(bounds.x + 120, bounds.y + 40);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.testGecko.evalChrome('String(!!window.clicked)')), 'true', 'click at the zoomed position must reach the target');
  for (let i = 0; i < 5; i++) await page.locator('#zoom-in').click();
  await page.waitForFunction(dpr => document.querySelector('#surface').getContext('2d').getImageData(Math.round(180*dpr), Math.round(40*dpr), 1, 1).data[0] === 170, dpr, { timeout: 20000 });
  assert.equal(await page.locator('#zoom-reset').textContent(), '200%');
  await page.locator('#zoom-reset').click();
  for (let i = 0; i < 5; i++) await page.locator('#zoom-out').click();
  await page.waitForFunction(dpr => document.querySelector('#surface').getContext('2d').getImageData(Math.round(60*dpr), Math.round(20*dpr), 1, 1).data[0] === 18, dpr, { timeout: 20000 });
  assert.equal(await page.locator('#zoom-reset').textContent(), '50%');
  const finalSurface = await page.locator('#surface').evaluate(canvas => ({width:canvas.width,height:canvas.height,
    viewportWidth:document.querySelector('#viewport').clientWidth,viewportHeight:document.querySelector('#viewport').clientHeight}));
  assert.equal(finalSurface.width, Math.round(finalSurface.viewportWidth * dpr));
  assert.equal(finalSurface.height, Math.round(finalSurface.viewportHeight * dpr));
  console.log(`PASS native 150% zoom paints sharply and clicks accurately at device scale ${dpr}`);
} finally {
  await browser.close();
}
