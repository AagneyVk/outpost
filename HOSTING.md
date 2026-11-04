# Host the OUTPOST preview

Extract the deployment archive on a server with Node 24+ and Caddy 2.8+. It includes the generated Firefox runtime. Run `npm ci --omit=dev` in the extracted directory. Keep the runtime fingerprint and its matching assets for existing workspace exports.

Point a hostname at the server and allow inbound TCP 80 and 443. Configure these environment variables in the service manager.

| Process | Variable | Value |
| --- | --- | --- |
| Node | OUTPOST_ORIGIN | Full HTTPS origin, with no trailing slash |
| Caddy | OUTPOST_HOST | Bare hostname matching the HTTPS origin |
| Caddy | OUTPOST_ACCESS_HASH | Output from the interactive `caddy hash-password` command |

Start Node with `npm start` on its default loopback port 3001. Start Caddy on the same server with `caddy run --config Caddyfile`. Caddy serves HTTPS and proxies WebSockets. Visitors use the username `visitor` and the shared preview password. Keep that password separate from OUTPOST archive passphrases. See [Caddy authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth) and [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Keep port 3001 private. The relay sees Caddy as a single client, so its existing four-connection limit is shared across the preview. The operator should set an egress budget, rotate the shared password if it leaks, and review the third-party distribution requirements before sharing the runtime. See [networking](NETWORKING.md) and [third-party notices](THIRD_PARTY.md).

Before distributing the URL, confirm that an unauthenticated request receives 401. Open the authenticated preview in a fresh browser, start Linux and Firefox, navigate to a website, and verify encrypted export. The local smoke test passed the HTTPS auth challenge, authenticated page load and browser WebSocket handshake using a temporary certificate. A public certificate and domain still need verification on the deployment server.

## Gecko Lab delivery rehearsal

### Cloudflare-only hosting

The standalone preview archive includes a Worker and Cloudflare Container configuration. The Worker forwards HTTP and WebSocket requests to the Node relay in a private container. The container serves the engine binary and opens outbound TCP connections. Cloudflare Workers alone disallow raw TCP connections to Cloudflare IP addresses.

On a machine with Node 24+ and Docker, extract the archive into a clean directory. Set `OUTPOST_ORIGIN` in `wrangler.jsonc` to your actual Workers URL. Use a Cloudflare account with Containers enabled. Install `wrangler` and `@cloudflare/containers` with `npm install --no-save wrangler @cloudflare/containers`, then run `npx wrangler login` and `npx wrangler deploy`. Review the account's Container pricing before deploying.

After provisioning, run the live HTTPS check and the portable-profile check against the new URL before stopping the Codespace. Visitors need no Cloudflare account.

For the account-free browser preview, use `Caddyfile.public` and set `OUTPOST_PUBLIC_PREVIEW=1` on the Node process along with `OUTPOST_ORIGIN=https://YOUR_HOST`. Start Caddy with `caddy run --config Caddyfile.public --adapter caddyfile`. Keep Node on loopback and use Caddy as the direct public ingress so it can overwrite the client IP header. The relay permits only public web destinations in this mode, caps concurrent connections, and closes each WebSocket after 128 MiB of downloads. Set an egress budget at the host before sharing the link. Run the HTTPS check without preview credentials. Encrypted login restoration still requires a separate acceptance test.

The existing deployment archive predates Gecko Lab. Use the current checkout and stage the pinned engine artifacts as described in [Gecko Lab setup](tools/gecko-wasm/README.md). Serve `/gecko-lab/index.html` through the same Caddy instance.

On the test machine, install the development dependencies and provide `OUTPOST_PREVIEW_USER` and `OUTPOST_PREVIEW_PASSWORD` in the environment. Run:

```sh
node tools/gecko-wasm/verify-https.mjs https://YOUR_HOST/gecko-lab/index.html https://example.com/
```

Require a pass before delivery. A loopback rehearsal confirmed the unauthenticated 401 and public HTTP navigation through Caddy's authenticated HTTPS frontend and WSS relay. It used a temporary frontend certificate. Gecko kept its normal destination certificate checks and rejected this PC's intercepted outbound HTTPS connection.
