import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 650 } });
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
      const body = `<body style="margin:0;background:#123456">
        <button style="position:absolute;left:20px;top:20px;width:150px;height:40px" onclick="if(event.isTrusted)document.body.style.background='#aa2233'">Click</button>
        <input style="position:absolute;left:20px;top:80px;width:150px" oninput="if(event.isTrusted&&this.value==='ok')document.body.style.background='#33bb44'">
      </body>`;
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
  await page.locator('#address').fill('http://interaction.test/');
  await page.locator('#address').press('Enter');
  await page.locator('#status').filter({ hasText: 'Loaded interaction.test' }).waitFor({ state: 'attached', timeout: 20000 });
  const waitColor = rgb => page.waitForFunction(expected => {
    const pixel = document.querySelector('#surface').getContext('2d').getImageData(300, 150, 1, 1).data;
    return expected.every((value, index) => value === pixel[index]);
  }, rgb, { timeout: 15000 });
  await waitColor([18, 52, 86]);
  const surface = page.locator('#surface');
  await surface.click({ position: { x: 70, y: 35 } });
  await waitColor([170, 34, 51]);
  await surface.click({ position: { x: 70, y: 90 } });
  await page.keyboard.type('ok');
  await waitColor([51, 187, 68]);
  console.log('PASS in-page mouse click and keyboard input reach the site');
} finally {
  await browser.close();
}
