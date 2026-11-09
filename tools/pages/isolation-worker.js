/* OUTPOST_PREFETCH_CONFIG */
let prefetchPromise;
async function readPrefetched(name) {
  if (typeof prefetchConfig === 'undefined' || !prefetchConfig.index[name]) return null;
  prefetchPromise ??= (async () => {
    const response = await fetch(new URL('linux-prefetch.gz', self.registration.scope), { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Linux prefetch download failed');
    const packed = await response.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', packed);
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== prefetchConfig.packHash) throw Error('Linux prefetch integrity check failed');
    return new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  })();
  try {
    const data = await prefetchPromise;
    const [offset, length] = prefetchConfig.index[name];
    if (offset + length > data.byteLength) throw Error('Invalid Linux prefetch index');
    return new Response(data.slice(offset, offset + length), { headers: { 'Content-Type': 'application/octet-stream' } });
  } catch (error) {
    console.warn(error);
    prefetchPromise = undefined;
    return null;
  }
}
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (new URL(event.request.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const url = new URL(event.request.url);
    const isBlob = event.request.method === 'GET' && !event.request.headers.has('Range') &&
      url.pathname.startsWith(new URL('vnc32/rootfs/', self.registration.scope).pathname);
    const response = (isBlob && await readPrefetched(url.pathname.split('/').at(-1))) || await fetch(event.request);
    if (response.type === 'opaque' || response.type === 'opaqueredirect') return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  })());
});
