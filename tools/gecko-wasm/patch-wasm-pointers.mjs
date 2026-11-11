// WebAssembly addresses are unsigned 32-bit values. Preserve the high bit when
// reading the mailbox and result buffers; signed JS bit shifts corrupt valid
// pointers once the heap grows beyond 2 GiB.
import fs from 'node:fs';

const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Usage: node patch-wasm-pointers.mjs INPUT_JS OUTPUT_JS');
const bundle=fs.readFileSync(input,'utf8');
const marker=';// CONCATENATED MODULE: ../node_modules/.pnpm/zstddec@';
const cut=bundle.indexOf(marker);
if(cut<0)throw Error('Embedded runtime boundary not found');
let host=bundle.slice(cut);
function replaceOnce(before,after){
  if(host.split(before).length!==2)throw Error(`Expected exactly one anchor: ${before}`);
  host=host.replace(before,after);
}
replaceOnce('this.cmd = this.mod._xul_cmd_ptr();','this.cmd = this.mod._xul_cmd_ptr() >>> 0;');
for(const name of ['off','ST','RES','LEN','CURSOR']){
  const before=`this.cmd + ${name} >> 2`;
  if(!host.includes(before))throw Error(`Missing mailbox offset ${name}`);
  host=host.replaceAll(before,`this.cmd + ${name} >>> 2`);
}
replaceOnce('const resPtr = i32()[this.cmd + RES >>> 2], len = i32()[this.cmd + LEN >>> 2];',
  'const resPtr = i32()[this.cmd + RES >>> 2] >>> 0, len = i32()[this.cmd + LEN >>> 2] >>> 0;');
replaceOnce('const resPtr = i32[this.cmd + RES >>> 2], len = i32[this.cmd + LEN >>> 2];',
  'const resPtr = i32[this.cmd + RES >>> 2] >>> 0, len = i32[this.cmd + LEN >>> 2] >>> 0;');
fs.writeFileSync(output,bundle.slice(0,cut)+host);
