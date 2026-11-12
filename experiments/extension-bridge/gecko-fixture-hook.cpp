// TEST ONLY: inserted into a disposable Gecko build; never ship this hook.
// Only two reserved .test hostnames are handled and all data is synthetic.
#include "nsIHttpChannel.h"
#include "nsIHttpChannelInternal.h"
#include "nsIReplacedHttpResponse.h"
#include "nsITransportSecurityInfo.h"
#include "nsPrintfCString.h"
#include <stdio.h>

static uint32_t gFixturePreflights = 0;
static uint32_t gFixtureCorsPosts = 0;
static nsCString gFixtureRequestOrder;
static nsCOMPtr<nsIChannel> gFixtureHttpsChannel;

class OutpostFixtureObserver final : public nsIObserver {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIOBSERVER
 private:
  ~OutpostFixtureObserver() = default;
};
NS_IMPL_ISUPPORTS(OutpostFixtureObserver, nsIObserver)

NS_IMETHODIMP OutpostFixtureObserver::Observe(nsISupports* subject,
                                               const char* topic,
                                               const char16_t*) {
  if (strcmp(topic, "http-on-before-connect") != 0) return NS_OK;
  nsCOMPtr<nsIHttpChannel> channel = do_QueryInterface(subject);
  nsCOMPtr<nsIHttpChannelInternal> internal = do_QueryInterface(subject);
  if (!channel || !internal) return NS_OK;
  nsCOMPtr<nsIURI> uri;
  channel->GetURI(getter_AddRefs(uri));
  if (!uri) return NS_OK;
  nsAutoCString spec;
  uri->GetSpec(spec);
  if (spec.EqualsLiteral("https://example.com/")) gFixtureHttpsChannel = channel;
  nsAutoCString method;
  channel->GetRequestMethod(method);
  if (!StringBeginsWith(spec, "http://fixture.test/"_ns) &&
      !StringBeginsWith(spec, "http://foreign.test/"_ns)) return NS_OK;

  nsCOMPtr<nsIReplacedHttpResponse> response =
      do_CreateInstance("@mozilla.org/network/replaced-http-response;1");
  if (!response) return NS_ERROR_FAILURE;
  response->SetResponseStatus(200);
  response->SetResponseStatusText("OK"_ns);
  response->SetResponseHeader("Content-Type"_ns, "text/html; charset=utf-8"_ns, false);

  if (spec.EqualsLiteral("http://fixture.test/index")) {
    response->SetResponseBody(
        "<!doctype html><title>WAIT</title><script>"
        "async function test(path){try{let r=await fetch('http://foreign.test/'+path,"
        "{method:'POST',headers:{'X-OUTPOST-TEST':'1'},body:'test'});return 'OK:'+await r.text()}"
        "catch(e){return 'ERROR:'+e.name}}"
        "(async()=>document.title=await test('cors-denied')+'|'+await test('cors-allowed'))()"
        "</script>"_ns);
  } else if (spec.EqualsLiteral("http://foreign.test/cors-denied") ||
             spec.EqualsLiteral("http://foreign.test/cors-allowed")) {
    if (method.EqualsLiteral("OPTIONS")) {
      ++gFixturePreflights;
      gFixtureRequestOrder.Append('O');
    }
    if (method.EqualsLiteral("POST")) {
      ++gFixtureCorsPosts;
      gFixtureRequestOrder.Append('P');
    }
    response->SetResponseHeader("Access-Control-Allow-Origin"_ns,
                                "http://fixture.test"_ns, false);
    response->SetResponseHeader("Access-Control-Allow-Methods"_ns, "POST"_ns, false);
    // Only the second endpoint allows this custom request header.
    if (spec.EqualsLiteral("http://foreign.test/cors-allowed")) {
      response->SetResponseHeader("Access-Control-Allow-Headers"_ns,
                                  "x-outpost-test"_ns, false);
    }
    response->SetResponseBody("fixture-cors"_ns);
  } else if (spec.EqualsLiteral("http://fixture.test/login")) {
    response->SetResponseStatus(302);
    response->SetResponseStatusText("Found"_ns);
    response->SetResponseHeader("Location"_ns, "/home"_ns, false);
    response->SetResponseHeader("Set-Cookie"_ns, "fixture_session=synthetic; Path=/"_ns, false);
  } else if (spec.EqualsLiteral("http://fixture.test/home")) {
    nsAutoCString cookie;
    channel->GetRequestHeader("Cookie"_ns, cookie);
    nsAutoCString body("<!doctype html><title>HOME</title><p id='cookie'>");
    body.Append(cookie);
    body.AppendLiteral("</p>");
    response->SetResponseBody(body);
  } else {
    response->SetResponseStatus(404);
    response->SetResponseStatusText("Not Found"_ns);
    response->SetResponseBody("fixture not found"_ns);
  }
  return internal->SetResponseOverride(response);
}

static bool InstallOutpostFixture() {
  nsCOMPtr<nsIObserverService> observers =
      do_GetService("@mozilla.org/observer-service;1");
  if (!observers) return false;
  RefPtr<OutpostFixtureObserver> observer = new OutpostFixtureObserver();
  return NS_SUCCEEDED(observers->AddObserver(observer, "http-on-before-connect", false));
}
