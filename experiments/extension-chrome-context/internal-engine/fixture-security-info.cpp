// TEST ONLY: per-channel state experiment for one fixed origin.
// This fixture has no production-grade trusted transport. Never ship it.
static already_AddRefed<nsITransportSecurityInfo> OutpostTestSecurityInfo(
    const nsACString& evidence) {
  if (evidence.Length() > 32768) return nullptr;
  nsCCharSeparatedTokenizer tokens(evidence, ':');
  if (!tokens.hasMoreTokens() || !tokens.nextToken().EqualsLiteral("v3") || !tokens.hasMoreTokens()) return nullptr;
  const nsDependentCSubstring version = tokens.nextToken();
  uint16_t protocol;
  if (version.EqualsLiteral("TLSv1.3")) protocol = nsITransportSecurityInfo::TLS_VERSION_1_3;
  else if (version.EqualsLiteral("TLSv1.2")) protocol = nsITransportSecurityInfo::TLS_VERSION_1_2;
  else return nullptr;
  if (tokens.hasMoreTokens()) return nullptr;
  nsTArray<RefPtr<nsIX509Cert>> chain;
  nsCOMPtr<nsIX509Cert> server;
  // SECURITY EXPERIMENT: this object deliberately has no certificate. The
  // property bag alone cannot enforce a trustworthy extension boundary.
  nsTArray<RefPtr<nsIX509Cert>> handshake;
  RefPtr<psm::TransportSecurityInfo> info = new psm::TransportSecurityInfo(
      nsIWebProgressListener::STATE_IS_SECURE, 0, std::move(handshake), server,
      std::move(chain), Nothing(), Nothing(), Nothing(), Some(protocol),
      nsITransportSecurityInfo::CERTIFICATE_TRANSPARENCY_NOT_APPLICABLE,
      Nothing(), Nothing(), Nothing(), false, false, Nothing(), false,
      EmptyCString(), false, false, EmptyCString());
  return info.forget();
}
