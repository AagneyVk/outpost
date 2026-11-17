"""Apply a test-only fixture to an isolated throwaway Gecko source tree."""
from pathlib import Path
import os

source = Path('/build/gecko.js/src/embed-browser.cpp')
hook = Path('/lab/gecko-fixture-hook.cpp').read_text()
if os.environ.get('OUTPOST_ORDERED_FIXTURE') == '1':
    hook = hook.replace('http-on-before-connect', 'outpost-fixture-after-preflight')
    old_hosts = '''  if (!StringBeginsWith(spec, "http://fixture.test/"_ns) &&
      !StringBeginsWith(spec, "http://foreign.test/"_ns)) return NS_OK;'''
    new_hosts = '''  if (!StringBeginsWith(spec, "http://fixture.test/"_ns) &&
      !StringBeginsWith(spec, "http://foreign.test/"_ns) &&
      !spec.EqualsLiteral("https://example.com/") &&
      !spec.EqualsLiteral("https://example.com/?case=missing") &&
      !spec.EqualsLiteral("https://example.com/?case=corrupt") &&
      !spec.EqualsLiteral("https://example.com/s.js") &&
      !spec.EqualsLiteral("https://expired.badssl.com/") &&
      !spec.EqualsLiteral("https://self-signed.badssl.com/") &&
      !StringBeginsWith(spec, "https://practice.expandtesting.com/"_ns)) return NS_OK;'''
    assert hook.count(old_hosts) == 1
    hook = hook.replace(old_hosts, new_hosts, 1)
    wire = Path('/lab/gecko-fixture-wire.cpp').read_text() + '\n' + Path('/lab/gecko-cookie-test.cpp').read_text()
    hook = hook.replace('#include <stdio.h>\n', '#include <stdio.h>\n#include <stdlib.h>\n#include "nsIUploadChannel.h"\n#include "nsIInputStream.h"\n#include "nsISeekableStream.h"\n' + wire, 1)
    anchor = '''    if (method.EqualsLiteral("POST")) {
      ++gFixtureCorsPosts;'''
    replacement = '''    if (method.EqualsLiteral("POST")) {
      // Test-only host boundary: the virtual GRE provider forwards this read
      // through the extension to a synthetic local side-effect endpoint.
      const char* file = spec.EqualsLiteral("http://foreign.test/cors-denied")
          ? "/fixture-mount/outpost-fixture-denied" : "/fixture-mount/outpost-fixture-allowed";
      if (!OutpostFixtureFetch(file, response)) return NS_ERROR_FAILURE;
      ++gFixtureCorsPosts;'''
    assert hook.count(anchor) == 1
    hook = hook.replace(anchor, replacement, 1)
    anchor = '    response->SetResponseBody("fixture-cors"_ns);'
    assert hook.count(anchor) == 1
    hook = hook.replace(anchor, '    if (!method.EqualsLiteral("POST")) response->SetResponseBody("fixture-cors"_ns);', 1)
    anchor = '  } else if (spec.EqualsLiteral("http://fixture.test/login")) {'
    replacement = '''  } else if (spec.EqualsLiteral("https://practice.expandtesting.com/login") && method.EqualsLiteral("GET")) {
    if (!OutpostFixtureFetch("/fixture-mount/outpost-fixture-demo-login", response)) return NS_ERROR_FAILURE;
  } else if (spec.EqualsLiteral("https://practice.expandtesting.com/authenticate") && method.EqualsLiteral("POST")) {
    nsCString body;
    if (!OutpostFixtureUpload(channel, body)) return NS_ERROR_FAILURE;
    nsCString path("/fixture-mount/outpost-fixture-demo-auth-");
    path.Append(OutpostFixtureBase64(body));
    if (!OutpostFixtureFetch(path.get(), response)) return NS_ERROR_FAILURE;
  } else if (spec.EqualsLiteral("https://practice.expandtesting.com/secure") && method.EqualsLiteral("GET")) {
    nsAutoCString cookie;
    channel->GetRequestHeader("Cookie"_ns, cookie);
    // 170 bytes is the largest safe test value for a single encoded filename.
    if (cookie.Length() > 170) return NS_ERROR_FAILURE;
    nsCString path("/fixture-mount/outpost-fixture-demo-secure-");
    path.Append(OutpostFixtureBase64(cookie));
    if (!OutpostFixtureFetch(path.get(), response)) return NS_ERROR_FAILURE;
  } else if (StringBeginsWith(spec, "https://practice.expandtesting.com/"_ns)) {
    response->SetResponseStatus(404);
    response->SetResponseBody("fixture subresource unavailable"_ns);
  } else if (spec.EqualsLiteral("https://example.com/?case=missing")) {
    if (!OutpostFixtureFetch("/fixture-mount/outpost-fixture-example-missing", response))
      return NS_ERROR_FAILURE;
  } else if (spec.EqualsLiteral("https://example.com/?case=corrupt")) {
    if (!OutpostFixtureFetch("/fixture-mount/outpost-fixture-example-corrupt", response))
      return NS_ERROR_FAILURE;
  } else if (spec.EqualsLiteral("https://example.com/")) {
    if (!OutpostFixtureFetch("/fixture-mount/outpost-fixture-example", response))
      return NS_ERROR_FAILURE;
  } else if (spec.EqualsLiteral("https://example.com/s.js")) {
    if (!OutpostFixtureFetch("/fixture-mount/outpost-fixture-example-script", response))
      return NS_ERROR_FAILURE;
  } else if (spec.EqualsLiteral("https://expired.badssl.com/")) {
    if (!OutpostFixtureFetch("/fixture-mount/outpost-fixture-expired", response))
      return NS_ERROR_FAILURE;
  } else if (spec.EqualsLiteral("https://self-signed.badssl.com/")) {
    if (!OutpostFixtureFetch("/fixture-mount/outpost-fixture-self-signed", response))
      return NS_ERROR_FAILURE;
  } else if (spec.EqualsLiteral("http://fixture.test/bridge-login")) {
    if (!OutpostFixtureFetch("/fixture-mount/outpost-fixture-login", response))
      return NS_ERROR_FAILURE;
  } else if (spec.EqualsLiteral("http://fixture.test/account")) {
    nsAutoCString guestCookie;
    channel->GetRequestHeader("Cookie"_ns, guestCookie);
    const char* file = guestCookie.Find("workspace_session=alpha") >= 0
        ? "/fixture-mount/outpost-fixture-account-with-cookie"
        : "/fixture-mount/outpost-fixture-account-without-cookie";
    if (!OutpostFixtureFetch(file, response)) return NS_ERROR_FAILURE;
''' + anchor
    assert hook.count(anchor) == 1
    hook = hook.replace(anchor, replacement, 1)
    # Observer return values are not propagated by NotifyObservers. Explicitly
    # cancel the Gecko channel on any test-transport failure, so it cannot
    # continue into the relay or treat a failed fetch as a valid response.
    hook = hook.replace('return NS_ERROR_FAILURE;',
                        '{ (void)channel->Cancel(NS_ERROR_FAILURE); return NS_OK; }')
    init = Path('/build/gecko.js/src/embed-init.cpp')
    init_text = init.read_text()
    old = 'int grv = wasmfs_create_directory(greDir, 0555, gb);'
    new = 'int grv = wasmfs_create_directory("/fixture-mount", 0555, gb);'
    if old in init_text:
        assert init_text.count(old) == 1
        init.write_text(init_text.replace(old, new, 1))
    else:
        assert new in init_text
