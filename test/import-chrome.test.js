'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { detectProfiles, importProfile } = require('../src/main/import/chrome');
const { createVault } = require('../src/main/passwords');
const { createBookmarks } = require('../src/main/bookmarks');
const { createHistory } = require('../src/main/history');

const FIX = path.join(__dirname, 'fixtures', 'chrome');
const KEYRING_PASS = 'test-keyring-pass';
const SECRETS = ['gh-secret-1', 'g-secret-2', 'android-secret', 'legacy-secret', 'router-secret', 'gh-older', 'shop-secret', 'abc123', 'xyz789', 'nr-value'];

let sqliteOk = true;
try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); } catch { sqliteOk = false; }
const opts = { skip: sqliteOk ? false : 'sqlite3 CLI not installed' };

function fakeSafeStorage() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(s) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(s, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    decryptString(buf) {
      const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

// Chrome's os_crypt on Linux.
function chromeEncrypt(version, plaintext) {
  const pass = version === 'v10' ? 'peanuts' : KEYRING_PASS;
  const key = crypto.pbkdf2Sync(pass, 'saltysalt', 1, 16, 'sha1');
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from(version), c.update(plaintext), c.final()]);
}
const hex = (buf) => `X'${buf.toString('hex')}'`;
const pw = (version, s) => hex(chromeEncrypt(version, Buffer.from(s)));
const cookieBlob = (version, host, value, prefixHost = host) =>
  hex(chromeEncrypt(version, Buffer.concat([crypto.createHash('sha256').update(prefixHost).digest(), Buffer.from(value)])));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const chromeTime = (ms) => String((BigInt(ms) + 11644473600000n) * 1000n);

function sqlite(file, sql) {
  execFileSync('sqlite3', ['-init', '/dev/null', '-bail', file], { input: sql, stdio: ['pipe', 'ignore', 'inherit'] });
}

const NOW = Date.now();
const T_OLD = NOW - 400 * 86400000;
const T_MID = NOW - 30 * 86400000;

function buildFixture() {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-chrome-fixture-'));
  const root = path.join(config, 'google-chrome');
  const def = path.join(root, 'Default');
  fs.mkdirSync(def, { recursive: true });
  fs.copyFileSync(path.join(FIX, 'local-state.json'), path.join(root, 'Local State'));
  fs.copyFileSync(path.join(FIX, 'bookmarks.json'), path.join(def, 'Bookmarks'));
  fs.mkdirSync(path.join(root, 'Profile 1'));
  fs.writeFileSync(path.join(root, 'Profile 1', 'Preferences'), '{}');
  fs.mkdirSync(path.join(root, 'Profile 2')); // empty: not a profile
  fs.mkdirSync(path.join(root, 'System Profile'));
  fs.writeFileSync(path.join(root, 'System Profile', 'Preferences'), '{}');
  const brave = path.join(config, 'BraveSoftware', 'Brave-Browser', 'Default');
  fs.mkdirSync(brave, { recursive: true });
  fs.copyFileSync(path.join(FIX, 'bookmarks.json'), path.join(brave, 'Bookmarks'));

  const schema = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
  const login = (origin, realm, user, blob, { created = T_MID, modified = 0, blacklisted = 0, scheme = 0 } = {}) =>
    `INSERT INTO logins (origin_url, username_element, username_value, password_element, password_value, signon_realm, date_created, blacklisted_by_user, scheme, date_password_modified)
     VALUES (${q(origin)}, 'u', ${q(user)}, 'p', ${blob}, ${q(realm)}, ${chromeTime(created)}, ${blacklisted}, ${scheme}, ${modified ? chromeTime(modified) : 0});\n`;

  sqlite(path.join(def, 'Login Data'), schema('login-data.sql')
    + login('https://github.com/login', 'https://github.com/', 'octo', pw('v11', 'gh-secret-1'), { modified: T_MID })
    + login('https://accounts.google.com/signin', 'https://accounts.google.com/', 'me@example.com', pw('v10', 'g-secret-2'))
    + login('android://AAAA@com.example.app/', 'android://AAAA@com.example.app/', 'x', pw('v11', 'android-secret'))
    + login('https://never.example/', 'https://never.example/', '', "X''", { blacklisted: 1 })
    + login('https://broken.example/', 'https://broken.example/', 'b', hex(Buffer.concat([Buffer.from('v11'), crypto.randomBytes(32)])))
    + login('http://legacy.example/', 'http://legacy.example/', 'old', pw('v11', 'legacy-secret'))
    + login('https://router.example/', 'https://router.example/Router Realm', 'admin', pw('v11', 'router-secret'), { scheme: 1 }));

  sqlite(path.join(def, 'Login Data For Account'), schema('login-data.sql')
    + login('https://github.com/login', 'https://github.com/', 'octo', pw('v11', 'gh-older'), { created: T_OLD, modified: T_OLD })
    + login('https://shop.example/', 'https://shop.example/', 'buyer', pw('v11', 'shop-secret')));

  const future = chromeTime(NOW + 30 * 86400000);
  const past = chromeTime(NOW - 86400000);
  const cookie = (host, name, value, blob, { path: p = '/', expires = future, secure = 1, httponly = 0, samesite = -1, persistent = 1, partition = '' } = {}) =>
    `INSERT INTO cookies VALUES (${chromeTime(T_MID)}, ${q(host)}, ${q(partition)}, ${q(name)}, ${q(value)}, ${blob}, ${q(p)}, ${persistent ? expires : 0},
       ${secure}, ${httponly}, ${chromeTime(T_MID)}, ${persistent}, ${persistent}, 1, ${samesite}, 2, 443, ${chromeTime(T_MID)}, 0, 0);\n`;
  sqlite(path.join(def, 'Cookies'), schema('cookies.sql')
    + cookie('.example.com', 'sid', '', cookieBlob('v11', '.example.com', 'abc123'), { httponly: 1, samesite: 1 })
    + cookie('www.example.com', '__Host-id', '', cookieBlob('v10', 'www.example.com', 'xyz789'), { samesite: 2 })
    + cookie('.example.com', 'old', '', cookieBlob('v11', '.example.com', 'expired'), { expires: past })
    + cookie('.widget.example', 'chips', '', cookieBlob('v11', '.widget.example', 'partitioned'), { partition: 'https://other.example' })
    + cookie('plain.example', 'plain', 'plainvalue', "X''", { secure: 0, persistent: 0 })
    + cookie('.example.com', 'bad', '', cookieBlob('v11', '.example.com', 'rejected'))
    + cookie('.example.com', 'wronghash', '', cookieBlob('v11', '.example.com', 'value', 'other-host'))
    + cookie('.example.net', 'nr', '', cookieBlob('v11', '.example.net', 'nr-value'), { samesite: 0, path: '/app' }));

  const url = (u, title, visits, last, hidden = 0) =>
    `INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (${q(u)}, ${q(title)}, ${visits}, 0, ${chromeTime(last)}, ${hidden});\n`;
  sqlite(path.join(def, 'History'), schema('history.sql')
    + url('https://github.com/', 'GitHub', 50, T_MID)
    + url('http://example.org/page', 'Example page', 2, T_OLD)
    + url('chrome://settings/', 'Settings', 9, T_MID)
    + url('https://hidden.example/', 'Hidden', 3, T_MID, 1)
    + url('https://zero.example/', 'Zero', 0, T_MID)
    + url('file:///home/x', 'File', 4, T_MID));
  return { config, profileDir: def };
}

