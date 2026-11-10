import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 850 } });
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
      const body = `<body style="margin:0;background:#123456"><div id="box" style="position:absolute;left:20px;top:20px;width:60px;height:60px;background:#aa2233"></div><script>
        let active=false;
        box.addEventListener('mousedown', e => {if(e.isTrusted)active=true;});
        document.addEventListener('mouseup', () => {if(active)document.body.style.background='#33bb44';active=false;});
      </script></body>`;
      send(2, id, Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
      send(4, id, Buffer.from([1]));
    });
  });
  const page = await context.newPage();
  page.on('pageerror', error => console.error('Page error:', error.message));
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:3001/');
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 30000 });
  await page.getByText('Network settings', { exact: true }).click();
  await page.getByLabel('Custom Wisp endpoint').fill('');
  await page.locator('#start').click();
  try { await page.locator('#address').fill('http://capture-fixture.test/', { timeout: 60000 }); }
  catch (error) { console.error('Start status:', await page.locator('#start-error').textContent()); throw error; }
  await page.locator('#address').press('Enter');
  await page.locator('#status').filter({ hasText: 'Loaded capture-fixture.test' }).waitFor({ state: 'attached', timeout: 20000 });
  const surface = page.locator('#surface');
  await page.waitForFunction(() => document.querySelector('#surface').getContext('2d').getImageData(200, 150, 1, 1).data[0] === 18);
  const box = await surface.boundingBox();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y - 10, { steps: 20 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const p = document.querySelector('#surface').getContext('2d').getImageData(200, 150, 1, 1).data;
    return p[0] === 51 && p[1] === 187 && p[2] === 68;
  }, null, { timeout: 15000 });
  console.log('PASS: release outside the canvas reaches the website');
} finally {
  await browser.close();
}
