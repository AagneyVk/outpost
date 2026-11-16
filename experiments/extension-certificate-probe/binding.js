// Validates evidence from Chrome's network events for the isolated probe.
// Certificate-chain lookup remains origin-scoped and is not included.
globalThis.validateResponseBinding = function ({ url, status, body, requests, responses, failures, capturedBody }) {
  const matches = [...responses].filter(([id, response]) =>
    requests.get(id) === url && response.url === url);
  if (matches.length !== 1) throw Error('Expected exactly one matching network response');
  const [[requestId, response]] = matches;
  if (failures.has(requestId) || response.status !== status ||
      response.securityState !== 'secure' || !response.securityDetails ||
      response.fromDiskCache || response.fromServiceWorker)
    throw Error('The network response lacked verified connection metadata');
  if (capturedBody !== body) throw Error('Response body did not match the request with connection metadata');
  return { requestId, security: response.securityDetails };
};