text = source.read_text()
text = text.replace(
    '(aFlags & nsIWebProgressListener::STATE_STOP) && NS_FAILED(aStatus) &&\n      !gFixtureNavigationUrl',
    '(aFlags & nsIWebProgressListener::STATE_STOP) && aStatus == NS_ERROR_FAILURE &&\n      !gFixtureNavigationUrl'
)
anchor = '// A single windowless browser / chrome AppWindow'
marker = '// TEST ONLY: inserted into a disposable Gecko build; never ship this hook.'
if marker in text:
    text = text[:text.index(marker)] + text[text.index(anchor):]
assert text.count(anchor) == 1
text = text.replace(anchor, hook + '\n' + anchor, 1)
if os.environ.get('OUTPOST_ORDERED_FIXTURE') == '1' and 'return gFixtureNavigationFailed || (isNew' not in text:
    anchor = '  if (aReq) aReq->GetName(name);\n'
    replacement = '''  if (aReq) aReq->GetName(name);
  if ((aFlags & nsIWebProgressListener::STATE_STOP) && aStatus == NS_ERROR_FAILURE &&
      !gFixtureNavigationUrl.IsEmpty() && name.Find(gFixtureNavigationUrl) >= 0) {
    gFixtureNavigationFailed = true;
  }
'''
    assert text.count(anchor) == 1
    text = text.replace(anchor, replacement, 1)
    anchor = '    dom::LoadURIOptions opts;\n'
    replacement = '''    gFixtureNavigationFailed = false;
    gFixtureNavigationUrl.Assign(url);
    dom::LoadURIOptions opts;
'''
    assert text.count(anchor) == 1
    text = text.replace(anchor, replacement, 1)
    anchor = '    return (isNew && st >= (int)Document::READYSTATE_INTERACTIVE) ||\n'
    replacement = '    return gFixtureNavigationFailed || (isNew && st >= (int)Document::READYSTATE_INTERACTIVE) ||\n'
    assert text.count(anchor) == 1
    text = text.replace(anchor, replacement, 1)
