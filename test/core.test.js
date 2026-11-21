'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonStore } = require('../src/main/store');
const { parseColorsToml, readTheme } = require('../src/main/theme');
const { keyOf } = require('../src/main/shortcuts');
const { uniquePath } = require('../src/main/downloads');
const { keysFor, describe } = require('../src/main/permissions');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sn-test-'));

test('JsonStore: defaults, flat dotted keys, atomic save, change events', async () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  const s = new JsonStore(file, { 'a.b': 1, nested: { x: 2 } }, { delay: 5 });
  assert.equal(s.get('a.b'), 1);
  assert.equal(s.get('nested.x'), 2);
  const seen = [];
  s.on('change', (k, v) => seen.push([k, v]));
  s.set('a.b', 3);
  s.set('a.b', 3);
  assert.deepEqual(seen, [['a.b', 3]]);
  await s.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'a.b': 3 });
  assert.equal(new JsonStore(file, { 'a.b': 1 }).get('a.b'), 3);
});

test('JsonStore keeps a broken file aside instead of losing it', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{not json');
  const s = new JsonStore(file, { k: 1 });
  assert.equal(s.get('k'), 1);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('settings.json.broken-')));
});

test('JsonStore: the files are private, and a write at quit is never undone by a slower one', async () => {
  const dir = tmp();
  const file = path.join(dir, 'session.json');
  const s = new JsonStore(file, {}, { delay: 5 });
  s.set('k', 1);
  await s.flush();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // An async write of k=2 is on its way when quitting saves k=3 at once.
  s.set('k', 2);
  const slow = s.flush();
  s.set('k', 3);
  s.flushSync();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).k, 3);
  await slow;
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).k, 3, 'the older write did not land over it');

  // Only an async write pending: quitting still writes it, at once.
  s.set('k', 4);
  const pending = s.flush();
  s.flushSync();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).k, 4);
  await pending;
  assert.deepEqual(fs.readdirSync(dir), ['session.json'], 'no temporary files left behind');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('theme: Nova colors.toml is read, bad values fall back', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'theme'));
  fs.writeFileSync(path.join(dir, 'theme', 'colors.toml'), [
    '# comment', 'mode = "dark"', 'background = "#101010"   # base', 'foreground = "#ffffff"', 'accent = "nope"',
  ].join('\n'));
  assert.deepEqual(parseColorsToml('a = "#000000"\n# x = "y"\nb="1"'), { a: '#000000', b: '1' });
  const t = readTheme({ dir });
  assert.equal(t.mode, 'dark');
  assert.equal(t.background, '#101010');
  assert.equal(t.foreground, '#ffffff');
  assert.match(t.accent, /^#[0-9a-f]{6}$/);
  assert.equal(readTheme({ dir: path.join(dir, 'missing'), prefersDark: true }).mode, 'dark');
});

test('shortcuts: physical digits and +/- whatever the layout', () => {
  assert.equal(keyOf({ key: 'T', control: true }), 'ctrl+t');
  assert.equal(keyOf({ key: '!', code: 'Digit1', control: true, shift: true }), 'ctrl+shift+1');
  assert.equal(keyOf({ key: '+', code: 'BracketRight', control: true }), 'ctrl++');
  assert.equal(keyOf({ key: '-', code: 'Slash', control: true }), 'ctrl+-');
  assert.equal(keyOf({ key: 'ArrowLeft', alt: true }), 'alt+arrowleft');
});

test('downloads: never overwrite, never escape the folder', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.pdf'), '');
  assert.equal(uniquePath(dir, 'a.pdf'), path.join(dir, 'a (1).pdf'));
  assert.equal(path.dirname(uniquePath(dir, '../../etc/passwd')), dir);
  assert.equal(path.basename(uniquePath(dir, '.bashrc')), '_bashrc');
  // A download still in progress holds its name: on disk only as .crdownload,
  // or not yet at all.
  fs.writeFileSync(path.join(dir, 'b.zip.crdownload'), '');
  assert.equal(uniquePath(dir, 'b.zip'), path.join(dir, 'b (1).zip'));
  const reserved = new Set([path.join(dir, 'c.iso')]);
  assert.equal(uniquePath(dir, 'c.iso', reserved), path.join(dir, 'c (1).iso'));
});

test('permissions: camera and microphone remembered apart', () => {
  assert.deepEqual(keysFor('media', { mediaTypes: ['video', 'audio'] }), ['media-video', 'media-audio']);
  assert.deepEqual(keysFor('geolocation', {}), ['geolocation']);
  assert.equal(describe('media', { mediaTypes: ['audio'] }), 'use your microphone');
});
