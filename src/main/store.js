'use strict';
// JsonStore: a small JSON file with dotted-key access, loaded once at startup
// and written atomically (tmp + rename) a moment after the last change.

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

function setPath(obj, keys, value) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] == null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

class JsonStore extends EventEmitter {
  constructor(file, defaults = {}, { delay = 200 } = {}) {
    super();
    this.file = file;
    this.defaults = defaults;
    this.delay = delay;
    this.data = {};
    this._timer = null;
    this._writing = null;
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
    this.emit('change', key, value);
    this._schedule();
  }

  /** Replace the whole document (used by simple stores such as session.json). */
  replace(data) {
    this.data = data;
    this._schedule();
  }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this._write(); }, this.delay);
  }

  async _write() {
    const body = JSON.stringify(this.data, null, 1);
    const tmp = `${this.file}.tmp`;
    const run = async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.writeFile(tmp, body);
      await fs.promises.rename(tmp, this.file);
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

  /** Synchronous last-chance write, for quitting. */
  flushSync() {
    if (!this._timer) return;
    clearTimeout(this._timer);
    this._timer = null;
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); // sync-ok: at quit
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1)); // sync-ok: at quit
    fs.renameSync(tmp, this.file); // sync-ok: at quit
  }
}

function clone(v) {
  return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
}

module.exports = { JsonStore };
