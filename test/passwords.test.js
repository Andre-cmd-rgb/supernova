'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createVault } = require('../src/main/passwords');

// Stand-in for electron.safeStorage: AES-256-GCM with a per-instance key.
function fakeSafeStorage({ available = true, backend = 'gnome_libsecret', key = crypto.randomBytes(32) } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(s) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(s, 'utf8'), c.final()]);
      return Buffer.concat([Buffer.from('v11'), iv, c.getAuthTag(), body]);
    },
    decryptString(buf) {
      const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(3, 15));
      d.setAuthTag(buf.subarray(15, 31));
      return Buffer.concat([d.update(buf.subarray(31)), d.final()]).toString('utf8');
    },
  };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sn-vault-'));
const SECRET = 'correct horse battery staple';

test('available() refuses basic_text and missing encryption', async () => {
  const ok = createVault({ dir: tmpDir(), safeStorage: fakeSafeStorage() });
  assert.deepEqual(ok.available(), { ok: true, backend: 'gnome_libsecret' });

  for (const ss of [fakeSafeStorage({ backend: 'basic_text' }), fakeSafeStorage({ available: false })]) {
    const v = createVault({ dir: tmpDir(), safeStorage: ss });
    await v.load();
    const a = v.available();
    assert.equal(a.ok, false);
    assert.equal(typeof a.reason, 'string');
    assert.throws(() => v.save({ origin: 'https://example.com', username: 'u', password: SECRET }), { code: 'SN_VAULT_UNAVAILABLE' });
    assert.throws(() => v.importMany([{ origin: 'https://example.com', username: 'u', password: SECRET }]), { code: 'SN_VAULT_UNAVAILABLE' });
    assert.equal(v.count(), 0);
  }
});

test('available() works when getSelectedStorageBackend is missing', () => {
  const ss = fakeSafeStorage();
  delete ss.getSelectedStorageBackend;
  const v = createVault({ dir: tmpDir(), safeStorage: ss });
  assert.equal(v.available().ok, true);
});

test('save upserts by (origin, username); list has no secrets', () => {
  const v = createVault({ dir: tmpDir(), safeStorage: fakeSafeStorage() });
  const a = v.save({ origin: 'https://Example.com:443/login?x=1', username: 'alice', password: 'one' });
  assert.equal(a.status, 'added');
  assert.equal(v.save({ origin: 'https://example.com', username: 'alice', password: 'one' }).status, 'unchanged');
  const b = v.save({ origin: 'https://example.com', username: 'alice', password: 'two' });
  assert.equal(b.status, 'updated');
  assert.equal(b.id, a.id);
  v.save({ origin: 'https://example.com', username: 'bob', password: 'three' });
  assert.equal(v.count(), 2);
  const list = v.list();
  assert.equal(list.length, 2);
  for (const e of list) {
    assert.deepEqual(Object.keys(e).sort(), ['id', 'origin', 'updated', 'username']);
    assert.equal(e.origin, 'https://example.com');
  }
  assert.throws(() => v.save({ origin: 'ftp://example.com', username: 'x', password: 'y' }), { code: 'SN_VAULT_INVALID' });
  assert.throws(() => v.save({ origin: 'https://example.com', username: 'x', password: '' }), { code: 'SN_VAULT_INVALID' });
});

test('find: exact origin, then http->https upgrade only', () => {
  const v = createVault({ dir: tmpDir(), safeStorage: fakeSafeStorage() });
  v.importMany([
    { origin: 'https://example.com', username: 'secure', password: 'p1' },
    { origin: 'http://example.com', username: 'plain', password: 'p2' },
    { origin: 'https://accounts.example.com', username: 'sub', password: 'p3' },
    { origin: 'https://example.com:8443', username: 'port', password: 'p4' },
  ]);
  assert.deepEqual(v.find('https://example.com/login').map((e) => e.username), ['secure', 'plain']);
  assert.deepEqual(v.find('http://example.com').map((e) => e.username), ['plain'], 'never downgrade');
  assert.deepEqual(v.find('https://accounts.example.com').map((e) => e.username), ['sub']);
  assert.deepEqual(v.find('https://other.example.com').map((e) => e.username), []);
  assert.deepEqual(v.find('https://example.com:8443').map((e) => e.username), ['port']);
  assert.deepEqual(v.find('null'), []);
  const [hit] = v.find('https://accounts.example.com');
  assert.deepEqual(Object.keys(hit).sort(), ['id', 'origin', 'password', 'username']);
  assert.ok(hit.password === 'p3');
});

