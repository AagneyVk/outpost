// Apply to the paired v5 host bundle without modifying its matching WASM.
import { readFile, writeFile } from 'node:fs/promises';
const [input, output] = process.argv.slice(2);
if (!input || !output || input === output) throw Error('Usage: node patch-key-burst.mjs INPUT_JS OUTPUT_JS');
const source = await readFile(input, 'utf8');
const old = 'const skipPaint = !this.gpu && item.op === OP_WHEEL;';
const replacement = 'const skipPaint = !this.gpu && (item.op === OP_WHEEL || (item.op === OP_KEY && this.queue.some(next => next.op === OP_KEY)));';
if (source.split(old).length !== 2) throw Error('Expected exactly one paint flag anchor.');
await writeFile(output, source.replace(old, replacement));
