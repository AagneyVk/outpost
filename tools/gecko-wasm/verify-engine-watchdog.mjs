import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const context=await browser.newContext();
  await context.route('**/gecko-lab/start.mjs',async route=>{
    const response=await route.fetch();
    const source=(await response.text())
      .replace('await gecko.init();',`await gecko.init();window.testGecko=gecko;
        const original=gecko.runCmd.bind(gecko);gecko.runCmd=item=>window.simulateStall?new Promise(()=>{}):original(item);`)
      .replace('watchEngine(gecko, { show:', 'watchEngine(gecko, { timeout:150, interval:25, show:');
    await route.fulfill({response,body:source});
  });
  const page=await context.newPage();
  await page.goto(process.argv[2]??'http://127.0.0.1:3001/');
  await page.waitForFunction(()=>crossOriginIsolated,null,{timeout:30000});
  await page.locator('#start').click();
  await page.locator('#address:enabled').waitFor({timeout:60000});
  assert.equal(await page.locator('#browser-recovery').isVisible(),false);
  await page.evaluate(()=>{window.simulateStall=true;void window.testGecko.run({op:4});});
  await page.locator('#browser-recovery').waitFor({state:'visible',timeout:5000});
  const reload=page.waitForEvent('load');
  await page.locator('#restart-engine').click();
  await reload;
  assert.equal(await page.locator('#browser-recovery').isVisible(),false);
  await page.locator('#start').click();
  await page.locator('#address:enabled').waitFor({timeout:60000});
  console.log('PASS stalled engine offers a restart and starts again');
} finally {await browser.close();}
