import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { chromium } from 'playwright-core';

// Serve unique 4K image URLs through an intercepted Wisp connection. This is a
// reproducible stress fixture, not an assertion about Google's own code.
const image = new PNG({width:3840,height:2160});
const networkOnly=process.argv.includes('--network-only');
const solid=process.argv.includes('--solid');
for (let y=0;y<image.height;y++) for (let x=0;x<image.width;x++) {
  const i=(y*image.width+x)*4;
  image.data[i]=solid?(x>>7)&255:(x+y)&255; image.data[i+1]=(x>>2)&255; image.data[i+2]=solid?(y>>7)&255:(y>>2)&255; image.data[i+3]=255;
}
const png=PNG.sync.write(image,{colorType:6});
console.log('Fixture 4K PNG bytes:',png.length);
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const context=await browser.newContext({viewport:{width:1400,height:850}});
  await context.route('**/gecko-lab/start.mjs',async route=>{
    const response=await route.fetch(); let source=await response.text();
    if(process.argv.includes('--previous')) source=source.replace('gecko-input-v5.js','gecko-input-v3.js')
      .replace('gecko-input-v4.wasm.zst','gecko-input-v2.wasm.zst').replace('    nativeZoom = true;','    nativeZoom = false;');
    source=source.replace('await gecko.init();',`await gecko.init();window.testGecko=gecko;
      window.commandState={completed:0};const orig=gecko.runCmd.bind(gecko),blit=gecko.blit.bind(gecko);
      gecko.blit=()=>{window.commandState.resultPtr=gecko.mod.HEAP32[(gecko.cmd+12)>>>2]>>>0;return blit();};
      gecko.runCmd=async item=>{
        window.commandState.active=item.op;window.commandState.started=performance.now();
        const result=await orig(item);window.commandState.completed++;window.commandState.finished=performance.now();window.commandState.active=null;return result;};`);
    await route.fulfill({response,body:source});
  });
  await context.routeWebSocket('**/network/',socket=>{
    const send=(type,id,payload)=>{const h=Buffer.alloc(5);h[0]=type;h.writeUInt32LE(id,1);socket.send(Buffer.concat([h,payload]));};
    send(3,0,Buffer.from([128,0,0,0]));
    const replied=new Set();
    socket.onMessage(data=>{
      const packet=Buffer.from(data);if(packet[0]!==2)return;
      const id=packet.readUInt32LE(1);if(replied.has(id))return;
      const request=packet.subarray(5).toString('latin1');
      if(!request.includes('\r\n\r\n'))return;
      replied.add(id);
      const picture=/^GET \/large\d+\.png\b/.test(request);
      const html=`<body style="margin:0;background:#234;color:white;font:20px sans-serif"><div id="grid" style="width:700px;display:grid;grid-template-columns:repeat(4,160px);gap:8px;padding:10px"></div><div id="preview" style="position:fixed;left:710px;top:10px;width:600px;height:500px"></div><script>
        window.opened=0;window.loaded=0;for(let i=0;i<16;i++){const b=document.createElement('button');b.textContent='Image '+i;b.style='height:100px;background:#456;color:white';b.onclick=()=>{opened++;if(${networkOnly}){fetch('/large'+i+'.png').then(r=>r.arrayBuffer()).then(()=>loaded++);}else{const img=new Image();img.onload=()=>{loaded++};img.src='/large'+i+'.png';img.style='width:600px;height:400px;object-fit:contain';document.querySelector('#preview').replaceChildren(img);}};document.querySelector('#grid').append(b);}
      </script></body>`;
      const body=picture?png:Buffer.from(html);const type=picture?'image/png':'text/html';
      send(2,id,Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: ${type}\r\nContent-Length: ${body.length}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`),body]));
      send(4,id,Buffer.from([1]));
    });
  });
  const page=await context.newPage();
  page.on('pageerror',error=>console.log('PAGE_ERROR',error.message));
  page.on('console',message=>{if(/abort|out of memory|unreachable/i.test(message.text()))console.log('CONSOLE',message.text().slice(0,300));});
  await page.goto(process.argv.find(arg=>/^https?:/.test(arg))??'http://127.0.0.1:3001/');
  await page.waitForFunction(()=>crossOriginIsolated,null,{timeout:30000});
  await page.getByText('Network settings',{exact:true}).click();await page.getByLabel('Custom Wisp endpoint').fill('');
  await page.locator('#start').click();await page.locator('#address').fill('http://image-gallery.test/',{timeout:60000});
  await page.locator('#address').press('Enter');
  await page.locator('#status').filter({hasText:'Loaded image-gallery.test'}).waitFor({state:'attached',timeout:30000});
  const zoom=Number(process.env.OUTPOST_TEST_ZOOM||100);
  for(let level=100;level<zoom;level+=10)await page.locator('#zoom-in').click();
  if(zoom!==100)await page.waitForTimeout(500);
  const exec=script=>page.evaluate(async script=>Promise.race([window.testGecko.evalChrome(script),new Promise(resolve=>setTimeout(()=>resolve('EVAL_TIMEOUT'),12000))]),script);
  const bounds=await page.locator('#surface').boundingBox();
  const state=()=>page.evaluate(()=>({command:window.commandState,queue:window.testGecko.queue.length,heap:window.testGecko.mod.HEAPU8.byteLength}));
  const count=process.argv.includes('--extended')?16:12;
  for(let i=0;i<count;i++){
    const before=Date.now();
    await page.mouse.click(bounds.x+(90+(i%4)*168)*zoom/100,bounds.y+(60+Math.floor(i/4)*108)*zoom/100);
    await page.waitForTimeout(1200);
    const guest=await exec('JSON.stringify({opened,loaded,src:document.querySelector("#preview img")?.currentSrc??""})');
    console.log(JSON.stringify({step:i+1,elapsed:Date.now()-before,guest,...await state()}));
    assert.notEqual(guest,'EVAL_TIMEOUT','The engine must remain responsive after opening a 4K image');
    assert.equal(JSON.parse(guest).opened,i+1,'Each image selection should reach the page');
    assert.equal(JSON.parse(guest).loaded,i+1,'Each full-size preview should finish loading');
    if(process.argv.includes('--dwell')){
      for(let j=0;j<10;j++){
        await page.waitForTimeout(2000);
        console.log('DWELL',j,JSON.stringify(await state()));
      }
      break;
    }
  }
  const final=JSON.parse(await exec('JSON.stringify({opened,loaded})'));
  assert(final.loaded>0,'The gallery must decode at least one full-size image');
  console.log('PASS repeated 4K gallery interaction');
} finally {await browser.close();}
