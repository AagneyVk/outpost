"""Add OUTPOST's bounded native zoom command to the pinned Gecko embedder."""

from pathlib import Path
import subprocess
import sys

REVISION = "bc69aaa5e2c5388bcf93a43b975b490bb940f4c0"
root = Path(sys.argv[1]).resolve()
revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
if revision != REVISION:
    raise SystemExit(f"Expected upstream revision {REVISION}, got {revision}")

path = root / "gecko.js/src/embed-browser.cpp"
source = path.read_text(encoding="utf-8")
if "outpost:zoom:" in source:
    raise SystemExit("Native zoom patch already applied")

include = '#include "embed-xul.h"'
command = "  if (aOutResult) *aOutResult = nullptr;"
if source.count(include) != 1 or source.count(command) < 1:
    raise SystemExit("Expected embedder source anchors are missing")

start = source.index("bool RunChromeScript(")
position = source.index(command, start) + len(command)
source = source[:position] + '''
  // The host exposes only a bounded numeric operation for windowless zoom.
  if (aScript.EqualsLiteral("outpost:zoom-capability")) {
    if (aOutResult) *aOutResult = strdup("outpost-native-zoom-v1");
    return true;
  }
  if (StringBeginsWith(aScript, "outpost:zoom:"_ns)) {
    nsresult rv;
    const nsCString amount(Substring(aScript, sizeof("outpost:zoom:") - 1));
    const int32_t permille = amount.ToInteger(&rv);
    if (NS_FAILED(rv) || permille < 250 || permille > 16000 || !g_docShell) {
      return false;
    }
    auto* context = g_docShell->GetBrowsingContext();
    if (!context || NS_FAILED(context->SetFullZoom(permille / 1000.0f))) {
      return false;
    }
    if (aOutResult) *aOutResult = strdup("ok");
    return true;
  }
''' + source[position:]
source = source.replace(include, include + '\n#include "mozilla/dom/BrowsingContext.h"')
path.write_text(source, encoding="utf-8", newline="\n")
