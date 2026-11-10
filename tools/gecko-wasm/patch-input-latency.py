"""Experimental input IPC and scroll-paint patch for the pinned Gecko build.

Apply only to an isolated checkout before building both the JS and WASM assets.
The result must pass the input, navigation, HTTPS and profile tests before release.
"""
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
revision = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
if revision != 'bc69aaa5e2c5388bcf93a43b975b490bb940f4c0':
    raise SystemExit(f'Unexpected upstream revision: {revision}')

def replace_once(path, old, new):
    text = path.read_text(encoding='utf-8')
    if text.count(old) != 1:
        raise SystemExit(f'Expected exactly one patch anchor in {path}: {old!r}')
    path.write_text(text.replace(old, new), encoding='utf-8', newline='\n')

cpp = root / 'gecko.js/src/embed-xul.cpp'
replace_once(cpp, '      switch (g_cmd->op) {',
             '      const bool skipPaint = (g_cmd->op & 0x100) != 0;\n'
             '      const int op = g_cmd->op & 0xff;\n'
             '      switch (op) {')
replace_once(cpp, '      } else if (g_cmd->op == 9 || g_mirror) {',
             '      } else if (g_cmd->op == 9 || g_mirror || skipPaint) {')
replace_once(cpp, '        g_cmd->state = (g_gpu ? ok : (buf != nullptr)) ? 3 : -1;  // done / error\n      }',
             '        g_cmd->state = (g_gpu ? ok : (buf != nullptr)) ? 3 : -1;  // done / error\n'
             '      }\n'
             '      emscripten_futex_wake((void*)&g_cmd->state, 1);')

ts = root / 'gecko.js/js/index.ts'
replace_once(ts, '  private async runCmd(item: Cmd): Promise<number | string | null> {',
             '  private lastWheelPaint = 0;\n'
             '  private async runCmd(item: Cmd): Promise<number | string | null> {')
replace_once(ts, '    set(OP, item.op);',
             '    // Process every wheel event, but paint at most once per frame during a backlog.\n'
             '    const now = performance.now();\n'
             '    const skipPaint = !this.gpu && item.op === OP_WHEEL &&\n'
             '      this.queue[0]?.op === OP_WHEEL && now - this.lastWheelPaint < 16;\n'
             '    if (item.op === OP_WHEEL && !skipPaint) this.lastWheelPaint = now;\n'
             '    set(OP, item.op | (skipPaint ? 0x100 : 0));')
replace_once(ts, '      await new Promise((r) => setTimeout(r, item.op === OP_LOAD ? 20 : 4));',
             '      // The paired engine wakes this mailbox on completion. Fall back to\n'
             '      // bounded polling when waitAsync is unavailable.\n'
             '      const waitAsync = (Atomics as any).waitAsync;\n'
             '      if (typeof waitAsync === "function") {\n'
             '        const wait = waitAsync(i32(), (this.cmd + ST) >> 2, st,\n'
             '          item.op === OP_LOAD ? 20 : 4);\n'
             '        if (wait.async) await wait.value;\n'
             '      } else {\n'
             '        await new Promise((r) => setTimeout(r, item.op === OP_LOAD ? 20 : 4));\n'
             '      }')
