import test from 'node:test';
import assert from 'node:assert/strict';
import { Gecko } from '../../public/gecko-lab/engine/gecko-input-v5.js';

test('paint accepts a valid WebAssembly buffer above the signed 2 GiB boundary', () => {
  const wordArray=globalThis.Uint32Array;
  const words=new Int32Array(5);
  words[3]=0x80000000|0; words[4]=4;
  const output=new wordArray(1);
  const fake={cmd:0,gpu:false,ctx:{putImageData(){}},blitImg:{},blitDst32:output,
    mod:{HEAP32:words,HEAPU8:{buffer:{byteLength:0x80000004}}}};
  let seen;
  try {
    // Model a very large memory buffer without allocating 2 GiB on the host.
    globalThis.Uint32Array=function(buffer, offset, length) {
      seen=offset;
      assert.equal(offset,0x80000000);
      assert.equal(length,1);
      return new wordArray([0xff112233]);
    };
    assert.equal(Gecko.prototype.blit.call(fake),1);
    assert.equal(seen,0x80000000);
  } finally { globalThis.Uint32Array=wordArray; }
});

test('mailbox and evaluated result addresses remain unsigned above 2 GiB', async () => {
  const atomics=globalThis.Atomics;
  const command=0x80000000, result=0x80001000;
  const words=new Map([[((command+12)>>>2),result|0],[((command+16)>>>2),2]]);
  const i32=new Proxy({}, {get:(_,key)=>words.get(Number(key))??0,set:(_,key,value)=>{words.set(Number(key),value);return true;}});
  let range;
  const u8={set(){},subarray(start,end){range=[start,end];return new Uint8Array([111,107]);}};
  const fake={cmd:command,W:20,H:20,gpu:false,queue:[],mod:{HEAP32:i32,HEAPU8:u8},enc:new TextEncoder(),dec:new TextDecoder()};
  try {
    globalThis.Atomics={store(){},notify(){},load(){return 3;}};
    assert.equal(await Gecko.prototype.runCmd.call(fake,{op:5,url:'x'}),'ok');
    assert.deepEqual(range,[result,result+2]);
    assert.equal(words.get(((command+4)>>>2)),20);
  } finally { globalThis.Atomics=atomics; }
});
