// OUTPOST session cookie snapshot. This source is included into the Gecko
// embedder by patch-session-cookies.py; it is not a network transport.
#include "nsICookieManager.h"
#include "nsICookie.h"
#include "nsICookieValidation.h"
#include "nsDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "mozilla/Base64.h"
#include "mozilla/OriginAttributes.h"
#include <errno.h>
#include <inttypes.h>
#include <set>
#include <string>

static constexpr size_t kSessionMaxBytes = 8 * 1024 * 1024;
static constexpr uint32_t kSessionMaxCookies = 4096;
static constexpr char kSessionHeader[] = "OUTPOST-SESSION-COOKIES-1\n";

struct OutpostSessionCookie {
  nsCString host, name, value, path, suffix;
  mozilla::OriginAttributes attrs;
  bool secure = false, httpOnly = false, partitioned = false;
  int32_t sameSite = 0;
  int64_t expiry = 0;
  nsICookie::schemeType scheme = nsICookie::SCHEME_UNSET;
};

static bool OutpostSessionPath(nsCString& path) {
  nsCOMPtr<nsIFile> profile;
  return NS_SUCCEEDED(NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR, getter_AddRefs(profile))) &&
         profile && NS_SUCCEEDED(profile->AppendNative("outpost-session-cookies.dat"_ns)) &&
         NS_SUCCEEDED(profile->GetNativePath(path));
}

static bool OutpostSessionAppendField(const nsACString& field, nsCString& out) {
  nsCString encoded;
  if (NS_FAILED(mozilla::Base64Encode(field, encoded))) return false;
  out.Append(encoded.IsEmpty() ? "-"_ns : encoded);
  out.Append(',');
  return out.Length() <= kSessionMaxBytes;
}

static bool OutpostSessionSave() {
  nsCOMPtr<nsICookieManager> manager = do_GetService("@mozilla.org/cookiemanager;1");
  nsTArray<RefPtr<nsICookie>> cookies;
  if (!manager || NS_FAILED(manager->GetSessionCookies(cookies)) || cookies.Length() > kSessionMaxCookies) return false;
  nsCString data(kSessionHeader);
  for (const auto& cookie : cookies) {
    OutpostSessionCookie c;
    if (NS_FAILED(cookie->GetHost(c.host)) || NS_FAILED(cookie->GetName(c.name)) ||
        NS_FAILED(cookie->GetValue(c.value)) || NS_FAILED(cookie->GetPath(c.path)) ||
        NS_FAILED(cookie->GetIsSecure(&c.secure)) || NS_FAILED(cookie->GetIsHttpOnly(&c.httpOnly)) ||
        NS_FAILED(cookie->GetIsPartitioned(&c.partitioned)) || NS_FAILED(cookie->GetSameSite(&c.sameSite)) ||
        NS_FAILED(cookie->GetSchemeMap(&c.scheme)) || NS_FAILED(cookie->GetExpiry(&c.expiry))) return false;
    cookie->OriginAttributesNative().CreateSuffix(c.suffix);
    if (!OutpostSessionAppendField(c.host, data) || !OutpostSessionAppendField(c.name, data) ||
        !OutpostSessionAppendField(c.value, data) || !OutpostSessionAppendField(c.path, data) ||
        !OutpostSessionAppendField(c.suffix, data)) return false;
    data.Append(nsPrintfCString("%d,%d,%d,%u,%d,%" PRId64 "\n", c.secure, c.httpOnly,
                                c.sameSite, unsigned(c.scheme), c.partitioned, c.expiry));
    if (data.Length() > kSessionMaxBytes) return false;
  }
  nsCString path;
  if (!OutpostSessionPath(path)) return false;
  nsCString temporary(path);
  temporary.AppendLiteral(".tmp");
  FILE* stream = fopen(temporary.get(), "wb");
  if (!stream) return false;
  bool ok = fwrite(data.BeginReading(), 1, data.Length(), stream) == data.Length();
  if (fflush(stream) != 0) ok = false;
  if (fclose(stream) != 0) ok = false;
  if (ok) ok = rename(temporary.get(), path.get()) == 0;
  if (!ok) remove(temporary.get());
  return ok;
}

static bool OutpostSessionInteger(const char* text, int64_t& value) {
  if (!text || !*text) return false;
  errno = 0;
  char* end = nullptr;
  long long parsed = strtoll(text, &end, 10);
  if (errno || !end || *end) return false;
  value = parsed;
  return true;
}

