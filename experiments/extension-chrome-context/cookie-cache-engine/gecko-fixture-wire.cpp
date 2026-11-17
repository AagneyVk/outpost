#include "nsIX509Cert.h"
#include "nsISiteSecurityService.h"
#include "mozilla/StoragePrincipalHelper.h"
#include "nsIWritablePropertyBag2.h"
#include "nsIWritablePropertyBag.h"
// TEST ONLY: decode one bounded ASCII response from the local fixture provider.
// The encoded path is a disposable test transport, never use it for real secrets.
static nsCString OutpostFixtureBase64(const nsACString& input) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789~_";
  nsCString result;
  uint32_t bits = 0, count = 0;
  for (uint32_t i = 0; i < input.Length(); ++i) {
    unsigned char c = static_cast<unsigned char>(input.CharAt(i));
    bits = (bits << 8) | c;
    count += 8;
    while (count >= 6) { count -= 6; result.Append(alphabet[(bits >> count) & 63]); }
  }
  if (count) result.Append(alphabet[(bits << (6 - count)) & 63]);
  if (result.IsEmpty()) result.AssignLiteral("-");
  return result;
}

static bool OutpostFixtureUpload(nsIHttpChannel* channel, nsCString& body) {
  nsCOMPtr<nsIUploadChannel> upload = do_QueryInterface(channel);
  nsCOMPtr<nsIInputStream> stream;
  if (!upload || NS_FAILED(upload->GetUploadStream(getter_AddRefs(stream))) || !stream) return false;
  nsCOMPtr<nsISeekableStream> seekable = do_QueryInterface(stream);
  int64_t position = 0;
  uint64_t available = 0;
  if (!seekable || NS_FAILED(seekable->Tell(&position)) ||
      NS_FAILED(stream->Available(&available)) || available > 100) return false;
  char bytes[101];
  uint32_t count = 0;
  nsresult rv = stream->Read(bytes, static_cast<uint32_t>(available), &count);
  nsresult restored = seekable->Seek(nsISeekableStream::NS_SEEK_SET, position);
  if (NS_FAILED(rv) || NS_FAILED(restored)) return false;
  body.Assign(bytes, count);
  return true;
}

static bool OutpostFixtureFetch(const char* file, nsIReplacedHttpResponse* response,
                                nsIHttpChannel* channel) {
  nsCOMPtr<nsIWritablePropertyBag2> properties = do_QueryInterface(channel);
  nsCOMPtr<nsIWritablePropertyBag> writableProperties = do_QueryInterface(channel);
  if (!properties || !writableProperties) return false;
  // Redirected channels may inherit properties; discard any prior evidence.
  (void)writableProperties->DeleteProperty(u"outpost.fixture.transport"_ns);
  FILE* stream = fopen(file, "rb");
  if (!stream) return false;
  const size_t capacity = 262144;
  nsCString storage;
  storage.SetLength(capacity + 1);
  char* bytes = storage.BeginWriting();
  const size_t length = fread(bytes, 1, capacity, stream);
  fclose(stream);
  if (length != capacity) return false;
  bytes[length] = 0;
  char* status = bytes;
  char* location = strchr(status, '\n');
  if (!location) return false;
  *location++ = 0;
  char* cookie = strchr(location, '\n');
  if (!cookie) return false;
  *cookie++ = 0;
  char* contentType = strchr(cookie, '\n');
  if (!contentType) return false;
  *contentType++ = 0;
  char* cookie2 = contentType;
  contentType = strchr(cookie2, '\n');
  if (!contentType) return false;
  *contentType++ = 0;
  char* security = strchr(contentType, '\n');
  if (!security) return false;
  *security++ = 0;
  char* hsts = strchr(security, '\n');
  if (!hsts) return false;
  *hsts++ = 0;
  char* cache = strchr(hsts, '\n');
  if (!cache) return false;
  *cache++ = 0;
  char* etag = strchr(cache, '\n');
  if (!etag) return false;
  *etag++ = 0;
  char* body = strchr(etag, '\n');
  if (!body) return false;
  *body++ = 0;
  long code = strtol(status, nullptr, 10);
  if (code != 200 && code != 302 && code != 304 && code != 401 && code != 404) return false;
  if (NS_FAILED(response->SetResponseStatus(code)) ||
      NS_FAILED(response->SetResponseStatusText(code == 302 ? "Found"_ns : "OK"_ns)) ||
      NS_FAILED(response->SetResponseBody(nsDependentCString(body)))) return false;
  if (*location && NS_FAILED(response->SetResponseHeader(
      "Location"_ns, nsDependentCString(location), false))) return false;
  if (*cookie && NS_FAILED(response->SetResponseHeader(
      "Set-Cookie"_ns, nsDependentCString(cookie), false))) return false;
  if (*cookie2 && NS_FAILED(response->SetResponseHeader(
      "Set-Cookie"_ns, nsDependentCString(cookie2), true))) return false;
  if (*contentType && NS_FAILED(response->SetResponseHeader(
      "Content-Type"_ns, nsDependentCString(contentType), false))) return false;
  nsCOMPtr<nsIURI> fixtureURI;
  nsAutoCString fixtureHost;
  if (*cache && NS_FAILED(response->SetResponseHeader("Cache-Control"_ns, nsDependentCString(cache), false))) return false;
  if (*etag && NS_FAILED(response->SetResponseHeader("ETag"_ns, nsDependentCString(etag), false))) return false;
  if (NS_SUCCEEDED(channel->GetURI(getter_AddRefs(fixtureURI))) && fixtureURI &&
      NS_SUCCEEDED(fixtureURI->GetAsciiHost(fixtureHost)) && fixtureHost.EqualsLiteral("practice.expandtesting.com") &&
      NS_FAILED(response->SetResponseHeader("Content-Security-Policy"_ns,
        "default-src 'none'; form-action 'self'; base-uri 'none'"_ns, false))) return false;
  if (*security && NS_FAILED(properties->SetPropertyAsACString(
      u"outpost.fixture.transport"_ns, nsDependentCString(security)))) return false;
  // Deliberately present a forged HTTP header: it must never confer trust.
  if (NS_FAILED(response->SetResponseHeader(
      "X-Outpost-Fixture-TLS"_ns, "v3:TLSv1.3"_ns, false))) return false;
  if (*hsts && NS_FAILED(response->SetResponseHeader(
      "Strict-Transport-Security"_ns, nsDependentCString(hsts), false))) return false;
  return true;
}
