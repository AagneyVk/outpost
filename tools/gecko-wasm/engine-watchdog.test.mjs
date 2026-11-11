import test from 'node:test';
import assert from 'node:assert/strict';
import { watchEngine } from '../../public/gecko-lab/engine-watchdog.mjs';

test('offers recovery for a long-running command and clears it on completion', async () => {
  let resolve, tick, time = 0, visible = false, canceled = false;
  const gecko = {runCmd: () => new Promise(done => {resolve = done;})};
  const stop = watchEngine(gecko, {show:()=>{visible=true;},hide:()=>{visible=false;},
    now:()=>time,schedule:fn=>{tick=fn;return 1;},cancel:()=>{canceled=true;},timeout:20000});
  tick(); assert.equal(visible, false);
  const pending = gecko.runCmd({op:4});
  time = 19999; tick(); assert.equal(visible, false);
  time = 20000; tick(); assert.equal(visible, true);
  resolve(42); assert.equal(await pending, 42); assert.equal(visible, false);
  stop(); assert.equal(canceled, true);
});

test('leaves recovery visible if a command fails', async () => {
  let visible = false;
  const gecko = {runCmd: async () => {throw Error('engine stopped');}};
  const stop = watchEngine(gecko,{show:()=>{visible=true;},hide:()=>{visible=false;},schedule:()=>1,cancel:()=>{}});
  await assert.rejects(gecko.runCmd({op:4}), /engine stopped/);
  assert.equal(visible, true);
  stop();
});
