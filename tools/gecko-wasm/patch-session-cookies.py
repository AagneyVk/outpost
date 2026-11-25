"""Insert OUTPOST's session-cookie commands into the pinned Gecko embedder."""
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
revision = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
if revision != 'bc69aaa5e2c5388bcf93a43b975b490bb940f4c0':
    raise SystemExit(f'Unexpected upstream revision: {revision}')
source = root / 'gecko.js/src/embed-browser.cpp'
text = source.read_text(encoding='utf-8')
anchor = '// A single windowless browser / chrome AppWindow'
if text.count(anchor) != 1 or 'static bool OutpostSessionSave()' in text:
    raise SystemExit('Unexpected or already-patched embedder')
helper = (Path(__file__).parent / 'session-cookie-snapshot.cpp').read_text(encoding='utf-8')
text = text.replace(anchor, helper + '\n#include "nsIX509CertDB.h"\n#include "nsIX509Cert.h"\n#include "nsServiceManagerUtils.h"\n' + anchor, 1)
anchor = '  // The host exposes only a bounded numeric operation for windowless zoom.\n'
if text.count(anchor) != 1:
    raise SystemExit('Could not locate the privileged command handler')
commands = '''  if (StringBeginsWith(aScript, "outpost:inspection-ca:"_ns)) {
    nsAutoCString encoded(Substring(aScript, sizeof("outpost:inspection-ca:") - 1));
    nsCOMPtr<nsIX509CertDB> db = do_GetService("@mozilla.org/security/x509certdb;1");
    nsCOMPtr<nsIX509Cert> cert;
    uint32_t type = 0;
    bool ok = db && encoded.Length() <= 32768 &&
              NS_SUCCEEDED(db->ConstructX509FromBase64(encoded, getter_AddRefs(cert))) &&
              cert && NS_SUCCEEDED(cert->GetCertType(&type)) &&
              type == nsIX509Cert::CA_CERT &&
              NS_SUCCEEDED(db->AddCertFromBase64(encoded, "C,,"_ns, getter_AddRefs(cert)));
    if (aOutResult) *aOutResult = strdup(ok ? "ok" : "error");
    return true;
  }
  if (aScript.EqualsLiteral("outpost:session-cookie-capability")) {
    if (aOutResult) *aOutResult = strdup("outpost-session-cookies-v1");
    return true;
  }
  if (aScript.EqualsLiteral("outpost:session-cookie-save")) {
    bool ok = OutpostSessionSave();
    if (aOutResult) *aOutResult = strdup(ok ? "ok" : "error");
    return true;
  }
  if (aScript.EqualsLiteral("outpost:session-cookie-restore")) {
    bool ok = OutpostSessionRestore();
    if (aOutResult) *aOutResult = strdup(ok ? "ok" : "error");
    return true;
  }
'''
source.write_text(text.replace(anchor, commands + anchor, 1), encoding='utf-8', newline='\n')
