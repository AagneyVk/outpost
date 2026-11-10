"""Experimental touchpad fixes for the pinned, latency-patched Gecko source.

Apply after patch-input-latency.py. Build JS and WASM together; do not deploy
until fractional input, nested scrolling and cancellation have been verified.
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
        raise SystemExit(f'Expected one patch anchor in {path}: {old!r}')
    path.write_text(text.replace(old, new), encoding='utf-8', newline='\n')

ts = root / 'gecko.js/js/index.ts'
replace_once(ts, '    set(OP, item.op | (skipPaint ? 0x100 : 0));',
             '    set(OP, item.op | (skipPaint ? 0x100 : 0) | (item.op === OP_WHEEL ? 0x200 : 0));')
replace_once(ts, '    set(DX, item.deltaX || 0); set(DY, item.deltaY || 0);',
             '    // Wheel deltas use signed fixed-point values; the paired engine decodes them.\n'
             '    const wheelScale = item.op === OP_WHEEL ? 1024 : 1;\n'
             '    const fixed = (n: number) => Math.max(-2147483648, Math.min(2147483647, Math.round(n * wheelScale)));\n'
             '    set(DX, fixed(item.deltaX || 0)); set(DY, fixed(item.deltaY || 0));')
replace_once(ts, 'deltaX: e.deltaX, deltaY: e.deltaY, modifiers: this.mods(e)',
             'deltaX: e.deltaX * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.W : 1), '
             'deltaY: e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.H : 1), modifiers: this.mods(e)')

cpp = root / 'gecko.js/src/embed-xul.cpp'
replace_once(cpp, '          do_wheel(g_cmd->ex, g_cmd->ey, (double)g_cmd->deltaX,\n'
                  '                   (double)g_cmd->deltaY, g_cmd->modifiers);',
             '          do_wheel(g_cmd->ex, g_cmd->ey,\n'
             '                   (double)g_cmd->deltaX / ((g_cmd->op & 0x200) ? 1024.0 : 1.0),\n'
             '                   (double)g_cmd->deltaY / ((g_cmd->op & 0x200) ? 1024.0 : 1.0),\n'
             '                   g_cmd->modifiers);')

cpp = root / 'gecko.js/src/embed-input.cpp'
replace_once(cpp, '#include "embed-xul.h"',
             '#include "embed-xul.h"\n#include "mozilla/WheelHandlingHelper.h"')
replace_once(cpp, '  ScrollContainerFrame* sf = ps->GetRootScrollContainerFrame();\n'
                  '  nsPoint before = sf ? sf->GetScrollPosition() : nsPoint();',
             '  nsIFrame* root = ps->GetRootFrame();\n'
             '  nsPoint point(x * AppUnitsPerCSSPixel(), y * AppUnitsPerCSSPixel());\n'
             '  nsIFrame* hit = root ? nsLayoutUtils::GetFrameForPoint(RelativeTo{root}, point) : nullptr;\n'
             '  layers::ScrollDirections directions;\n'
             '  if (dx) directions += layers::ScrollDirection::eHorizontal;\n'
             '  if (dy) directions += layers::ScrollDirection::eVertical;\n'
             '  ScrollContainerFrame* sf = hit ? nsLayoutUtils::GetNearestScrollableFrameForDirection(hit, directions) : nullptr;\n'
             '  // Gecko keeps a wheel transaction bound to its initial target.\n'
             '  // Follow that target during a gesture; a pause and a new target\n'
             '  // start a new gesture rather than scrolling two containers.\n'
             '  static double lastWheelAt = 0;\n'
             '  const double now = emscripten_get_now();\n'
             '  if (!widget->AsyncPanZoomEnabled()) {\n'
             '    ScrollContainerFrame* transaction = do_QueryFrame(WheelTransaction::GetScrollTargetFrame());\n'
             '    if (transaction && transaction != sf) {\n'
             '      if (now - lastWheelAt > 150) WheelTransaction::EndTransaction();\n'
             '      else sf = transaction;\n'
             '    }\n'
             '  }\n'
             '  lastWheelAt = now;')
replace_once(cpp, '  // Non-APZ (software) path: the dispatched wheel event is "consumed" by the event\n'
                  '  // manager (eConsumeNoDefault) but the scroll isn\'t applied. If the position didn\'t\n'
                  '  // move and content didn\'t preventDefault (e.g. a custom scroller / map), apply the\n'
                  '  // scroll to the root scroll frame ourselves. Use Smooth mode so the GPU compositor\n'
                  '  // animates it over refresh-driver ticks.\n'
                  '  widget->DispatchEvent(&ev);\n'
                  '  if (sf && sf->GetScrollPosition() == before && !ev.DefaultPrevented()) {\n'
                  '    sf->ScrollToCSSPixels(\n'
                  '        CSSPoint::FromAppUnits(before) + CSSPoint((float)dx, (float)dy),\n'
                  '        ScrollMode::Smooth);\n'
                  '  }',
             '  // Gecko handles the default scroll, including nested targets and\n'
             '  // preventDefault. A second manual scroll would duplicate motion.\n'
             '  widget->DispatchEvent(&ev);')
