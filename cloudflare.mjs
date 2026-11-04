import { Container } from '@cloudflare/containers';

export class Outpost extends Container {
  defaultPort = 3001;
  sleepAfter = '10m';
  enableInternet = true;
  envVars = { OUTPOST_ORIGIN: this.env.OUTPOST_ORIGIN };
}

export default {
  fetch(request, env) {
    if (new URL(request.url).origin !== env.OUTPOST_ORIGIN) {
      return new Response('Unknown OUTPOST hostname', { status: 421 });
    }
    const headers = new Headers(request.headers);
    headers.delete('X-Outpost-Client-IP');
    const clientIp = headers.get('CF-Connecting-IP');
    if (clientIp) headers.set('X-Outpost-Client-IP', clientIp);
    return env.OUTPOST.getByName('preview').fetch(new Request(request, { headers }));
  },
};