anchor = '  // The host exposes only a bounded numeric operation for windowless zoom.\n'
marker = '  if (aScript.EqualsLiteral("outpost:fixture-install")) {'
if marker in text:
    text = text[:text.index(marker)] + text[text.index(anchor):]
assert text.count(anchor) == 1
commands = '''  if (aScript.EqualsLiteral("outpost:fixture-install")) {
    bool ok = InstallOutpostFixture();
    if (aOutResult) *aOutResult = strdup(ok ? "ok" : "error");
    return ok;
  }
  if (aScript.EqualsLiteral("outpost:fixture-cookies-save")) {
    nsCString data;
    if (!FixtureSaveCookies(data)) return false;
    if (aOutResult) *aOutResult = strdup(data.get());
    return true;
  }
  if (StringBeginsWith(aScript, "outpost:fixture-cookies-restore:"_ns)) {
    nsDependentCSubstring data(Substring(aScript, sizeof("outpost:fixture-cookies-restore:") - 1));
    bool ok = FixtureRestoreCookies(data);
    if (aOutResult) *aOutResult = strdup(ok ? "ok" : "error");
    return ok;
  }
  if (aScript.EqualsLiteral("outpost:fixture-stats")) {
    nsPrintfCString value("%u,%u", gFixturePreflights, gFixtureCorsPosts);
    if (aOutResult) *aOutResult = strdup(value.get());
    return true;
  }
  if (aScript.EqualsLiteral("outpost:fixture-order")) {
    if (aOutResult) *aOutResult = strdup(gFixtureRequestOrder.get());
    return true;
  }
  if (aScript.EqualsLiteral("outpost:fixture-security-info")) {
    nsCOMPtr<nsITransportSecurityInfo> info;
    nsresult rv = gFixtureHttpsChannel
        ? gFixtureHttpsChannel->GetSecurityInfo(getter_AddRefs(info))
        : NS_ERROR_NOT_AVAILABLE;
    if (aOutResult) *aOutResult = strdup(NS_FAILED(rv) ? "unavailable" : info ? "present" : "absent");
    return true;
  }
  if (aScript.EqualsLiteral("outpost:fixture-cert-fingerprint")) {
    nsCOMPtr<nsITransportSecurityInfo> info;
    nsCOMPtr<nsIX509Cert> cert;
    nsAutoString fingerprint;
    if (!gFixtureHttpsChannel || NS_FAILED(gFixtureHttpsChannel->GetSecurityInfo(getter_AddRefs(info))) ||
        !info || NS_FAILED(info->GetServerCert(getter_AddRefs(cert))) || !cert ||
        NS_FAILED(cert->GetSha256Fingerprint(fingerprint))) return false;
    if (aOutResult) *aOutResult = strdup(NS_ConvertUTF16toUTF8(fingerprint).get());
    return true;
  }
  if (aScript.EqualsLiteral("outpost:fixture-hsts")) {
    nsCOMPtr<nsISiteSecurityService> service = do_GetService(NS_SSSERVICE_CONTRACTID);
    nsCOMPtr<nsIURI> uri;
    mozilla::OriginAttributes attributes;
    bool secure = false;
    if (gFixtureHttpsChannel &&
        !mozilla::StoragePrincipalHelper::GetOriginAttributesForHSTS(gFixtureHttpsChannel, attributes)) return false;
    if (!service || NS_FAILED(NS_NewURI(getter_AddRefs(uri), "https://example.com/"_ns)) ||
        NS_FAILED(service->IsSecureURI(uri, attributes, &secure))) return false;
    if (aOutResult) *aOutResult = strdup(secure ? "present" : "absent");
    return true;
  }
  if (aScript.EqualsLiteral("outpost:fixture-nav-status")) {
    if (aOutResult) *aOutResult = strdup(gFixtureNavigationFailed ? "failed" : "ok");
    return true;
  }
'''
if os.environ.get('OUTPOST_ORDERED_FIXTURE') != '1':
    start = commands.index('  if (aScript.EqualsLiteral("outpost:fixture-cookies-save"))')
    end = commands.index('  if (aScript.EqualsLiteral("outpost:fixture-stats"))')
    commands = commands[:start] + commands[end:]
text = text.replace(anchor, commands + anchor, 1)
source.write_text(text)
