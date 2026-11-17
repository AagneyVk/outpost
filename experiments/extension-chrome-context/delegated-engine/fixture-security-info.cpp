// TEST ONLY: delegated-trust experiment for one origin in an extension page.
// This trusts an unauthenticated header. Never use this engine in a product.
static already_AddRefed<nsITransportSecurityInfo> OutpostTestSecurityInfo(
    const nsACString& header) {
  if (header.Length() > 32768) return nullptr;
  nsCCharSeparatedTokenizer tokens(header, ':');
  if (!tokens.hasMoreTokens() || !tokens.nextToken().EqualsLiteral("v2") || !tokens.hasMoreTokens()) return nullptr;
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
  // SECURITY EXPERIMENT: relies entirely on the trusted extension test code
  // having matched Chrome's verified request to this certificate and body.
  // This hard-coded header does not enforce that boundary; it is test-only.
  nsTArray<RefPtr<nsIX509Cert>> handshake;
  RefPtr<psm::TransportSecurityInfo> info = new psm::TransportSecurityInfo(
      nsIWebProgressListener::STATE_IS_SECURE, 0, std::move(handshake), server,
      std::move(chain), Nothing(), Nothing(), Nothing(), Some(protocol),
      nsITransportSecurityInfo::CERTIFICATE_TRANSPARENCY_NOT_APPLICABLE,
      Nothing(), Nothing(), Nothing(), false, false, Nothing(), false,
      EmptyCString(), false, false, EmptyCString());
  return info.forget();
}