function fakeCookies() {
  const set = [];
  return {
    set,
    api: {
      async set(d) {
        if (d.name === 'bad') throw new Error('Failed to set cookie');
        set.push(d);
      },
      async flushStore() {},
    },
  };
}

function stores() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-import-stores-'));
  return {
    vault: createVault({ dir, safeStorage: fakeSafeStorage() }),
    bookmarks: createBookmarks({ dir }),
    history: createHistory({ dir }),
  };
}

const importDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('supernova-import-'));

function assertNoSecrets(value) {
  const s = JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!s.includes(secret), 'a secret leaked into the result');
}

test('detectProfiles finds profiles with names and counts', opts, async () => {
  const { config, profileDir } = buildFixture();
  const found = await detectProfiles({ configDir: config });
  assert.deepEqual(found.map((p) => [p.browser, p.name, path.basename(p.dir)]), [
    ['chrome', 'Personal', 'Default'],
    ['chrome', 'Work', 'Profile 1'],
    ['brave', 'Default', 'Default'],
  ]);
  assert.equal(found[0].dir, profileDir);
  assert.equal(found[0].passwords, 8); // 6 in Login Data + 2 in Login Data For Account
  assert.equal(found[0].bookmarks, 4);
  assert.equal(found[1].passwords, null);
  assert.equal(found[1].bookmarks, null);
  assert.equal(found[2].bookmarks, 4);
  assert.deepEqual(await detectProfiles({ configDir: path.join(config, 'nothing-here') }), []);
});

