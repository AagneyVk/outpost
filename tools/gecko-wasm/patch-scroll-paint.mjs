// Apply after patch-input-latency.py and patch-trackpad.py. This changes only
// the host-side glue: the v2 WASM and its 0x100 skip-paint flag remain intact.
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw Error('Usage: node patch-scroll-paint.mjs INPUT_JS OUTPUT_JS');
let source = fs.readFileSync(input, 'utf8');
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw Error(`Expected exactly one anchor: ${before}`);
  source = source.replace(before, after);
}
replaceOnce('    lastWheelPaint = 0;\n    async runCmd(item) {', '    async runCmd(item) {');
replaceOnce(`        // Process every wheel event, but paint at most once per frame during a backlog.
        const now = performance.now();
        const skipPaint = !this.gpu && item.op === OP_WHEEL && this.queue[0]?.op === OP_WHEEL && now - this.lastWheelPaint < 16;
        if (item.op === OP_WHEEL && !skipPaint) this.lastWheelPaint = now;`,
`        // Handle scroll input without a redundant full repaint. The software
        // paint loop presents the latest state on its next scheduled frame.
        const skipPaint = !this.gpu && item.op === OP_WHEEL;`);
fs.writeFileSync(output, source);
