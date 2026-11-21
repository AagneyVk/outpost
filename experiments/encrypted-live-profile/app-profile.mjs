// Research-only replacement for the tab/history portion of profile.mjs. These
// files live in the encrypted provider rather than the normal OPFS profile.
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const historyLimit = 64 * 1024 * 1024, sessionLimit = 1024 * 1024;
const sessionName = 'outpost-session.json', historyName = 'outpost-history.ndjson';
const cookieName = 'outpost-session-cookies.dat';

export function encryptedAppProfile(getProfile) {
  function profile() {
    const value = getProfile();
    if (!value) throw Error('Encrypted profile is not open.');
    return value;
  }
  return {
    async readBrowserSession() {
      const fs = profile(), stat = await fs.stat(sessionName);
      if (!stat) return;
      if (stat.isDir || stat.size > sessionLimit) throw Error('Invalid encrypted session size.');
      const bytes = await fs.readFile(sessionName);
      try { return JSON.parse(decoder.decode(bytes)); }
      catch (error) { if (error instanceof SyntaxError || error instanceof TypeError) return; throw error; }
      finally { bytes.fill(0); }
    },
    async writeBrowserSession(session) {
      const bytes = encoder.encode(JSON.stringify(session));
      if (bytes.length > sessionLimit) throw Error('Encrypted session is too large.');
      try { await profile().writeFile(sessionName, bytes); } finally { bytes.fill(0); }
    },
    async readBrowserHistory() {
      const fs = profile(), stat = await fs.stat(historyName);
      if (!stat) return [];
      if (stat.isDir || stat.size > historyLimit) throw Error('Invalid encrypted history size.');
      const bytes = await fs.readFile(historyName);
      try { return decoder.decode(bytes).split('\n').filter(Boolean); } finally { bytes.fill(0); }
    },
    async writeBrowserHistory(url) {
      const fs = profile();
      const stat = url ? await fs.stat(historyName) : null;
      if (stat?.isDir || (stat?.size ?? 0) > historyLimit) throw Error('Invalid encrypted history size.');
      const old = stat ? await fs.readFile(historyName) : new Uint8Array();
      const record = encoder.encode(url ? url.href + '\n' : '');
      if (old.length + record.length > historyLimit) { old.fill(0); record.fill(0); throw Error('Encrypted history is full.'); }
      const combined = new Uint8Array(old.length + record.length); combined.set(old); combined.set(record, old.length);
      try { await fs.writeFile(historyName, combined); }
      finally { old.fill(0); record.fill(0); combined.fill(0); }
    },
    async hasSessionCookieSnapshot() { return Boolean(await profile().stat(cookieName)); },
    async clearSessionCookieSnapshot() {
      const fs = profile(); if (await fs.stat(cookieName)) await fs.unlink(cookieName);
    }
  };
}
