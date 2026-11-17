"""Move fixture-only bridge notification after Gecko's CORS preflight.

TEST ONLY: intentionally limited to the two reserved fixture origins. This is
not a production architecture, a generic network transport, or a Web API.
Run after patch-necko-fixture.py on a disposable Gecko source copy.
"""
from pathlib import Path
import os

path = Path(os.environ.get('OUTPOST_NECKO_SOURCE', '/build/firefox/netwerk/protocol/http/nsHttpChannel.cpp'))
source = path.read_text()
marker = 'static bool OutpostFixtureBridgeURI(nsIURI* uri)'
if marker in source:
    raise SystemExit(0)

anchor = 'nsresult nsHttpChannel::ContinueOnBeforeConnect(bool aShouldUpgrade,'
assert source.count(anchor) == 1
helper = '''// Synthetic test-only hook; restricted to reserved local fixture hostnames.
static bool OutpostFixtureBridgeURI(nsIURI* uri) {
  if (!uri || !uri->SchemeIs("http")) return false;
  nsAutoCString host;
  return NS_SUCCEEDED(uri->GetAsciiHost(host)) &&
         (host.EqualsLiteral("fixture.test") || host.EqualsLiteral("foreign.test"));
}

static void OutpostFixtureNotify(nsIHttpChannel* channel) {
  nsCOMPtr<nsIObserverService> service = mozilla::services::GetObserverService();
  if (service) {
    (void)service->NotifyObservers(channel, "outpost-fixture-after-preflight", nullptr);
  }
}

'''
source = source.replace(anchor, helper + anchor, 1)

start = source.index(anchor)
end = source.index('class MOZ_STACK_CLASS AddResponseHeadersToResponseHead', start)
section = source[start:end]
old = '''  // notify "http-on-before-connect" observers
  gHttpHandler->OnBeforeConnect(this);

  return CallOrWaitForResume([](auto* self) { return self->Connect(); });
'''
new = '''  // Keep the existing observer notification unchanged.
  gHttpHandler->OnBeforeConnect(this);

  if (OutpostFixtureBridgeURI(mURI)) {
    if (!LoadIsCorsPreflightDone() && LoadRequireCORSPreflight()) {
      MOZ_ASSERT(!mPreflightChannel);
      return nsCORSListenerProxy::StartCORSPreflight(
          this, this, mUnsafeHeaders, getter_AddRefs(mPreflightChannel));
    }
    OutpostFixtureNotify(static_cast<nsIHttpChannel*>(this));
  }
  return CallOrWaitForResume([](auto* self) { return self->Connect(); });
'''
assert section.count(old) == 1
source = source[:start] + section.replace(old, new, 1) + source[end:]

start = source.index('nsHttpChannel::OnPreflightSucceeded()')
end = source.index('nsHttpChannel::OnPreflightFailed(', start)
section = source[start:end]
old = '''  mPreflightChannel = nullptr;
  if (mOverrideResponse) {'''
new = '''  mPreflightChannel = nullptr;
  if (OutpostFixtureBridgeURI(mURI)) {
    OutpostFixtureNotify(static_cast<nsIHttpChannel*>(this));
    return CallOrWaitForResume([](auto* self) { return self->Connect(); });
  }
  if (mOverrideResponse) {'''
assert section.count(old) == 1
source = source[:start] + section.replace(old, new, 1) + source[end:]
path.write_text(source)
