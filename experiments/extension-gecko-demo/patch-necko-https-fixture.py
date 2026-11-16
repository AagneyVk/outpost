"""Expand the test-only ordered hook to the single public HTTPS test origin."""
from pathlib import Path
path = Path('/build/firefox/netwerk/protocol/http/nsHttpChannel.cpp')
text = path.read_text()
old = '''  if (!uri || !uri->SchemeIs("http")) return false;
  nsAutoCString host;
  return NS_SUCCEEDED(uri->GetAsciiHost(host)) &&
         (host.EqualsLiteral("fixture.test") || host.EqualsLiteral("foreign.test"));'''
previous = '''  if (!uri) return false;
  nsAutoCString host;
  if (NS_FAILED(uri->GetAsciiHost(host))) return false;
  return (uri->SchemeIs("http") &&
          (host.EqualsLiteral("fixture.test") || host.EqualsLiteral("foreign.test"))) ||
         (uri->SchemeIs("https") && host.EqualsLiteral("example.com"));'''
previous_full = '''  if (!uri) return false;
  nsAutoCString host;
  if (NS_FAILED(uri->GetAsciiHost(host))) return false;
  return (uri->SchemeIs("http") &&
          (host.EqualsLiteral("fixture.test") || host.EqualsLiteral("foreign.test"))) ||
         (uri->SchemeIs("https") &&
          (host.EqualsLiteral("example.com") || host.EqualsLiteral("expired.badssl.com") ||
           host.EqualsLiteral("self-signed.badssl.com")));'''
new = previous_full.replace('host.EqualsLiteral("self-signed.badssl.com")',
                            'host.EqualsLiteral("self-signed.badssl.com") || host.EqualsLiteral("practice.expandtesting.com")')
if new not in text:
    original = previous_full if previous_full in text else previous if previous in text else old
    assert text.count(original) == 1
    path.write_text(text.replace(original, new, 1))
