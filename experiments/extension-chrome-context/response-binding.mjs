// Narrow feasibility check for one anonymous fixed-URL test request. The
// origin-keyed certificate lookup is deliberately not part of this evidence.
export function validateResponseBinding({ url, status, finalURL, body, capturedBody,
  requests, responses, failures, redirects }) {
  if (finalURL !== url) throw Error('Unexpected final URL');
  const matches = [...responses].filter(([id, response]) =>
    requests.get(id) === url && response.url === url);
  if (matches.length !== 1) throw Error('No unique request-bound response');
  const [[requestId, response]] = matches;
  if (failures.has(requestId) || redirects.has(requestId) || response.status !== status ||
      response.securityState !== 'secure' || !response.securityDetails ||
      response.fromDiskCache || response.fromServiceWorker || response.fromPrefetchCache)
    throw Error('The response lacked direct verified connection metadata');
  if (!(body instanceof Uint8Array) || !(capturedBody instanceof Uint8Array) ||
      body.length !== capturedBody.length || body.some((byte, index) => byte !== capturedBody[index]))
    throw Error('Response body did not match the network request');
  return { requestId, security: response.securityDetails };
}
