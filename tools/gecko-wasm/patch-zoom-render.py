"""Fix software paint and pointer coordinates for native Gecko page zoom.

Apply to the pinned source after patch-native-zoom.py, patch-input-latency.py,
and patch-trackpad.py. This changes the WASM, so rebuild and test the JS/WASM
pair together; do not apply it to an engine used by an existing profile in place.
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
        raise SystemExit(f'Expected one anchor in {path}: {old!r}')
    path.write_text(text.replace(old, new), encoding='utf-8', newline='\n')

paint = root / 'gecko.js/src/embed-paint.cpp'
replace_once(paint,
    '  nsRect r(0, 0, width * appPerCss, height * appPerCss);',
    '''  // RenderDocument paints in CSS pixels. Its caller must apply the current
  // CSS-to-device transform and request a device-sized rectangle in app units.
  int32_t appPerDev = ps->GetPresContext()->AppUnitsPerDevPixel();
  if (appPerDev <= 0) { free(buf); return nullptr; }
  const float scale = float(appPerCss) / float(appPerDev);
  ctx->SetMatrix(Matrix::Scaling(scale, scale));
  nsRect r(0, 0, width * appPerDev, height * appPerDev);''')
replace_once(paint,
    '  // Composite open popups onto the same buffer (no-op when nothing is open).\n  composite_visible_popups',
    '  // Popup widget bounds are already in device pixels.\n  ctx->SetMatrix(Matrix());\n'
    '  // Composite open popups onto the same buffer (no-op when nothing is open).\n  composite_visible_popups')
replace_once(paint,
    '  composite_visible_popups(ctx.get(), ps, width, height, appPerCss);',
    '  composite_visible_popups(ctx.get(), ps, width, height, appPerDev);')

input_path = root / 'gecko.js/src/embed-input.cpp'
replace_once(input_path,
    '  LayoutDeviceIntPoint ref =\n      nsContentUtils::ToWidgetPoint(CSSPoint(x, y), offset, pc);',
    '''  // Host input coordinates are device pixels, while ToWidgetPoint takes CSS pixels.
  const float cssPerDevice = float(pc->AppUnitsPerDevPixel()) / AppUnitsPerCSSPixel();
  LayoutDeviceIntPoint ref =
      nsContentUtils::ToWidgetPoint(CSSPoint(x * cssPerDevice, y * cssPerDevice), offset, pc);''')
replace_once(input_path, '    int32_t a = AppUnitsPerCSSPixel();\n    nsPoint rootPt(x * a, y * a);',
             '    int32_t a = pc->AppUnitsPerDevPixel();\n    nsPoint rootPt(x * a, y * a);')
replace_once(input_path, '  nsPoint point(x * AppUnitsPerCSSPixel(), y * AppUnitsPerCSSPixel());',
             '  nsPoint point(x * pc->AppUnitsPerDevPixel(), y * pc->AppUnitsPerDevPixel());')
replace_once(input_path, '  ev.mRefPoint = nsContentUtils::ToWidgetPoint(CSSPoint(x, y), offset, pc);',
             '''  const float cssPerDevice = float(pc->AppUnitsPerDevPixel()) / AppUnitsPerCSSPixel();
  ev.mRefPoint = nsContentUtils::ToWidgetPoint(CSSPoint(x * cssPerDevice, y * cssPerDevice), offset, pc);''')