static bool OutpostSessionRestore() {
  nsCString path;
  if (!OutpostSessionPath(path)) return false;
  FILE* stream = fopen(path.get(), "rb");
  if (!stream) return errno == ENOENT;
  if (fseek(stream, 0, SEEK_END) != 0) { fclose(stream); return false; }
  long size = ftell(stream);
  if (size < long(sizeof(kSessionHeader) - 1) || size > long(kSessionMaxBytes) || fseek(stream, 0, SEEK_SET) != 0) {
    fclose(stream); return false;
  }
  nsCString bytes;
  bytes.SetLength(size);
  bool readOk = fread(bytes.BeginWriting(), 1, size, stream) == size;
  if (fclose(stream) != 0) readOk = false;
  if (!readOk || memchr(bytes.BeginReading(), 0, size) ||
      !StringBeginsWith(bytes, nsDependentCString(kSessionHeader))) return false;

  nsTArray<OutpostSessionCookie> records;
  std::set<std::string> unique;
  char* outer = nullptr;
  char* lines = bytes.BeginWriting() + sizeof(kSessionHeader) - 1;
  for (char* line = strtok_r(lines, "\n", &outer); line; line = strtok_r(nullptr, "\n", &outer)) {
    if (records.Length() >= kSessionMaxCookies) return false;
    char* fields[11];
    char* inner = nullptr;
    unsigned n = 0;
    char* token = strtok_r(line, ",", &inner);
    for (; token && n < 11; token = strtok_r(nullptr, ",", &inner)) fields[n++] = token;
    if (n != 11 || token) return false;
    std::string key = std::string(fields[0]) + ',' + fields[1] + ',' + fields[3] + ',' + fields[4];
    if (!unique.insert(key).second) return false;
    OutpostSessionCookie c;
    nsCString* decoded[] = { &c.host, &c.name, &c.value, &c.path, &c.suffix };
    for (unsigned i = 0; i < 5; ++i) {
      if (strcmp(fields[i], "-") && NS_FAILED(mozilla::Base64Decode(nsDependentCString(fields[i]), *decoded[i]))) return false;
      if (decoded[i]->FindChar('\0') != kNotFound) return false;
    }
    int64_t secure, httpOnly, sameSite, scheme, partitioned, expiry;
    if (!OutpostSessionInteger(fields[5], secure) || !OutpostSessionInteger(fields[6], httpOnly) ||
        !OutpostSessionInteger(fields[7], sameSite) || !OutpostSessionInteger(fields[8], scheme) ||
        !OutpostSessionInteger(fields[9], partitioned) || !OutpostSessionInteger(fields[10], expiry) ||
        (secure != 0 && secure != 1) || (httpOnly != 0 && httpOnly != 1) ||
        (partitioned != 0 && partitioned != 1) ||
        (sameSite != 0 && sameSite != 1 && sameSite != 2 && sameSite != 256) ||
        scheme < 0 || scheme > 7 || expiry < 0) return false;
    c.secure = secure; c.httpOnly = httpOnly; c.sameSite = sameSite;
    c.scheme = static_cast<nsICookie::schemeType>(scheme); c.partitioned = partitioned; c.expiry = expiry;
    if (!c.suffix.IsEmpty() && !c.attrs.PopulateFromSuffix(c.suffix)) return false;
    if (c.attrs.mPrivateBrowsingId) return false;
    records.AppendElement(std::move(c));
  }
  nsCOMPtr<nsICookieManager> manager = do_GetService("@mozilla.org/cookiemanager;1");
  if (!manager) return false;
  nsTArray<uint32_t> added;
  bool ok = true;
  for (uint32_t i = 0; i < records.Length(); ++i) {
    auto& c = records[i];
    bool exists = false;
    if (NS_FAILED(manager->CookieExistsNative(c.host, c.path, c.name, &c.attrs, &exists))) { ok = false; break; }
    if (exists) continue;
    nsCOMPtr<nsICookieValidation> validation;
    if (NS_FAILED(manager->AddNative(nullptr, c.host, c.path, c.name, c.value, c.secure,
          c.httpOnly, true, c.expiry, &c.attrs, c.sameSite, c.scheme, c.partitioned, true,
          nullptr, getter_AddRefs(validation)))) { ok = false; break; }
    added.AppendElement(i);
  }
  if (!ok) {
    for (uint32_t i : added) {
      auto& c = records[i];
      (void)manager->RemoveNative(c.host, c.name, c.path, &c.attrs, true, nullptr);
    }
  }
  return ok;
}
