// TEST ONLY: session-cookie snapshot limited to the published demo origin.
// This format and command interface must not be used with real credentials.
#include "nsICookieManager.h"
#include "nsICookie.h"
#include "nsICookieValidation.h"
#include "mozilla/Base64.h"
#include "mozilla/OriginAttributes.h"
#include <inttypes.h>

static bool FixtureCookieField(const nsACString& value, nsCString& output) {
  nsCString encoded;
  if (NS_FAILED(mozilla::Base64Encode(value, encoded))) return false;
  output.Append(encoded.IsEmpty() ? "-"_ns : encoded);
  output.Append(',');
  return true;
}

static bool FixtureSaveCookies(nsCString& output) {
  nsCOMPtr<nsICookieManager> manager = do_GetService("@mozilla.org/cookiemanager;1");
  nsTArray<RefPtr<nsICookie>> cookies;
  if (!manager || NS_FAILED(manager->GetSessionCookies(cookies))) return false;
  unsigned count = 0;
  for (const auto& cookie : cookies) {
    nsAutoCString host, name, value, path, suffix;
    bool secure = false, httpOnly = false, partitioned = false;
    int32_t sameSite = 0;
    int64_t expiry = 0;
    nsICookie::schemeType scheme = nsICookie::SCHEME_UNSET;
    if (NS_FAILED(cookie->GetHost(host)) || !host.EqualsLiteral("practice.expandtesting.com")) continue;
    if (++count > 2 || NS_FAILED(cookie->GetName(name)) ||
        !(name.EqualsLiteral("express:sess") || name.EqualsLiteral("express:sess.sig")) ||
        NS_FAILED(cookie->GetValue(value)) || NS_FAILED(cookie->GetPath(path)) ||
        NS_FAILED(cookie->GetIsSecure(&secure)) || NS_FAILED(cookie->GetIsHttpOnly(&httpOnly)) ||
        NS_FAILED(cookie->GetIsPartitioned(&partitioned)) || NS_FAILED(cookie->GetSameSite(&sameSite)) ||
        NS_FAILED(cookie->GetSchemeMap(&scheme)) || NS_FAILED(cookie->GetExpiry(&expiry))) return false;
    cookie->OriginAttributesNative().CreateSuffix(suffix);
    if (!FixtureCookieField(name, output) || !FixtureCookieField(value, output) ||
        !FixtureCookieField(path, output) || !FixtureCookieField(suffix, output)) return false;
    output.Append(nsPrintfCString("%d,%d,%d,%u,%d,%" PRId64 "\n", secure, httpOnly,
                                  sameSite, unsigned(scheme), partitioned, expiry));
  }
  return count == 2 && output.Length() <= 4096;
}

static bool FixtureRestoreCookies(const nsACString& input) {
  if (input.IsEmpty() || input.Length() > 4096) return false;
  nsCOMPtr<nsICookieManager> manager = do_GetService("@mozilla.org/cookiemanager;1");
  if (!manager) return false;
  nsCString mutableInput(input);
  char* outer = nullptr;
  unsigned count = 0;
  for (char* line = strtok_r(mutableInput.BeginWriting(), "\n", &outer); line;
       line = strtok_r(nullptr, "\n", &outer)) {
    if (++count > 2) return false;
    char* fields[10];
    char* inner = nullptr;
    unsigned n = 0;
    for (char* token = strtok_r(line, ",", &inner); token && n < 10;
         token = strtok_r(nullptr, ",", &inner)) fields[n++] = token;
    if (n != 10) return false;
    nsCString name, value, path, suffix;
    nsCString* decoded[] = { &name, &value, &path, &suffix };
    for (unsigned i = 0; i < 4; ++i) {
      if (strcmp(fields[i], "-") && NS_FAILED(mozilla::Base64Decode(nsDependentCString(fields[i]), *decoded[i]))) return false;
    }
    if (!(name.EqualsLiteral("express:sess") || name.EqualsLiteral("express:sess.sig"))) return false;
    int secure, httpOnly, sameSite, scheme, partitioned;
    int64_t expiry;
    if (sscanf(fields[4], "%d", &secure) != 1 || sscanf(fields[5], "%d", &httpOnly) != 1 ||
        sscanf(fields[6], "%d", &sameSite) != 1 || sscanf(fields[7], "%d", &scheme) != 1 ||
        sscanf(fields[8], "%d", &partitioned) != 1 || sscanf(fields[9], "%" SCNd64, &expiry) != 1 ||
        (secure != 0 && secure != 1) || (httpOnly != 0 && httpOnly != 1) ||
        (partitioned != 0 && partitioned != 1) || scheme < 0 || scheme > 7) return false;
    mozilla::OriginAttributes attributes;
    if (!suffix.IsEmpty() && !attributes.PopulateFromSuffix(suffix)) return false;
    bool exists = false;
    if (NS_FAILED(manager->CookieExistsNative("practice.expandtesting.com"_ns, path, name, &attributes, &exists)) || exists) return false;
    nsCOMPtr<nsICookieValidation> validation;
    if (NS_FAILED(manager->AddNative(nullptr, "practice.expandtesting.com"_ns, path, name, value,
          secure, httpOnly, true, expiry, &attributes, sameSite,
          static_cast<nsICookie::schemeType>(scheme), partitioned, true, nullptr,
          getter_AddRefs(validation)))) return false;
  }
  return count == 2;
}