test('importMany counts and keeps the newer password', () => {
  const v = createVault({ dir: tmpDir(), safeStorage: fakeSafeStorage() });
  v.save({ origin: 'https://a.example', username: 'u', password: 'live' });
  const r = v.importMany([
    { url: 'https://a.example/login', username: 'u', password: 'older', updated: 1000 }, // older than the live save
    { url: 'https://b.example/', username: 'u', password: 'b1', updated: 1000 },
    { url: 'https://b.example/', username: 'u', password: 'b2', updated: 2000 },       // same login, newer
    { url: 'android://hash@com.app/', username: 'u', password: 'x' },
    { url: 'https://c.example', username: 'u', password: '' },
    null,
  ]);
  assert.deepEqual(r, { added: 1, updated: 1, skipped: 4 });
  assert.ok(v.find('https://a.example')[0].password === 'live');
  assert.ok(v.find('https://b.example')[0].password === 'b2');
});

test('remove', () => {
  const v = createVault({ dir: tmpDir(), safeStorage: fakeSafeStorage() });
  const { id } = v.save({ origin: 'https://a.example', username: 'u', password: 'p' });
  assert.equal(v.remove('nope'), false);
  assert.equal(v.remove(id), true);
  assert.equal(v.count(), 0);
});

test('persists encrypted, atomically, and loads back', async () => {
  const dir = tmpDir();
  const ss = fakeSafeStorage();
  const v = createVault({ dir, safeStorage: ss });
  await v.load();
  v.save({ origin: 'https://example.com', username: 'alice@example.com', password: SECRET });
  await v.flush();
  assert.deepEqual(fs.readdirSync(dir), ['passwords.vault']);
  const raw = fs.readFileSync(path.join(dir, 'passwords.vault'));
  assert.equal(raw.includes(Buffer.from(SECRET)), false, 'vault file must not contain plaintext');
  assert.equal(raw.includes(Buffer.from('alice@example.com')), false, 'nor usernames');
  assert.equal(fs.statSync(path.join(dir, 'passwords.vault')).mode & 0o777, 0o600);
  const v2 = createVault({ dir, safeStorage: ss });
  await v2.load();
  assert.equal(v2.count(), 1);
  assert.ok(v2.find('https://example.com')[0].password === SECRET);
});

test('a vault that cannot be decrypted is never overwritten', async () => {
  const dir = tmpDir();
  const v = createVault({ dir, safeStorage: fakeSafeStorage() });
  v.save({ origin: 'https://example.com', username: 'u', password: SECRET });
  await v.flush();
  const before = fs.readFileSync(path.join(dir, 'passwords.vault'));

  const other = createVault({ dir, safeStorage: fakeSafeStorage() }); // different key
  await other.load();
  assert.equal(other.available().ok, false);
  assert.equal(other.count(), 0);
  assert.throws(() => other.save({ origin: 'https://x.example', username: 'u', password: 'p' }), { code: 'SN_VAULT_UNAVAILABLE' });
  await other.flush();
  assert.ok(fs.readFileSync(path.join(dir, 'passwords.vault')).equals(before));
});

test('error messages never contain secrets', () => {
  const v = createVault({ dir: tmpDir(), safeStorage: fakeSafeStorage({ backend: 'basic_text' }) });
  try {
    v.save({ origin: 'https://example.com', username: 'alice', password: SECRET });
    assert.fail('should throw');
  } catch (err) {
    assert.equal(String(err.message).includes(SECRET), false);
    assert.equal(String(err.message).includes('alice'), false);
  }
});

test('with the async keyring check (Electron 45+) the vault opens after load()', async () => {
  const base = fakeSafeStorage();
  let syncCalls = 0;
  const ss = { ...base, isEncryptionAvailable: () => { syncCalls += 1; return true; }, isAsyncEncryptionAvailable: async () => true };
  const v = createVault({ dir: tmpDir(), safeStorage: ss });
  assert.equal(v.available().ok, false, 'unknown until load()');
  await v.load();
  assert.equal(v.available().ok, true);
  assert.equal(syncCalls, 0, 'the deprecated synchronous check is never called');
  const locked = createVault({ dir: tmpDir(), safeStorage: { ...base, isAsyncEncryptionAvailable: async () => false } });
  await locked.load();
  assert.equal(locked.available().ok, false);
});
