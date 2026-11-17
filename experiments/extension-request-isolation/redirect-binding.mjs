// Narrow test of one intercepted redirect, not a general redirect policy.
export function validateRedirectBinding({ initialURL, requestId, redirects, extra, blockResults }) {
  const source = new URL(initialURL);
  if (source.protocol !== 'https:' || source.username || source.password) throw Error('Verified HTTPS URL required');
  if (!requestId || redirects.length !== 1 || blockResults.length !== 1) throw Error('Ambiguous redirect evidence');
  const redirect = redirects[0], blocked = blockResults[0];
  if (redirect.id !== requestId || redirect.from !== initialURL ||
      ![301, 302, 303, 307, 308].includes(redirect.status) ||
      redirect.securityState !== 'secure' || !['TLS 1.2', 'TLS 1.3'].includes(redirect.protocol) ||
      redirect.fromDiskCache || redirect.fromServiceWorker || redirect.fromPrefetchCache)
    throw Error('Redirect lacked request-bound verified security state');
  if (!extra || extra.status !== redirect.status || !extra.location || /[\r\n]/.test(extra.location))
    throw Error('Redirect headers do not match');
  const destination = new URL(extra.location, initialURL);
  if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password ||
      destination.href !== redirect.to || blocked.networkId !== requestId || blocked.ok !== true || blocked.url !== redirect.to)
    throw Error('Redirect destination was not safely blocked');
  return { from: redirect.from, to: redirect.to, status: redirect.status, protocol: redirect.protocol };
}
