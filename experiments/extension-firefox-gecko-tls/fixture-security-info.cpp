// TEST ONLY. Accepts host-provided TLS metadata for one fixed test origin.
// Never use this untrusted header or this constructed object in a product.
static already_AddRefed<nsITransportSecurityInfo> OutpostTestSecurityInfo(
    const nsACString& header) {
  if (header.Length() > 32768) return nullptr;
  nsCCharSeparatedTokenizer tokens(header, ':');
  if (!tokens.hasMoreTokens() || !tokens.nextToken().EqualsLiteral("v1") || !tokens.hasMoreTokens()) return nullptr;
  const nsDependentCSubstring version = tokens.nextToken();
  uint16_t protocol;
  if (version.EqualsLiteral("TLSv1.3")) protocol = nsITransportSecurityInfo::TLS_VERSION_1_3;
  else if (version.EqualsLiteral("TLSv1.2")) protocol = nsITransportSecurityInfo::TLS_VERSION_1_2;
  else return nullptr;
  nsCOMPtr<nsIX509CertDB> database = do_GetService(NS_X509CERTDB_CONTRACTID);
  if (!database) return nullptr;
  nsTArray<RefPtr<nsIX509Cert>> chain;
  while (tokens.hasMoreTokens()) {
    if (chain.Length() >= 10) return nullptr;
    nsCOMPtr<nsIX509Cert> cert;
    if (NS_FAILED(database->ConstructX509FromBase64(tokens.nextToken(), getter_AddRefs(cert))) || !cert) return nullptr;
    chain.AppendElement(cert);
  }
  if (chain.IsEmpty()) return nullptr;
  nsCOMPtr<nsIX509Cert> server = chain[0].get();
  // Check the DNS name independently even in this deliberately unsafe fixture.
  nsTArray<uint8_t> serverDER;
  if (NS_FAILED(server->GetRawDER(serverDER))) return nullptr;
  mozilla::pkix::Input certInput, hostInput;
  constexpr auto host = "example.com"_ns;
  if (certInput.Init(serverDER.Elements(), serverDER.Length()) != mozilla::pkix::Success ||
      hostInput.Init(reinterpret_cast<const uint8_t*>(host.BeginReading()), host.Length()) != mozilla::pkix::Success ||
      mozilla::pkix::CheckCertHostname(certInput, hostInput) != mozilla::pkix::Success) return nullptr;
  // Host reports a verified chain; the original handshake list and several
  // connection properties are unavailable and deliberately left unspecified.
  nsTArray<RefPtr<nsIX509Cert>> handshake;
  RefPtr<psm::TransportSecurityInfo> info = new psm::TransportSecurityInfo(
      nsIWebProgressListener::STATE_IS_SECURE, 0, std::move(handshake), server,
      std::move(chain), Nothing(), Nothing(), Nothing(), Some(protocol),
      nsITransportSecurityInfo::CERTIFICATE_TRANSPARENCY_NOT_APPLICABLE,
      Nothing(), Nothing(), Nothing(), false, false, Nothing(), false,
      EmptyCString(), false, false, EmptyCString());
  return info.forget();
}
