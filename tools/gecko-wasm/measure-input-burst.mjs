// Synthetic typing test; --baseline serves the preceding v5 host bundle.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const baseline = process.argv.includes('--baseline');
const typed = process.argv.includes('--mixed') ? 'OUTpost42! Quick-test?' : 'abcdefghijklmnopqrstuvwxyz';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 650 } });
  await context.route('**/gecko-lab/start.mjs', async route => {
    const response = await route.fetch(); let source = await response.text();
    if (baseline) source = source.replace('gecko-input-v6.js', 'gecko-input-v5.js');
    const anchor = 'await gecko.init();';
    if (!source.includes(anchor)) throw Error('Engine instrumentation anchor missing');
    source = source.replace(anchor, `${anchor}
      window.testGecko = gecko; window.inputMeasurements = [];
      const originalRun = gecko.run.bind(gecko), originalRunCmd = gecko.runCmd.bind(gecko);
      gecko.run = item => { item.testQueuedAt = performance.now(); return originalRun(item); };
      gecko.runCmd = async item => { const start = performance.now(); const result = await originalRunCmd(item); if (item.op === 2) window.inputMeasurements.push({ queue: start - item.testQueuedAt, duration: performance.now() - start }); return result; };`);
    await route.fulfill({ response, body: source });
  });
  await context.routeWebSocket('**/network/', socket => {
    const send = (type, id, payload) => { const h = Buffer.alloc(5); h[0] = type; h.writeUInt32LE(id, 1); socket.send(Buffer.concat([h, payload])); };
    send(3, 0, Buffer.from([128, 0, 0, 0]));
    const replied = new Set();
    socket.onMessage(data => {
      const packet = Buffer.from(data); if (packet[0] !== 2) return;
      const id = packet.readUInt32LE(1); if (replied.has(id)) return; replied.add(id);
      const body = `<body style="margin:0;background:#123456"><input autofocus style="position:absolute;left:30px;top:30px;width:300px" oninput="if(event.isTrusted && this.value==='${typed}')document.body.style.background='#33bb44'"></body>`;
      send(2, id, Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)); send(4, id, Buffer.from([1]));
    });
  });
  const page = await context.newPage();
  await page.goto(process.env.OUTPOST_BENCH_URL || 'http://127.0.0.1:32118/');
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 30000 });
  await page.getByText('Network settings', { exact: true }).click(); await page.getByLabel('Custom Wisp endpoint').fill('');
  await page.locator('#start').click(); await page.locator('#address').fill('http://typing.test/'); await page.locator('#address').press('Enter');
  await page.locator('#status').filter({ hasText: 'Loaded typing.test' }).waitFor({ state: 'attached', timeout: 30000 });
  await page.locator('#surface').click({ position: { x: 90, y: 40 } });
  await page.waitForTimeout(300); await page.evaluate(() => { window.inputMeasurements = []; });
  const begin = Date.now(); await page.keyboard.type(typed);
  await page.waitForFunction(() => { const p = document.querySelector('#surface').getContext('2d').getImageData(400, 200, 1, 1).data; return p[0] === 51 && p[1] === 187 && p[2] === 68; }, null, { timeout: 30000 });
  const elapsed = Date.now() - begin, measurements = await page.evaluate(() => window.inputMeasurements);
  assert(measurements.length >= typed.length * 2 - 1, 'The trusted key events must reach Gecko');
  const sorted = measurements.map(x => x.queue).sort((a, b) => a - b);
  console.log(JSON.stringify({ baseline, elapsedMs: elapsed, keys: measurements.length, queueMedianMs: Math.round(sorted[Math.floor(sorted.length / 2)]), queueP95Ms: Math.round(sorted[Math.floor(sorted.length * .95)]) }));
} finally { await browser.close(); }
