'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { importPasswordsCsv, parseCsv } = require('../src/main/import/csv');
const { createVault } = require('../src/main/passwords');

const FIX = path.join(__dirname, 'fixtures');

function fakeSafeStorage(backend = 'gnome_libsecret') {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
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
const newVault = (backend) => createVault({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sn-csv-')), safeStorage: fakeSafeStorage(backend) });
const pairs = (vault, origin) => JSON.stringify(vault.find(origin).map((e) => [e.username, e.password]));

test('parseCsv: quotes, escaped quotes, embedded commas and newlines, CRLF, BOM', () => {
  const rows = parseCsv('﻿a,b,c\r\n"x,1","say ""hi""","two\nlines"\r\nlast,,\n\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x,1', 'say "hi"', 'two\nlines'], ['last', '', '']]);
  assert.deepEqual(parseCsv('a,b\rc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseCsv('no newline at end'), [['no newline at end']]);
  assert.deepEqual(parseCsv(''), []);
});

test('Google Password Manager / Chrome export', async () => {
  const vault = newVault();
  const r = await importPasswordsCsv(path.join(FIX, 'passwords-chrome.csv'), vault);
  assert.deepEqual(r, { added: 4, updated: 0, skipped: 2 }); // android:// and the empty password
  assert.ok(pairs(vault, 'https://example.com') === JSON.stringify([['alice', 'pa,ss"word']]));
  assert.ok(pairs(vault, 'https://multi.example') === JSON.stringify([['bob', 'line1\nline2']]));
  assert.ok(pairs(vault, 'https://plain.example:8443') === JSON.stringify([['', 'just-a-password']]));
  assert.ok(pairs(vault, 'https://www.barehost.example') === JSON.stringify([['erin', 'bare-pass']]));
  // importing again changes nothing
  assert.deepEqual(await importPasswordsCsv(path.join(FIX, 'passwords-chrome.csv'), vault), { added: 0, updated: 0, skipped: 6 });
});

test('Firefox export', async () => {
  const vault = newVault();
  const r = await importPasswordsCsv(path.join(FIX, 'passwords-firefox.csv'), vault);
  assert.deepEqual(r, { added: 1, updated: 0, skipped: 1 });
  assert.ok(pairs(vault, 'https://www.mozilla.org') === JSON.stringify([['fox', 'ff-pass']]));
  assert.equal(vault.list()[0].updated, 1600000000000);
});

test('Bitwarden export: logins only, first URI', async () => {
  const vault = newVault();
  const r = await importPasswordsCsv(path.join(FIX, 'passwords-bitwarden.csv'), vault);
  assert.deepEqual(r, { added: 1, updated: 0, skipped: 1 });
  assert.ok(pairs(vault, 'https://bw.example') === JSON.stringify([['warden', 'bw-pass']]));
});

test('unrecognized files and unavailable vaults throw readable errors', async () => {
  await assert.rejects(importPasswordsCsv(path.join(FIX, 'not-passwords.csv'), newVault()), /does not look like a password export/);
  await assert.rejects(importPasswordsCsv(path.join(FIX, 'nope.csv'), newVault()), { code: 'ENOENT' });
  await assert.rejects(importPasswordsCsv(path.join(FIX, 'passwords-chrome.csv'), newVault('basic_text')), (err) => {
    assert.equal(err.code, 'SN_VAULT_UNAVAILABLE');
    assert.ok(!String(err.message).includes('pa,ss'), 'no secrets in errors');
    return true;
  });
});
