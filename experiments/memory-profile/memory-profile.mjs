// Research-only Gecko FsProvider. Nothing here makes the host device trusted.
// Data remains in JS memory and is lost if the tab closes or crashes.
export class MemoryProfile {
  #entries = new Map([['', { isDir: true }]]);
  #size = 0;
  #maxBytes;
  #maxEntries;
  constructor({ maxBytes = 64 * 1024 * 1024, maxEntries = 4096 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) throw Error('Invalid memory profile limits.');
    this.#maxBytes = maxBytes;
    this.#maxEntries = maxEntries;
  }
  #path(path) {
    if (typeof path !== 'string' || path.includes('\0')) throw Error('Invalid path.');
    const parts = path.split('/').filter(Boolean);
    if (parts.some(part => part === '.' || part === '..')) throw Error('Invalid path.');
    return parts.join('/');
  }
  #parent(path) { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }
  #directory(path) {
    const entry = this.#entries.get(path);
    if (!entry?.isDir) throw Error('Directory not found.');
  }
  async stat(path) {
    const entry = this.#entries.get(this.#path(path));
    return entry ? { isDir: entry.isDir, size: entry.isDir ? 0 : entry.data.length } : null;
  }
  async readdir(path) {
    path = this.#path(path); this.#directory(path);
    const prefix = path ? path + '/' : '';
    return [...this.#entries.keys()].filter(key => key.startsWith(prefix) && key !== path)
      .map(key => key.slice(prefix.length)).filter(rest => !rest.includes('/')).sort();
  }
  async mkdir(path) {
    path = this.#path(path);
    const old = this.#entries.get(path);
    if (old?.isDir) return;
    if (old) throw Error('File already exists.');
    this.#directory(this.#parent(path));
    if (this.#entries.size >= this.#maxEntries) throw Error('Memory profile entry limit exceeded.');
    this.#entries.set(path, { isDir: true });
  }
  async readFile(path) {
    const entry = this.#entries.get(this.#path(path));
    if (!entry || entry.isDir) throw Error('File not found.');
    return entry.data.slice();
  }
  async writeFile(path, data) {
    path = this.#path(path);
    if (!(data instanceof Uint8Array) || !path) throw Error('Invalid file data.');
    this.#directory(this.#parent(path));
    const old = this.#entries.get(path);
    if (old?.isDir) throw Error('Path is a directory.');
    if (!old && this.#entries.size >= this.#maxEntries) throw Error('Memory profile entry limit exceeded.');
    const size = this.#size - (old?.data.length ?? 0) + data.length;
    if (size > this.#maxBytes) throw Error('Memory profile size limit exceeded.');
    const replacement = data.slice();
    old?.data.fill(0);
    this.#entries.set(path, { isDir: false, data: replacement });
    this.#size = size;
  }
  async unlink(path) {
    path = this.#path(path);
    const entry = this.#entries.get(path);
    if (!path || !entry) throw Error('Entry not found.');
    if (entry.isDir && [...this.#entries.keys()].some(key => key.startsWith(path + '/'))) throw Error('Directory is not empty.');
    if (!entry.isDir) { this.#size -= entry.data.length; entry.data.fill(0); }
    this.#entries.delete(path);
  }
  async rename(from, to) {
    from = this.#path(from); to = this.#path(to);
    const entry = this.#entries.get(from);
    if (!from || !to || !entry || to.startsWith(from + '/')) throw Error('Invalid rename.');
    if (from === to) return;
    this.#directory(this.#parent(to));
    const old = this.#entries.get(to);
    if (old && (old.isDir !== entry.isDir || (old.isDir && [...this.#entries.keys()].some(key => key.startsWith(to + '/'))))) throw Error('Destination cannot be replaced.');
    const moved = [...this.#entries].filter(([key]) => key === from || key.startsWith(from + '/'));
    if (old && !old.isDir) { this.#size -= old.data.length; old.data.fill(0); }
    this.#entries.delete(to);
    for (const [key] of moved) this.#entries.delete(key);
    for (const [key, value] of moved) this.#entries.set(to + key.slice(from.length), value);
  }
  snapshot() {
    return [...this.#entries].filter(([path]) => path).map(([path, entry]) => ({
      path, isDir: entry.isDir, ...(entry.isDir ? {} : { data: entry.data.slice() })
    }));
  }
  destroy() {
    for (const entry of this.#entries.values()) if (!entry.isDir) entry.data.fill(0);
    this.#entries.clear(); this.#size = 0;
  }
}
