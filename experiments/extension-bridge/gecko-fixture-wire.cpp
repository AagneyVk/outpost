// TEST ONLY: decode one bounded ASCII response from the local fixture provider.
static bool OutpostFixtureFetch(const char* file, nsIReplacedHttpResponse* response) {
  FILE* stream = fopen(file, "rb");
  if (!stream) return false;
  char bytes[4097];
  const size_t length = fread(bytes, 1, 4096, stream);
  fclose(stream);
  if (length != 4096) return false;
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
  char* body = strchr(contentType, '\n');
  if (!body) return false;
  *body++ = 0;
  long code = strtol(status, nullptr, 10);
  if (code != 200 && code != 302 && code != 401 && code != 404) return false;
  if (NS_FAILED(response->SetResponseStatus(code)) ||
      NS_FAILED(response->SetResponseStatusText(code == 302 ? "Found"_ns : "OK"_ns)) ||
      NS_FAILED(response->SetResponseBody(nsDependentCString(body)))) return false;
  if (*location && NS_FAILED(response->SetResponseHeader(
      "Location"_ns, nsDependentCString(location), false))) return false;
  if (*cookie && NS_FAILED(response->SetResponseHeader(
      "Set-Cookie"_ns, nsDependentCString(cookie), false))) return false;
  if (*contentType && NS_FAILED(response->SetResponseHeader(
      "Content-Type"_ns, nsDependentCString(contentType), false))) return false;
  return true;
}
