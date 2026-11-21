'use strict';
// JsonStore: a small JSON file with dotted-key access, loaded once at startup
// and written atomically (tmp + rename) a moment after the last change. The
// files are the user's own (settings, the open tabs): mode 0600.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

function getPath(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object' || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

// Every write gets its own temporary file, so a synchronous write at quit
// never shares one with an async write still in flight.
let tmpCount = 0;
const tmpFor = (file) => `${file}.tmp-${process.pid}-${++tmpCount}`;

class JsonStore extends EventEmitter {
  constructor(file, defaults = {}, { delay = 200 } = {}) {
    super();
    this.file = file;
    this.defaults = defaults;
    this.delay = delay;
    this.data = {};
    this._timer = null;
    this._writing = null;
    this._gen = 0; // bumped on every change
    this._savedGen = 0; // the newest change known to be on disk
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; // sync-ok: startup
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // A broken file is kept aside rather than silently lost.
        try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch {} // sync-ok: startup
      }
      this.data = {};
    }
  }

  get(key) {
    // Flat keys ('adblock.enabled') are stored as written; nested objects are
    // reachable too, so callers need not care which.
    if (Object.prototype.hasOwnProperty.call(this.data, key)) return this.data[key];
    const v = getPath(this.data, key.split('.'));
    if (v !== undefined) return v;
    if (Object.prototype.hasOwnProperty.call(this.defaults, key)) return clone(this.defaults[key]);
    return getPath(this.defaults, key.split('.'));
  }

  set(key, value) {
    // Keys are stored flat, exactly as written ('video.maxHeightOnBattery').
    const before = JSON.stringify(this.get(key));
    this.data[key] = value;
    if (JSON.stringify(value) === before) return;
    this._gen++;
    this.emit('change', key, value);
    this._schedule();
  }

  /** Replace the whole document (used by simple stores such as session.json). */
  replace(data) {
    this.data = data;
    this._gen++;
    this._schedule();
  }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._write().catch((err) => console.error(`supernova: could not save ${path.basename(this.file)}:`, err.message));
    }, this.delay);
  }

  async _write() {
    const gen = this._gen;
    const body = JSON.stringify(this.data, null, 1);
    const run = async () => {
      if (this._savedGen >= gen) return; // a later write already saved it
      const tmp = tmpFor(this.file);
      try {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        await fs.promises.writeFile(tmp, body, { mode: 0o600 });
        // flushSync (quitting) may have saved newer data meanwhile.
        if (this._savedGen >= gen) { await fs.promises.unlink(tmp); return; }
        await fs.promises.rename(tmp, this.file);
        this._savedGen = Math.max(this._savedGen, gen);
      } catch (err) {
        fs.promises.unlink(tmp).catch(() => {});
        throw err;
      }
    };
    this._writing = (this._writing || Promise.resolve()).then(run, run);
    return this._writing;
  }

  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
      await this._write();
    } else if (this._writing) {
      await this._writing;
    }
  }

  /** Synchronous last-chance write, for quitting: also when an async write
   *  is still on its way, since the process may end before it lands. */
  flushSync() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._savedGen >= this._gen) return;
    const tmp = tmpFor(this.file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); // sync-ok: at quit
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 }); // sync-ok: at quit
    fs.renameSync(tmp, this.file); // sync-ok: at quit
    this._savedGen = this._gen;
  }
}

function clone(v) {
  return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
}

module.exports = { JsonStore };
