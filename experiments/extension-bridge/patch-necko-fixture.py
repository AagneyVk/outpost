"""Experimental baseline-specific Gecko patch. NOT suitable for production."""
from pathlib import Path
import sys
import os

path = Path(os.environ.get('OUTPOST_NECKO_SOURCE', '/build/firefox/netwerk/protocol/http/nsHttpChannel.cpp'))
source = path.read_text()
if 'if (!LoadIsCorsPreflightDone() && LoadRequireCORSPreflight()) {' in source[
        source.index('nsresult nsHttpChannel::Connect() {'):
        source.index('nsresult nsHttpChannel::ConnectOnTailUnblock()')]:
    sys.exit(0)  # Already patched in this disposable build.

start = source.index('nsresult nsHttpChannel::HandleOverrideResponse() {')
end = source.index('nsresult nsHttpChannel::Connect() {', start)
section = source[start:end]
redirect_start = section.index('  if (WillRedirect(*mResponseHead)) {')
redirect_end = section.index('  // This block parses the cookie header', redirect_start)
redirect = section[redirect_start:redirect_end]
section = section[:redirect_start] + section[redirect_end:]
anchor = '  rv = ProcessWAICTHeader();\n'
assert section.count(anchor) == 1
section = section.replace(anchor, redirect + anchor, 1)
source = source[:start] + section + source[end:]

old = '''  if (mOverrideResponse) {
    return HandleOverrideResponse();
  }
'''
new = '''  if (mOverrideResponse) {
    if (!LoadIsCorsPreflightDone() && LoadRequireCORSPreflight()) {
      MOZ_ASSERT(!mPreflightChannel);
      return nsCORSListenerProxy::StartCORSPreflight(
          this, this, mUnsafeHeaders, getter_AddRefs(mPreflightChannel));
    }
    return HandleOverrideResponse();
  }
'''
start = source.index('nsresult nsHttpChannel::Connect() {')
end = source.index('nsresult nsHttpChannel::ConnectOnTailUnblock()', start)
section = source[start:end]
assert section.count(old) == 1
source = source[:start] + section.replace(old, new, 1) + source[end:]

old = '''  mPreflightChannel = nullptr;

  return ContinueConnect();
'''
new = '''  mPreflightChannel = nullptr;
  if (mOverrideResponse) {
    return HandleOverrideResponse();
  }
  return ContinueConnect();
'''
start = source.index('nsHttpChannel::OnPreflightSucceeded()')
end = source.index('nsHttpChannel::OnPreflightFailed(', start)
section = source[start:end]
assert section.count(old) == 1
source = source[:start] + section.replace(old, new, 1) + source[end:]

start = source.index('NS_IMETHODIMP nsHttpChannel::SetResponseOverride(')
end = source.index('NS_IMETHODIMP nsHttpChannel::SetResponseStatus(', start)
section = source[start:end]
block_start = section.index('  if (LoadRequireCORSPreflight()) {')
block_end = section.index('\n\n  return NS_OK;', block_start)
section = section[:block_start] + section[block_end:]
source = source[:start] + section + source[end:]
path.write_text(source)
