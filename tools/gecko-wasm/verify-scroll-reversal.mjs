import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const busy = process.argv.includes('--busy');
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 850 } });
  await context.route('**/gecko-lab/start.mjs', async route => {
    const response = await route.fetch();
    const source = (await response.text()).replace('await gecko.init();', `await gecko.init();
      window.testGecko = gecko; window.wheelTrace = [];
      const originalRun = gecko.run.bind(gecko), originalRunCmd = gecko.runCmd.bind(gecko);
      gecko.run = item => { item.enqueuedAt = performance.now(); return originalRun(item); };
      gecko.runCmd = async item => {
        if (item.op === 3) window.wheelTrace.push({delta:item.deltaY, wait:performance.now()-item.enqueuedAt});
        return originalRunCmd(item);
      };`);
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
      const body = `<body style="margin:0;height:8000px;background:linear-gradient(white,black)">
        <div id="nested" style="position:fixed;left:20px;top:20px;width:250px;height:220px;overflow:auto;background:white"><div style="height:5000px;background:linear-gradient(white,blue)"></div></div>
        <script>window.records=[];document.addEventListener('wheel',e=>{records.push({d:e.deltaY,y:scrollY,n:document.querySelector('#nested').scrollTop,t:performance.now()});if(${busy}){let end=performance.now()+10;while(performance.now()<end){}}},{passive:true});</script>
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
  await page.locator('#address').fill('http://reversal-fixture.test/');
  await page.locator('#address').press('Enter');
  await page.locator('#status').filter({ hasText: 'Loaded reversal-fixture.test' }).waitFor({ state: 'attached', timeout: 20000 });
  const zoom = Number(process.env.OUTPOST_TEST_ZOOM || 100);
  for (let level = 100; level < zoom; level += 10) await page.locator('#zoom-in').click();
  if (zoom !== 100) await page.waitForTimeout(500);
  const exec = script => page.evaluate(script => window.testGecko.evalChrome(script), script);
  async function runGesture(x, nested) {
    x *= zoom / 100;
    await exec(`scrollTo(0,3000); document.querySelector('#nested').scrollTop=2000; records=[]; 'ready'`);
    await page.waitForTimeout(500);
    const rect = await page.locator('#surface').boundingBox();
    await page.mouse.move(rect.x + x, rect.y + 100);
    await page.evaluate(() => { window.wheelTrace = []; });
    await page.evaluate(async ({ x, busy }) => {
      const canvas=document.querySelector('#surface'), rect=canvas.getBoundingClientRect();
      const count = busy ? 50 : 30;
      for (const delta of [...Array(count).fill(-8), ...Array(count).fill(8)]) {
        canvas.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true,
          clientX:rect.left+x, clientY:rect.top+100, deltaY:delta }));
        await new Promise(resolve=>setTimeout(resolve,4));
      }
    }, { x, busy });
    await page.waitForTimeout(busy ? 2500 : 1000);
    const result = JSON.parse(await exec(`JSON.stringify({root:scrollY,nested:document.querySelector('#nested').scrollTop,records})`));
    const key = nested ? 'n' : 'y';
    const firstPositive = result.records.findIndex(entry => entry.d > 0);
    assert(firstPositive >= 0, 'The page must receive the reversed movement');
    const duringReverse = result.records.slice(firstPositive);
    const start = duringReverse[0][key];
    const responding = duringReverse.findIndex(entry => entry[key] >= start + 8);
    const late = duringReverse.slice(0, 10).map(entry => entry[key]);
    const trace = await page.evaluate(() => window.wheelTrace);
    const reverseWait = trace.find(entry => entry.delta > 0)?.wait;
    console.log(JSON.stringify({target:nested?'nested':'root',firstPositivePosition:start,
      firstResponseEvent:responding, earlyPositions:late, final:nested?result.nested:result.root,
      events:result.records.length, reverseQueueMs:Math.round(reverseWait ?? -1)}));
    assert(responding >= 0 && responding <= 10, 'Scrolling must respond promptly to direction reversal');
    assert(Math.abs(result.records.reduce((sum, entry) => sum + entry.d, 0)) < 0.01, 'Coalescing must preserve the total wheel distance');
    assert(Math.abs((nested ? result.nested : result.root) - (nested ? 2000 : 3000)) <= 8, 'Opposite movements must finish near their starting position');
    if (busy) assert(reverseWait < 250, 'Reversed input must not wait behind a long wheel backlog');
  }
  await runGesture(500, false);
  await runGesture(100, true);
  console.log('PASS immediate touchpad reversal');
} finally {
  await browser.close();
}
