// Narrow research helper for already-accepted cookies with one Max-Age.
// It does not determine cookie acceptance, identity, deletion, or jar membership.
const CHROME_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
function time(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid timestamp');
  return value;
}
function parse(header) {
  if (typeof header !== 'string' || !header.length || header.length > 4096 || /[\x00-\x1f\x7f]/.test(header)) throw Error('Invalid cookie header');
  const parts = header.split(';');
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/.test(parts[0].trim())) throw Error('Invalid cookie name');
  const matches = [];
  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i].trim(), equal = attr.indexOf('=');
    if ((equal < 0 ? attr : attr.slice(0, equal)).trim().toLowerCase() !== 'max-age') continue;
    const value = equal < 0 ? '' : attr.slice(equal + 1).trim();
    if (!/^-?\d{1,19}$/.test(value)) throw Error('Unsupported Max-Age');
    matches.push({ i, seconds: BigInt(value) });
  }
  if (matches.length !== 1) throw Error('Exactly one Max-Age is required');
  return { parts, ...matches[0] };
}

// Use the timestamp from before the original request, not a later response
// observation. That deliberately errs toward expiring a cookie early.
export function recordMaxAge(header, requestStartedAt) {
  const parsed = parse(header);
  const started = time(requestStartedAt);
  const seconds = parsed.seconds <= 0n ? 0 : Number(parsed.seconds > BigInt(CHROME_MAX_AGE_SECONDS) ? BigInt(CHROME_MAX_AGE_SECONDS) : parsed.seconds);
  if (!Number.isSafeInteger(started + seconds * 1000)) throw Error('Invalid expiry');
  return { header, requestStartedAt: started };
}

// Returns null when expired or less than one full second remains. Reject a
// clock earlier than the request; clock skew and general cookie semantics still
// require a production design before this helper can be relied on by users.
export function maxAgeForRestore(record, now) {
  if (!record || typeof record !== 'object') throw Error('Invalid cookie record');
  const { header, requestStartedAt } = recordMaxAge(record.header, record.requestStartedAt);
  now = time(now);
  if (now < requestStartedAt) throw Error('Clock moved backwards');
  const parsed = parse(header);
  const seconds = parsed.seconds <= 0n ? 0 : Number(parsed.seconds > BigInt(CHROME_MAX_AGE_SECONDS) ? BigInt(CHROME_MAX_AGE_SECONDS) : parsed.seconds);
  const remaining = Math.floor((requestStartedAt + seconds * 1000 - now) / 1000);
  if (remaining <= 0) return null;
  parsed.parts[parsed.i] = ' Max-Age=' + remaining;
  return parsed.parts.join(';');
}
