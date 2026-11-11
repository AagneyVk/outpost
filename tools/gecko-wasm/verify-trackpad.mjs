import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 850 } });
  await context.route('**/gecko-lab/start.mjs', async route => {
    const response = await route.fetch();
    const source = (await response.text()).replace('await gecko.init();', 'await gecko.init(); window.testGecko = gecko;');
    await route.fulfill({ response, body: source });
  });
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
      const body = `<body style="margin:0;height:6000px;background:linear-gradient(white,black)">
        <div id="nested" style="position:fixed;left:20px;top:20px;width:250px;height:220px;overflow:auto;background:white"><div style="width:1200px;height:2000px;background:linear-gradient(white,blue)"></div></div>
        <script>window.wheelEvents=[];document.addEventListener('wheel',e=>{wheelEvents.push([e.deltaY,e.defaultPrevented,e.isTrusted,e.target.id,scrollY,document.querySelector('#nested').scrollTop]);if(e.clientX>800)e.preventDefault();},{passive:false});</script>
      </body>`;
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
  await page.locator('#address').fill('http://trackpad-fixture.test/');
  await page.locator('#address').press('Enter');
  await page.locator('#status').filter({ hasText: 'Loaded trackpad-fixture.test' }).waitFor({ state: 'attached', timeout: 20000 });
  const zoom = Number(process.env.OUTPOST_TEST_ZOOM || 100);
  for (let i = 100; i < zoom; i += 10) await page.locator('#zoom-in').click();
  if (zoom !== 100) await page.waitForTimeout(500);
  const exec = script => page.evaluate(script => window.testGecko.evalChrome(script), script);
  async function gesture(x, delta, count, delay, mode = 0, deltaX = 0) {
    x *= zoom / 100;
    const rect = await page.locator('#surface').boundingBox();
    await page.mouse.move(rect.x + x, rect.y + 100);
    await page.evaluate(async ({ x, delta, count, delay, mode, deltaX }) => {
      const canvas = document.querySelector('#surface'), rect = canvas.getBoundingClientRect();
      for (let i=0;i<count;i++) {
        canvas.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, clientX:rect.left+x,
          clientY:rect.top+100, deltaX, deltaY:delta, deltaMode:mode }));
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }, { x, delta, count, delay, mode, deltaX });
    await page.waitForTimeout(800);
    return JSON.parse(await exec(`JSON.stringify({root:scrollY,rootX:scrollX,nested:document.querySelector('#nested').scrollTop,nestedX:document.querySelector('#nested').scrollLeft,events:wheelEvents})`));
  }
  const fractional = await gesture(500, 0.4, 30, 4);
  console.log('Fractional root:', JSON.stringify({ root: fractional.root, events: fractional.events.length,
    deltaSum: fractional.events.reduce((sum, event) => sum + event[0], 0) }));
  const whole = await gesture(500, 3, 25, 4);
  console.log('Whole-pixel root:', JSON.stringify({ root: whole.root, events: whole.events.length - fractional.events.length }));
  const reverse = await gesture(500, -0.4, 20, 4);
  console.log('Reverse fractional:', JSON.stringify({ root: reverse.root }));
  const beforeNested = reverse.nested;
  const nested = await gesture(100, 3, 25, 4);
  console.log('Nested trackpad:', JSON.stringify({ root: nested.root, nested: nested.nested,
    events: nested.events.length - reverse.events.length, first: nested.events[reverse.events.length], last: nested.events.at(-1) }));
  const prevented = await gesture(900, 3, 10, 4);
  console.log('Canceled gesture:', JSON.stringify({ root: prevented.root, nested: prevented.nested }));
  assert(fractional.root >= 5, 'Small trackpad deltas must accumulate into visible root scrolling');
  assert(whole.root >= fractional.root + 20, 'Repeated trackpad movement must move the root page');
  assert(reverse.root < whole.root - 4, 'Small deltas in the reverse direction must scroll back');
  assert(nested.nested > beforeNested + 20, 'Trackpad movement over a nested scroller must scroll that container');
  assert(Math.abs(nested.root - reverse.root) < 2, 'Scrolling a nested panel must not also scroll its parent');
  assert.equal(prevented.root, nested.root, 'A site that cancels wheel input must not be scrolled');
  assert.equal(prevented.nested, nested.nested, 'Canceled wheel input must not move a nested panel');
  const horizontal = await gesture(100, 0, 30, 4, 0, 0.5);
  assert(horizontal.nestedX >= 10, 'Small horizontal touchpad deltas must scroll the nested panel');
  assert.equal(horizontal.nested, nested.nested, 'Horizontal input must not move the panel vertically');
  assert.equal(horizontal.root, nested.root, 'Horizontal input in a panel must not move the root page');
  const lines = await gesture(500, 1, 2, 4, 1);
  assert(lines.root >= prevented.root + 20, 'Line-mode wheel input must be converted to pixels');
  const rect = await page.locator('#surface').boundingBox();
  await page.mouse.move(rect.x + 500 * zoom / 100, rect.y + 100);
  await page.mouse.wheel(0, 20);
  await page.waitForTimeout(800);
  const trustedRoot = Number(await exec('scrollY'));
  assert(trustedRoot > lines.root, 'A real browser wheel event must scroll the page');
  assert(nested.events.every(event => event[2]), 'The page must receive trusted wheel events');
  console.log('PASS fractional and nested trackpad scrolling');
} finally {
  await browser.close();
}
