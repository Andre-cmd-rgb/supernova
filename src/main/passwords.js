'use strict';
// Password vault (agent A). Pure Node: safeStorage is injected.
//
// The whole vault is one JSON blob encrypted with safeStorage.encryptString
// (file: dir/passwords.vault). Nothing here ever logs a password; error
// messages never contain entry data.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_PASSWORD = 4096;
const MAX_USERNAME = 1024;

class VaultError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

// 'https://Example.com:443/login?x' -> 'https://example.com'; null if not http(s).
function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname) return null;
  return u.origin;
}

async function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  const fh = await fsp.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

function createVault({ dir, safeStorage } = {}) {
  if (!dir) throw new Error('createVault: dir is required');
  if (!safeStorage) throw new Error('createVault: safeStorage is required');
  const file = path.join(dir, 'passwords.vault');

  let entries = []; // [{ id, origin, username, password, created, updated }]
  // Set when a vault file exists but could not be decrypted/parsed: we must
  // never overwrite it (that would destroy the user's passwords).
  let lockedReason = null;
  let dirty = false;
  let scheduled = false;
  let chain = Promise.resolve();
  // Electron 45 deprecates the synchronous isEncryptionAvailable(); load()
  // asks the asynchronous one and remembers the answer.
  let encKnown = null;

  function encryptionAvailable() {
    if (encKnown !== null) return encKnown;
    if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') return false; // known after load()
    try { return !!safeStorage.isEncryptionAvailable(); } catch { return false; }
  }

  function backend() {
    try {
      return typeof safeStorage.getSelectedStorageBackend === 'function'
        ? safeStorage.getSelectedStorageBackend()
        : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  function available() {
    const b = backend();
    if (!encryptionAvailable()) return { ok: false, backend: b, reason: 'Encryption is not available (no keyring).' };
    if (b === 'basic_text') {
      return { ok: false, backend: b, reason: 'No secure keyring found (GNOME Keyring or KWallet); passwords would be stored with a hard-coded key.' };
    }
    if (lockedReason) return { ok: false, backend: b, reason: lockedReason };
    return { ok: true, backend: b };
  }

  function assertWritable() {
    const a = available();
    if (!a.ok) throw new VaultError('Passwords cannot be saved: ' + a.reason, 'SN_VAULT_UNAVAILABLE');
  }

  function scheduleSave() {
    dirty = true;
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; save(); });
  }

  function save() {
    if (!dirty) return chain;
    dirty = false;
    let blob;
    try {
      assertWritable();
      blob = safeStorage.encryptString(JSON.stringify({ v: 1, entries }));
    } catch (err) {
      dirty = true;
      console.error('[vault] not saved:', err.code || 'encrypt failed');
      return chain;
    }
    chain = chain.then(async () => {
      await fsp.mkdir(dir, { recursive: true });
      await writeAtomic(file, blob);
    }).catch((err) => {
      dirty = true;
      console.error('[vault] save failed:', err.code || 'write error');
    });
    return chain;
  }

  function findExact(origin, username) {
    return entries.find((e) => e.origin === origin && e.username === username);
  }

  function clean(input) {
    if (!input || typeof input !== 'object') return null;
    const origin = normalizeOrigin(input.origin || input.url);
    const password = input.password;
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    if (!origin || typeof password !== 'string' || !password) return null;
    if (password.length > MAX_PASSWORD || username.length > MAX_USERNAME) return null;
    const updated = Number.isFinite(input.updated) && input.updated > 0 ? input.updated : null;
    return { origin, username, password, updated };
  }

  // -> 'added' | 'updated' | 'unchanged' | 'older'
  function upsert(c, now) {
    const e = findExact(c.origin, c.username);
    if (!e) {
      const at = c.updated || now;
      entries.push({ id: crypto.randomUUID(), origin: c.origin, username: c.username, password: c.password, created: at, updated: at });
      return 'added';
    }
    if (e.password === c.password) return 'unchanged';
    if (c.updated && c.updated < e.updated) return 'older';
    e.password = c.password;
    e.updated = c.updated || now;
    return 'updated';
  }

  return {
    async load() {
      if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') {
        try { encKnown = !!(await safeStorage.isAsyncEncryptionAvailable()); } catch { encKnown = false; }
      }
      let buf;
      try {
        buf = await fsp.readFile(file);
      } catch (err) {
        if (err.code === 'ENOENT') { entries = []; lockedReason = null; return; }
        lockedReason = 'The password file could not be read.';
        return;
      }
      let json;
      try {
        json = safeStorage.decryptString(buf);
      } catch {
        lockedReason = 'The saved passwords could not be unlocked (keyring locked or changed).';
        entries = [];
        return;
      }
      try {
        const parsed = JSON.parse(json);
        const list = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
        entries = list.filter((e) => e && typeof e.id === 'string' && normalizeOrigin(e.origin) === e.origin && typeof e.password === 'string');
        lockedReason = null;
      } catch {
        lockedReason = 'The password file is damaged.';
        entries = [];
      }
    },

    available,

    count() { return entries.length; },

    list() {
      return entries
        .map((e) => ({ id: e.id, origin: e.origin, username: e.username, updated: e.updated }))
        .sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : a.username.localeCompare(b.username)));
    },

    // Exact origin first, then the http:// version of the same https:// host
    // (upgrade only, never downgrade, never other subdomains).
    find(origin) {
      const o = normalizeOrigin(origin);
      if (!o) return [];
      const exact = [];
      const upgraded = [];
      const httpTwin = o.startsWith('https://') ? 'http://' + o.slice(8) : null;
      for (const e of entries) {
        if (e.origin === o) exact.push(e);
        else if (httpTwin && e.origin === httpTwin) upgraded.push(e);
      }
      const byRecent = (a, b) => b.updated - a.updated;
      exact.sort(byRecent);
      upgraded.sort(byRecent);
      return exact.concat(upgraded).map((e) => ({ id: e.id, origin: e.origin, username: e.username, password: e.password }));
    },

    // Upsert by (origin, username). -> { id, status: 'added'|'updated'|'unchanged' }
    save(input) {
      assertWritable();
      const c = clean(input);
      if (!c) throw new VaultError('Invalid entry: an http(s) origin and a password are required.', 'SN_VAULT_INVALID');
      c.updated = null; // a live save always wins
      const status = upsert(c, Date.now());
      if (status !== 'unchanged') scheduleSave();
      return { id: findExact(c.origin, c.username).id, status };
    },

    remove(id) {
      const i = entries.findIndex((e) => e.id === id);
      if (i === -1) return false;
      assertWritable();
      entries.splice(i, 1);
      scheduleSave();
      return true;
    },

    // entries: [{ origin | url, username, password, updated? }]
    // An existing entry is only overwritten by a newer (or undated) import.
    importMany(list) {
      assertWritable();
      let added = 0, updated = 0, skipped = 0;
      const now = Date.now();
      for (const it of list || []) {
        const c = clean(it);
        if (!c) { skipped++; continue; }
        const r = upsert(c, now);
        if (r === 'added') added++;
        else if (r === 'updated') updated++;
        else skipped++;
      }
      if (added || updated) scheduleSave();
      return { added, updated, skipped };
    },

    async flush() {
      await save();
      await chain;
    },
  };
}

module.exports = { createVault, normalizeOrigin, VaultError };
