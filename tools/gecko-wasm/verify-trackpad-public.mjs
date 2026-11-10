import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 850 } });
  await context.routeWebSocket('**/network/', socket => {
    const send = (type, id, payload) => {
      const header = Buffer.alloc(5); header[0] = type; header.writeUInt32LE(id, 1);
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
      const body = `<body style="height:6000px;margin:0;background:#123456"><div id="marker" style="position:fixed;left:200px;top:150px;width:60px;height:60px;background:#aa2233"></div><script>
        addEventListener('scroll',()=>{if(scrollY>=8)document.querySelector('#marker').style.background='#33bb44';});
      </script></body>`;
      send(2, id, Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
      send(4, id, Buffer.from([1]));
    });
  });
  const page = await context.newPage();
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:3001/');
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 30000 });
  await page.getByText('Network settings', { exact: true }).click();
  await page.getByLabel('Custom Wisp endpoint').fill('');
  await page.locator('#start').click();
  await page.locator('#address').fill('http://trackpad-public-fixture.test/', { timeout: 60000 });
  await page.locator('#address').press('Enter');
  await page.locator('#status').filter({ hasText: 'Loaded trackpad-public-fixture.test' }).waitFor({ state: 'attached', timeout: 20000 });
  const color = expected => page.waitForFunction(expected => {
    const p = document.querySelector('#surface').getContext('2d').getImageData(220, 170, 1, 1).data;
    return expected.every((v, i) => p[i] === v);
  }, expected, { timeout: 15000 });
  await color([170, 34, 51]);
  await page.evaluate(async () => {
    const canvas = document.querySelector('#surface'), rect = canvas.getBoundingClientRect();
    for (let i=0;i<30;i++) {
      canvas.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true,
        clientX:rect.left+500, clientY:rect.top+100, deltaY:0.4 }));
      await new Promise(resolve => setTimeout(resolve, 4));
    }
  });
  await color([51, 187, 68]);
  console.log('PASS: small trackpad movements visibly scroll the page');
} finally {
  await browser.close();
}
