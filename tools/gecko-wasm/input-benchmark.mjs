import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const gpu = process.argv.includes('--gpu');
const trace = process.argv.includes('--trace') || process.argv.includes('--wheel');
const wheel = process.argv.includes('--wheel');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 650 } });
  const page = await context.newPage();
  if (gpu || trace) {
    await page.route('**/gecko-lab/start.mjs', async route => {
      const response = await route.fetch();
      let source = await response.text();
      if (gpu) source = source.replace("GECKO_NOWASMJIT: '1'", "GECKO_NOWASMJIT: '1', GECKO_GPU: '1'");
      if (trace) source = source.replace('await gecko.init();', `await gecko.init();
        window.testGecko = gecko;
        window.traceCommands = [];
        const originalRun = gecko.run.bind(gecko);
        gecko.run = item => { item.traceQueuedAt = performance.now(); return originalRun(item); };
        const originalRunCmd = gecko.runCmd.bind(gecko);
        gecko.runCmd = async item => {
          const started = performance.now();
          const result = await originalRunCmd(item);
          if (item.op !== 4) window.traceCommands.push({op:item.op, queue:started-item.traceQueuedAt, duration:performance.now()-started, deltaY:item.deltaY});
          return result;
        };`);
      await route.fulfill({ response, body: source });
    });
  }
  await context.routeWebSocket('**/network/', ws => {
    const send = (type, id, data) => {
      const header = Buffer.alloc(5);
      header[0] = type;
      header.writeUInt32LE(id, 1);
      ws.send(Buffer.concat([header, data]));
    };
    send(3, 0, Buffer.from([128, 0, 0, 0]));
    const completed = new Set();
    ws.onMessage(data => {
      const packet = Buffer.from(data);
      if (packet[0] !== 2) return;
      const id = packet.readUInt32LE(1);
      if (completed.has(id)) return;
      completed.add(id);
      const html = `<body style="margin:0;background:#123456;min-height:10000px" onwheel="window.wheelCount=(window.wheelCount||0)+1"><input style="position:absolute;left:40px;top:30px;width:220px" oninput="if(event.isTrusted && (!${wheel} || window.wheelCount===80)) document.body.style.background=this.value.length%2?'#aa2233':'#123456'"></body>`;
      send(2, id, Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(html)}\r\n\r\n${html}`));
      send(4, id, Buffer.from([1]));
    });
  });
  await page.goto(process.env.OUTPOST_BENCH_URL ?? 'http://127.0.0.1:3001/');
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 30000 });
  await page.getByText('Network settings', { exact: true }).click();
  await page.getByLabel('Custom Wisp endpoint').fill('');
  await page.locator('#start').click();
  const address = page.locator('#address');
  await address.fill('http://fixture.test/');
  await address.press('Enter');
  await page.locator('#status').filter({ hasText: 'Loaded fixture.test' }).waitFor({ state: 'attached', timeout: 15000 });
  const viewport = page.locator('#viewport');
  async function waitForColor(expected) {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const image = PNG.sync.read(await viewport.screenshot());
      if (image.data[(100 * image.width + 300) * 4] === expected) return;
    }
    throw Error('Timed out waiting for the expected rendered color');
  }
  await waitForColor(18);
  await page.locator(gpu ? '#screen' : '#surface').click({ position: { x: 80, y: 40 } });
  if (wheel) {
    const result = await page.evaluate(async () => {
      const gecko = window.testGecko;
      await new Promise(resolve => setTimeout(resolve, 500));
      window.traceCommands = [];
      const start = performance.now();
      const target = document.querySelector('#surface');
      const rect = target.getBoundingClientRect();
      for (let index = 0; index < 80; index++) target.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, clientX: rect.left + 400, clientY: rect.top + 300, deltaY: 10
      }));
      target.dispatchEvent(new KeyboardEvent('keydown', {key: 'a', bubbles: true}));
      while (gecko.running || gecko.queue.length) await new Promise(resolve => setTimeout(resolve, 10));
      return { elapsed: Math.round(performance.now() - start), events: window.traceCommands };
    });
    await waitForColor(170); // The guest confirms receipt of all 80 wheel events and the key.
    console.log(JSON.stringify({mode: 'wheel-burst', elapsed: result.elapsed,
      wheelCommands: result.events.filter(event => event.op === 3).length,
      deltaY: result.events.filter(event => event.op === 3).reduce((sum, event) => sum + event.deltaY, 0),
      keyQueue: Math.round(result.events.find(event => event.op === 2)?.queue ?? -1)}));
  } else {
    const samples = [];
    for (let index = 0; index < 6; index++) {
      const start = performance.now();
      await page.keyboard.press('a');
      await waitForColor(index % 2 ? 18 : 170);
      samples.push(Math.round(performance.now() - start));
    }
    console.log(JSON.stringify({ mode: gpu ? 'gpu' : 'software', samples }));
    if (trace) console.log(JSON.stringify(await page.evaluate(() => window.traceCommands)));
  }
} finally {
  await browser.close();
}