test('importProfile imports everything and maps cookies for Electron', opts, async () => {
  const { config } = buildFixture();
  const [profile] = await detectProfiles({ configDir: config });
  const s = stores();
  const cookies = fakeCookies();
  const lookups = [];
  const before = importDirs();
  const result = await importProfile(profile, {
    what: { passwords: true, bookmarks: true, history: true, cookies: true },
    ...s,
    cookies: cookies.api,
    secretLookup: async (attrs) => { lookups.push(attrs); return attrs.application === 'chrome' ? KEYRING_PASS + '\n' : null; },
  });
  assertNoSecrets(result);
  assert.deepEqual(lookups, [{ application: 'chrome' }], 'key looked up once');
  assert.deepEqual(importDirs(), before, 'temp copies removed');

  assert.deepEqual(result.passwords, { added: 5, updated: 0, skipped: 2, failed: 1 });
  assert.deepEqual(result.errors, ['Passwords: 1 could not be decrypted.', 'Cookies: 2 could not be imported.']);
  const byOrigin = (o) => s.vault.find(o).map((e) => [e.username, e.password]);
  assert.ok(JSON.stringify(byOrigin('https://github.com')) === JSON.stringify([['octo', 'gh-secret-1']]), 'newer GitHub password kept');
  assert.ok(JSON.stringify(byOrigin('https://accounts.google.com')) === JSON.stringify([['me@example.com', 'g-secret-2']]), 'v10 decrypted');
  assert.ok(JSON.stringify(byOrigin('http://legacy.example')) === JSON.stringify([['old', 'legacy-secret']]));
  assert.ok(JSON.stringify(byOrigin('https://router.example')) === JSON.stringify([['admin', 'router-secret']]));
  assert.ok(JSON.stringify(byOrigin('https://shop.example')) === JSON.stringify([['buyer', 'shop-secret']]));
  assert.equal(s.vault.count(), 5);

  assert.deepEqual(result.bookmarks, { added: 3, skipped: 3 });
  assert.deepEqual(s.bookmarks.list().map((b) => [b.url, b.title, b.folder]), [
    ['https://example.com/', 'Example', 'Bookmarks bar'],
    ['https://developer.mozilla.org/', 'MDN', 'Bookmarks bar/Dev'],
    ['https://m.example.org/page', 'Phone link', 'Mobile bookmarks'],
  ]);
  assert.equal(s.bookmarks.list()[0].added, Number(13300000000000000n / 1000n - 11644473600000n));

  assert.deepEqual(result.history, { added: 2, updated: 0, skipped: 0 });
  const gh = s.history.search('github')[0];
  assert.equal(gh.url, 'https://github.com/');
  assert.equal(gh.visits, 50);
  assert.ok(Math.abs(gh.lastVisit - T_MID) < 2, 'Chrome time converted');

  assert.deepEqual(result.cookies, { added: 4, skipped: 2, failed: 2 });
  const byName = Object.fromEntries(cookies.set.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ['__Host-id', 'nr', 'plain', 'sid']);
  const sid = byName.sid;
  assert.equal(sid.url, 'https://example.com/');
  assert.equal(sid.domain, '.example.com');
  assert.equal(sid.secure, true);
  assert.equal(sid.httpOnly, true);
  assert.equal(sid.sameSite, 'lax');
  assert.ok(sid.value === 'abc123', 'v11 cookie decrypted and hash prefix stripped');
  assert.ok(Math.abs(sid.expirationDate - (NOW / 1000 + 30 * 86400)) < 2);
  const host = byName['__Host-id'];
  assert.equal('domain' in host, false, 'host-only cookie has no domain');
  assert.equal(host.url, 'https://www.example.com/');
  assert.equal(host.sameSite, 'strict');
  assert.ok(host.value === 'xyz789');
  const plain = byName.plain;
  assert.equal(plain.url, 'http://plain.example/');
  assert.equal(plain.value, 'plainvalue');
  assert.equal(plain.sameSite, 'unspecified');
  assert.equal('expirationDate' in plain, false, 'session cookie');
  assert.equal(byName.nr.sameSite, 'no_restriction');
  assert.equal(byName.nr.path, '/app');
  assert.equal(byName.nr.url, 'https://example.net/app');
});

test('missing keyring key: v10 still works, v11 counted as failed', opts, async () => {
  const { config } = buildFixture();
  const [profile] = await detectProfiles({ configDir: config });
  const s = stores();
  const cookies = fakeCookies();
  const result = await importProfile(profile, { ...s, cookies: cookies.api, secretLookup: async () => null });
  assertNoSecrets(result);
  assert.deepEqual(result.passwords, { added: 1, updated: 0, skipped: 1, failed: 6 });
  assert.ok(result.errors.some((e) => /key was not found in the keyring/.test(e)));
  assert.equal(s.vault.count(), 1);
  assert.deepEqual(cookies.set.map((c) => c.name).sort(), ['__Host-id', 'plain']);
});

test('what selects parts; an unavailable vault does not stop the rest', opts, async () => {
  const { config } = buildFixture();
  const [profile] = await detectProfiles({ configDir: config });
  const s = stores();
  const only = await importProfile(profile, { what: { bookmarks: true }, ...s, cookies: null, secretLookup: async () => KEYRING_PASS });
  assert.equal(only.passwords, null);
  assert.equal(only.history, null);
  assert.equal(only.cookies, null);
  assert.equal(only.bookmarks.added, 3);

  const locked = stores();
  const ss = fakeSafeStorage();
  ss.getSelectedStorageBackend = () => 'basic_text';
  locked.vault = createVault({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sn-locked-')), safeStorage: ss });
  const r = await importProfile(profile, { what: { passwords: true, history: true }, ...locked, secretLookup: async () => KEYRING_PASS });
  assert.deepEqual(r.passwords, { added: 0, updated: 0, skipped: 0, failed: 0 });
  assert.match(r.errors[0], /^Passwords were not imported: /);
  assert.equal(r.history.added, 2);
});

test('a missing profile folder is reported, not thrown', async () => {
  const r = await importProfile({ browser: 'chrome', dir: path.join(os.tmpdir(), 'sn-does-not-exist') }, {});
  assert.deepEqual(r.errors, ['The profile folder was not found.']);
});
