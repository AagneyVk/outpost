// Gecko nsresult values observed for certificate verification failures in the
// bundled engine: unknown issuer, expired, self-signed, and hostname mismatch.
const certificateFailures = new Set(['0x805a1ff3', '0x805a1ff5', '0x805a3ff2', '0x805a2ff4']);

export function isCertificateError(status) {
  return typeof status === 'string' && certificateFailures.has(status.toLowerCase());
}
