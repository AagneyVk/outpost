"""TEST ONLY: explore Gecko's in-memory cache for the fixed matrix origin.

Not suitable for arbitrary websites or distribution. Fails closed if the
test-only observer cannot supply a response; never falls back to a socket.
"""
from pathlib import Path

path = Path('/build/firefox/netwerk/protocol/http/nsHttpChannel.cpp')
source = path.read_text()
def once(old, new):
    global source
    assert source.count(old) == 1, (old[:100], source.count(old))
    source = source.replace(old, new, 1)
def override_once(old, new):
    global source
    start = source.index('nsresult nsHttpChannel::HandleOverrideResponse()')
    end = source.index('nsresult nsHttpChannel::Connect()', start)
    section = source[start:end]
    assert section.count(old) == 1, (old[:100], section.count(old))
    source = source[:start] + section.replace(old, new, 1) + source[end:]

anchor = 'static void OutpostFixtureNotify(nsIHttpChannel* channel) {'
helper = '''static bool OutpostMatrixCacheURI(nsIURI* uri) {
  if (!uri || !uri->SchemeIs("http")) return false;
  nsAutoCString spec;
  return NS_SUCCEEDED(uri->GetSpec(spec)) &&
         StringBeginsWith(spec, "http://fixture.test/matrix/"_ns);
}

'''
once(anchor, helper + anchor)
once('#include "nsITransportSecurityInfo.h"\n', '#include <stdio.h>\n#include "nsITransportSecurityInfo.h"\n')
once('''  if (OutpostFixtureBridgeURI(mURI)) {
    if (!LoadIsCorsPreflightDone() && LoadRequireCORSPreflight()) {''',
'''  if (OutpostMatrixCacheURI(mURI)) mLoadFlags |= INHIBIT_PERSISTENT_CACHING;
  if (OutpostFixtureBridgeURI(mURI) && !OutpostMatrixCacheURI(mURI)) {
    if (!LoadIsCorsPreflightDone() && LoadRequireCORSPreflight()) {''')
once('''  if (OutpostFixtureBridgeURI(mURI)) {
    OutpostFixtureNotify(static_cast<nsIHttpChannel*>(this));
    return CallOrWaitForResume([](auto* self) { return self->Connect(); });
  }
  if (mOverrideResponse) {''',
'''  if (OutpostFixtureBridgeURI(mURI) && !OutpostMatrixCacheURI(mURI)) {
    OutpostFixtureNotify(static_cast<nsIHttpChannel*>(this));
    return CallOrWaitForResume([](auto* self) { return self->Connect(); });
  }
  if (mOverrideResponse) {''')
once('''  // Consider opening a TCP connection right away.
  SpeculativeConnect();''',
'''  // The fixed test transport must never open a real network socket.
  if (!OutpostMatrixCacheURI(mURI)) SpeculativeConnect();''')
once('''  // hit the net...
  nsresult rv = DoConnect(mTransactionSticky);''',
'''  if (OutpostMatrixCacheURI(mURI)) {
    fprintf(stderr, "MATRIX_CACHE before %s entry=%d write=%d read=%d flags=%u\\n", mSpec.get(), mCacheEntry ? 1 : 0,
            LoadCacheEntryIsWriteOnly() ? 1 : 0, LoadCacheEntryIsReadOnly() ? 1 : 0, unsigned(mLoadFlags));
    mRequestTime = NowInSeconds();
    StoreRequestTimeInitialized(true);
    OutpostFixtureNotify(static_cast<nsIHttpChannel*>(this));
    if (!mOverrideResponse) return NS_ERROR_FAILURE;
    return HandleOverrideResponse();
  }
  // hit the net...
  nsresult rv = DoConnect(mTransactionSticky);''')
anchor = '''  if (WillRedirect(*mResponseHead)) {
    // TODO: Bug 759040'''
override_once(anchor, '''  if (OutpostMatrixCacheURI(mURI) && statusCode == 304 &&
      !ShouldBypassProcessNotModified()) {
    auto continuation = [](auto* self, nsresult result) {
      return self->ContinueProcessResponseAfterNotModified(result);
    };
    rv = ProcessNotModified(continuation);
    if (!mSuspendCount || NS_FAILED(rv)) return ContinueProcessResponseAfterNotModified(rv);
    return NS_OK;
  }

''' + anchor)
anchor = '''  nsAutoCString body;
  rv = mOverrideResponse->GetResponseBody(body);'''
override_once(anchor, '''  // The synthetic matrix writes only ordinary 200 responses to the
  // memory-only Gecko cache. Production code must handle all HTTP semantics.
  if (OutpostMatrixCacheURI(mURI) && mCacheEntry && statusCode == 200 &&
      !mResponseHead->NoStore()) {
    // The fixed-size fixture has already buffered its complete body.
    // This assertion is NOT valid for an arbitrary production transport.
    StoreStronglyFramed(true);
    rv = UpdateExpirationTime();
    NS_ENSURE_SUCCESS(rv, rv);
    rv = InitCacheEntry();
    NS_ENSURE_SUCCESS(rv, rv);
    fprintf(stderr, "MATRIX_CACHE initialized %s entry=%d write=%d read=%d\\n", mSpec.get(), mCacheEntry ? 1 : 0,
            LoadCacheEntryIsWriteOnly() ? 1 : 0, LoadCacheEntryIsReadOnly() ? 1 : 0);
    if (mCacheEntry && !LoadCacheEntryIsReadOnly() && LoadCacheEntryIsWriteOnly()) {
      rv = InstallCacheListener();
      NS_ENSURE_SUCCESS(rv, rv);
    }
  }
  nsAutoCString body;
  rv = mOverrideResponse->GetResponseBody(body);''')
path.write_text(source)
