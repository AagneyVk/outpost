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
  // Independently validate the host, time, purpose, and chain against Gecko's
  // own trust store. The host-provided intermediates are not trust anchors.
  nsTArray<uint8_t> serverDER;
  if (NS_FAILED(server->GetRawDER(serverDER))) return nullptr;
  nsTArray<nsTArray<uint8_t>> extraCertificates;
  for (size_t i = 1; i < chain.Length(); ++i) {
    nsTArray<uint8_t> der;
    if (NS_FAILED(chain[i]->GetRawDER(der))) return nullptr;
    extraCertificates.AppendElement(std::move(der));
  }
  RefPtr<psm::SharedCertVerifier> verifier = psm::GetDefaultCertVerifier();
  if (!verifier) return nullptr;
  nsTArray<nsTArray<uint8_t>> verifiedDER;
  auto result = verifier->VerifySSLServerCert(
      serverDER, mozilla::pkix::Now(), nullptr, "example.com"_ns, verifiedDER,
      psm::CertVerifier::FLAG_LOCAL_ONLY, Some(std::move(extraCertificates)));
  if (result != mozilla::pkix::Success || verifiedDER.IsEmpty()) return nullptr;
  chain.Clear();
  for (const auto& der : verifiedDER) {
    nsCOMPtr<nsIX509Cert> cert;
    nsAutoCString encoded;
    if (NS_FAILED(mozilla::Base64Encode(reinterpret_cast<const char*>(der.Elements()), der.Length(), encoded)) ||
        NS_FAILED(database->ConstructX509FromBase64(encoded, getter_AddRefs(cert))) || !cert) return nullptr;
    chain.AppendElement(cert);
  }
  server = chain[0].get();
  // TEST ONLY: this is not proof that the content was delivered by this TLS
  // connection; the original handshake and other properties are unavailable.
  nsTArray<RefPtr<nsIX509Cert>> handshake;
  RefPtr<psm::TransportSecurityInfo> info = new psm::TransportSecurityInfo(
      nsIWebProgressListener::STATE_IS_SECURE, 0, std::move(handshake), server,
      std::move(chain), Nothing(), Nothing(), Nothing(), Some(protocol),
      nsITransportSecurityInfo::CERTIFICATE_TRANSPARENCY_NOT_APPLICABLE,
      Nothing(), Nothing(), Nothing(), false, false, Nothing(), false,
      EmptyCString(), false, false, EmptyCString());
  return info.forget();
}
