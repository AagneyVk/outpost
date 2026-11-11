import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 850 } });
  const baseline = process.argv.includes('--baseline');
  await context.route('**/gecko-lab/start.mjs', async route => {
    const response = await route.fetch();
    let source = await response.text();
    if (baseline) source = source.replace('gecko-input-v5.js','gecko-input-v3.js')
      .replace('gecko-input-v4.wasm.zst','gecko-input-v2.wasm.zst').replace('    nativeZoom = true;', '    nativeZoom = false;');
    source = source.replace('await gecko.init();', `await gecko.init();
      window.testGecko = gecko; window.inputTrace = []; window.paintTrace = []; window.commandTrace = [];
      const originalRun = gecko.run.bind(gecko), originalRunCmd = gecko.runCmd.bind(gecko), originalBlit = gecko.blit.bind(gecko);
      gecko.run = item => { item.queued = performance.now(); return originalRun(item); };
      gecko.runCmd = async item => {
        const start = performance.now();
        const result = await originalRunCmd(item);
        window.commandTrace.push({op:item.op,queued:item.queued,start,end:performance.now(),next:gecko.queue[0]?.op});
        if (item.op === 3) window.inputTrace.push({ queued:item.queued, start, end:performance.now(), delta:item.deltaY });
        return result;
      };
      gecko.blit = () => { const start=performance.now(), result=originalBlit(); window.paintTrace.push({start,end:performance.now(),result}); return result; };`);
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
      const body = `<body style="height:12000px;margin:0;background:repeating-linear-gradient(white 0 20px,black 20px 40px)"><div id="marker" style="position:fixed;left:100px;top:100px;width:60px;height:60px;background:rgb(0,0,0)"></div><script>
        addEventListener('scroll',()=>{let n=Math.round(scrollY);document.querySelector('#marker').style.background='rgb('+(n%256)+','+(Math.floor(n/256)%256)+',0)'},{passive:true});
      </script></body>`;
      send(2, id, Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
      send(4, id, Buffer.from([1]));
    });
  });
  const page = await context.newPage();
  if (process.env.OUTPOST_PAINT_PROFILE) page.on('console', message => {
    if (message.text().includes('OUTPOST_PAINT_PROFILE')) console.log(message.text());
  });
  await page.goto(process.argv.find(arg => /^https?:/.test(arg)) ?? 'http://127.0.0.1:3001/');
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 30000 });
  await page.getByText('Network settings', { exact: true }).click();
  await page.getByLabel('Custom Wisp endpoint').fill('');
  await page.locator('#start').click();
  await page.locator('#address').fill('http://scroll-display.test/', { timeout: 60000 });
  await page.locator('#address').press('Enter');
  await page.locator('#status').filter({ hasText: 'Loaded scroll-display.test' }).waitFor({ state:'attached', timeout:30000 });
  const zoom = Number(process.env.OUTPOST_MEASURE_ZOOM || 100);
  for (let level = 100; level < zoom; level += 10) await page.locator('#zoom-in').click();
  await page.waitForTimeout(500);
  const result = await page.evaluate(async zoom => {
    window.inputTrace=[]; window.paintTrace=[]; window.commandTrace=[];
    const canvas=document.querySelector('#surface'), rect=canvas.getBoundingClientRect(), ctx=canvas.getContext('2d');
    const samples=[], sentAt=[], begin=performance.now(); let sent=0, running=true;
    const x=Math.round(120*zoom/100*canvas.width/rect.width), y=Math.round(120*zoom/100*canvas.height/rect.height);
    const sample=()=>{const p=ctx.getImageData(x,y,1,1).data;samples.push({t:performance.now()-begin,sent,shown:p[0]+256*p[1]});if(running)requestAnimationFrame(sample);};
    requestAnimationFrame(sample);
    for(let i=0;i<120;i++){
      sent+=4;
      sentAt.push({sent,t:performance.now()-begin});
      canvas.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:rect.left+500,clientY:rect.top+200,deltaY:4}));
      await new Promise(resolve=>setTimeout(resolve,8));
    }
    const end=performance.now();
    await new Promise(resolve=>setTimeout(resolve,1200));
    running=false;
    return {samples,sentAt,input:window.inputTrace,commands:window.commandTrace,paint:window.paintTrace.filter(x=>x.result>0&&x.start>=begin&&x.start<=end),width:canvas.width,height:canvas.height};
  }, zoom);
  const sorted = values => values.sort((a,b)=>a-b);
  const percentile = (values,p) => values.length ? Math.round(sorted(values)[Math.floor((values.length-1)*p)]*10)/10 : 0;
  const during = result.samples.filter(s=>s.sent>40&&s.sent<480);
  const intervals = result.samples.slice(1).map((s,i)=>s.t-result.samples[i].t);
  const paintIntervals = result.paint.slice(1).map((p,i)=>p.start-result.paint[i].start);
  const displayedScale = baseline ? 1 : zoom / 100;
  const displayedDelays = during.filter(s=>s.shown>0).map(s=>{
    const input = result.sentAt.find(entry=>entry.sent>=s.shown*displayedScale-.01);
    return input ? Math.max(0,s.t-input.t) : 0;
  });
  assert(Math.abs(result.samples.at(-1).shown - 480/displayedScale) <= 2, 'The last scroll position must reach the displayed canvas');
  assert(result.paint.length > 0, 'The gesture must produce visible frames');
  console.log(JSON.stringify({baseline,zoom,size:[result.width,result.height],samples:result.samples.length, final:result.samples.at(-1),
    lagPixels:{median:percentile(during.map(s=>s.sent-s.shown*displayedScale),.5),p95:percentile(during.map(s=>s.sent-s.shown*displayedScale),.95)},
    visualDelayMs:{median:percentile(displayedDelays,.5),p95:percentile(displayedDelays,.95)},
    frameIntervalMs:{median:percentile(intervals,.5),p95:percentile(intervals,.95)},
    paintIntervalMs:{median:percentile(paintIntervals,.5),p95:percentile(paintIntervals,.95)},
    wheelQueueMs:{median:percentile(result.input.map(x=>x.start-x.queued),.5),p95:percentile(result.input.map(x=>x.start-x.queued),.95)},
    wheelCommandMs:{median:percentile(result.input.map(x=>x.end-x.start),.5),p95:percentile(result.input.map(x=>x.end-x.start),.95)},
    blitMs:{median:percentile(result.paint.map(x=>x.end-x.start),.5),p95:percentile(result.paint.map(x=>x.end-x.start),.95)},wheels:result.input.length,paints:result.paint.length,
    commands:Object.fromEntries([...new Set(result.commands.map(x=>x.op))].map(op=>{const entries=result.commands.filter(x=>x.op===op);return [op,{n:entries.length,median:percentile(entries.map(x=>x.end-x.start),.5),p95:percentile(entries.map(x=>x.end-x.start),.95)}]}))}));
} finally { await browser.close(); }
