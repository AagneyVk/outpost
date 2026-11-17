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
#include "mozpkix/pkixnss.h"
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
  // TEST ONLY: use a consumed per-channel property, never an HTTP header.
  nsAutoCString outpostSpec;
  (void)mURI->GetSpec(outpostSpec);
  if (outpostSpec.EqualsLiteral("https://example.com/") ||
      outpostSpec.EqualsLiteral("https://example.com/s.js") ||
      outpostSpec.EqualsLiteral("https://practice.expandtesting.com/login") ||
      outpostSpec.EqualsLiteral("https://practice.expandtesting.com/authenticate") ||
      outpostSpec.EqualsLiteral("https://practice.expandtesting.com/secure") ||
      outpostSpec.EqualsLiteral("https://practice.expandtesting.com/logout") ||
      outpostSpec.EqualsLiteral("https://example.com/?case=missing") ||
      outpostSpec.EqualsLiteral("https://example.com/?case=corrupt")) {
    nsAutoCString evidence;
    nsresult evidenceRv = GetPropertyAsACString(u"outpost.fixture.transport"_ns, evidence);
    (void)DeleteProperty(u"outpost.fixture.transport"_ns);
    if (NS_FAILED(evidenceRv)) return NS_ERROR_FAILURE;
    mSecurityInfo = OutpostTestSecurityInfo(evidence);
    if (!mSecurityInfo) return NS_ERROR_FAILURE;
  }

'''
path.write_text(text.replace(anchor, replacement, 1))
