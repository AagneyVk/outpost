import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 850 } });
  await context.route('**/gecko-lab/start.mjs', async route => {
    const response = await route.fetch();
    const source = (await response.text()).replace('await gecko.init();', `await gecko.init();
      window.testGecko = gecko; window.dragTrace = [];
      const run = gecko.run.bind(gecko), runCmd = gecko.runCmd.bind(gecko);
      gecko.run = item => { item.queuedAt = performance.now(); return run(item); };
      gecko.runCmd = async item => {
        const started = performance.now();
        const result = await runCmd(item);
        if (item.op === 1 && item.buttons) window.dragTrace.push({ queued: started - item.queuedAt, duration: performance.now() - started });
        return result;
      };`);
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
      const body = `<style>#scroller{scrollbar-color:#ff0000 #00ff00;scrollbar-width:auto}</style><body style="margin:0;background:#123456">
        <div id="box" style="position:absolute;left:20px;top:20px;width:60px;height:60px;background:#aa2233"></div>
        <div id="scroller" style="position:absolute;left:350px;top:20px;width:240px;height:240px;overflow:scroll;background:white"><div style="width:100%;height:1600px;background:linear-gradient(white,black)"></div></div>
        <script>
          window.dragState={active:false,moves:[],ups:0};
          window.mouseLog=[];
          for (const type of ['mousedown','mousemove','mouseup']) document.addEventListener(type, e => { if(e.clientX>570)mouseLog.push([type,e.clientX,e.clientY,e.buttons,e.target.id]); });
          document.querySelector('#box').addEventListener('mousedown', e => { if(e.isTrusted) dragState.active=true; });
          document.addEventListener('mousemove', e => { if(dragState.active) {dragState.moves.push([e.clientX,e.clientY,e.buttons]); document.querySelector('#box').style.left=e.clientX+'px';} });
          document.addEventListener('mouseup', e => { if(dragState.active) {dragState.active=false;dragState.ups++;} });
        </script>
      </body>`;
      send(2, id, Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
      send(4, id, Buffer.from([1]));
    });
  });
  const page = await context.newPage();
  if (process.argv.includes('--frames')) page.on('console', message => {
    if (/OUTPOST-(HIT|SLIDER)/.test(message.text())) console.log(message.text());
  });
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:3001/');
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 30000 });
  await page.getByText('Network settings', { exact: true }).click();
  await page.getByLabel('Custom Wisp endpoint').fill('');
  await page.locator('#start').click();
  await page.locator('#address').fill('http://drag-fixture.test/');
  await page.locator('#address').press('Enter');
  await page.locator('#status').filter({ hasText: 'Loaded drag-fixture.test' }).waitFor({ state: 'attached', timeout: 20000 });
  const box = await page.locator('#surface').boundingBox();
  if (process.argv.includes('--screenshot')) await page.locator('#surface').screenshot({ path: '../../work/drag-fixture.png' });
  const exec = script => page.evaluate(script => window.testGecko.evalChrome(script), script);
  const scrollGeometry = JSON.parse(await exec(`JSON.stringify((()=>{let e=document.querySelector('#scroller'),r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,clientWidth:e.clientWidth}})())`));
  const sx = box.x + scrollGeometry.x + scrollGeometry.width - (scrollGeometry.width - scrollGeometry.clientWidth)/2;
  await page.mouse.move(sx, box.y + scrollGeometry.y + 12);
  await page.mouse.down();
  await page.mouse.move(sx, box.y + scrollGeometry.y + 160, { steps: 20 });
  await page.mouse.up();
  const scrollTop = Number(await exec(`document.querySelector('#scroller').scrollTop`));
  const scrollMouse = JSON.parse(await exec('JSON.stringify(mouseLog)'));
  console.log('Scrollbar drag result:', JSON.stringify({ scrollTop, geometry: scrollGeometry, mouse: scrollMouse }));

  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + 40, { steps: 30 });
  await page.mouse.move(box.x + 250, box.y - 10, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(box.x + 280, box.y + 40);
  const state = JSON.parse(await exec('JSON.stringify(dragState)'));
  const trace = await page.evaluate(() => window.dragTrace);
  console.log('Drag result:', JSON.stringify({ active: state.active, moves: state.moves.length, releases: state.ups,
    maxQueueMs: Math.round(Math.max(0, ...trace.map(item => item.queued))) }));
  if (!process.argv.includes('--skip-scrollbar')) assert(scrollTop > 0, 'Dragging the scrollbar must scroll the page');
  assert(state.moves.length > 0, 'The site must receive drag movement');
  assert.equal(state.active, false, 'A release outside the canvas must end the drag');
  assert.equal(state.ups, 1, 'The site must receive exactly one release');
  console.log(process.argv.includes('--skip-scrollbar') ? 'PASS pointer drag' : 'PASS scrollbar and pointer drag');
} finally {
  await browser.close();
}
