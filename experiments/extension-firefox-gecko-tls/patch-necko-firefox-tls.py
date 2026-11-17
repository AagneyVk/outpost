"""TEST ONLY: attach host evidence to the example.com fixture channel."""
from pathlib import Path
path = Path('/build/firefox/netwerk/protocol/http/nsHttpChannel.cpp')
text = path.read_text()
if 'static already_AddRefed<nsITransportSecurityInfo> OutpostTestSecurityInfo(' in text:
    old = '  if (outpostSpec.EqualsLiteral("https://example.com/")) {'
    new = '''  if (outpostSpec.EqualsLiteral("https://example.com/") ||
      outpostSpec.EqualsLiteral("https://example.com/?case=missing") ||
      outpostSpec.EqualsLiteral("https://example.com/?case=corrupt")) {'''
    if old in text:
        assert text.count(old) == 1
        path.write_text(text.replace(old, new, 1))
    else:
        assert new in text
    raise SystemExit(0)
anchor = '#include "nsITransportSecurityInfo.h"\n'
includes = '''#include "nsITransportSecurityInfo.h"
#include "nsIX509Cert.h"
#include "nsIX509CertDB.h"
#include "mozpkix/pkix.h"
#include "mozpkix/Time.h"
#include "mozilla/Base64.h"
#include "../../../security/manager/ssl/nsNSSComponent.h"
#include "../../../security/manager/ssl/TransportSecurityInfo.h"
'''
assert text.count(anchor) == 1
text = text.replace(anchor, includes, 1)
anchor = 'namespace net {\n'
assert text.count(anchor) == 1
text = text.replace(anchor, anchor + '\n' + Path('/lab/fixture-security-info.cpp').read_text() + '\n', 1)
anchor = '''  rv = mOverrideResponse->VisitResponseHeaders(&visitor);
  NS_ENSURE_SUCCESS(rv, rv);
'''
assert text.count(anchor) == 1
replacement = anchor + '''
  // TEST ONLY: accept evidence only on this single hardcoded fixture URL.
  // A real transport needs a trusted per-request channel, never a header.
  nsAutoCString outpostSpec;
  (void)mURI->GetSpec(outpostSpec);
  if (outpostSpec.EqualsLiteral("https://example.com/") ||
      outpostSpec.EqualsLiteral("https://example.com/?case=missing") ||
      outpostSpec.EqualsLiteral("https://example.com/?case=corrupt")) {
    nsHttpAtom atom(nsHttp::ResolveAtom("X-Outpost-Fixture-TLS"_ns));
    nsAutoCString evidence;
    if (NS_FAILED(mResponseHead->GetHeader(atom, evidence))) return NS_ERROR_FAILURE;
    mResponseHead->ClearHeader(atom);
    mSecurityInfo = OutpostTestSecurityInfo(evidence);
    if (!mSecurityInfo) return NS_ERROR_FAILURE;
  }

'''
path.write_text(text.replace(anchor, replacement, 1))
