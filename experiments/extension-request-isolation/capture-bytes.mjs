// Research fixture helper: preserve CDP binary chunks without text decoding.
export function combineBase64Capture(parts, maxBytes) {
  if (!Array.isArray(parts) || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw Error('Invalid capture limit');
  let length = 0;
  for (const value of parts) {
    if (typeof value !== 'string' || value.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
      throw Error('Malformed binary capture');
    length += value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
    if (length > maxBytes) throw Error('Binary capture exceeds limit');
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of parts) {
    const decoded = atob(value);
    for (let i = 0; i < decoded.length; i++) result[offset++] = decoded.charCodeAt(i);
  }
  return result;
}
