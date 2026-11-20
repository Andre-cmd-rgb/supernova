'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBookmarks } = require('../src/main/bookmarks');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sn-bookmarks-'));

test('toggle, has, list, remove', () => {
  const b = createBookmarks({ dir: tmpDir() });
  assert.equal(b.toggle({ url: 'https://example.com/', title: 'Example' }), true);
  assert.equal(b.has('https://example.com/'), true);
  const [item] = b.list();
  assert.deepEqual(Object.keys(item).sort(), ['added', 'folder', 'id', 'title', 'url']);
  assert.equal(item.title, 'Example');
  assert.equal(item.folder, '');
  assert.equal(typeof item.id, 'string');
  assert.equal(b.toggle({ url: 'https://example.com/' }), false);
  assert.equal(b.has('https://example.com/'), false);
  b.toggle({ url: 'https://a.example/', title: 'A' });
  b.remove('https://a.example/');
  assert.deepEqual(b.list(), []);
});

test('refuses script and internal URLs', () => {
  const b = createBookmarks({ dir: tmpDir() });
  assert.equal(b.toggle({ url: 'javascript:alert(1)', title: 'bookmarklet' }), false);
  assert.equal(b.toggle({ url: 'chrome://settings', title: 'x' }), false);
  assert.equal(b.list().length, 0);
});

test('list returns copies', () => {
  const b = createBookmarks({ dir: tmpDir() });
  b.toggle({ url: 'https://example.com/', title: 'Example' });
  b.list()[0].title = 'mutated';
  assert.equal(b.list()[0].title, 'Example');
});

test('search: title and url, word starts first, limit', () => {
  const b = createBookmarks({ dir: tmpDir() });
  b.importMany([
    { url: 'https://developer.mozilla.org/', title: 'MDN Web Docs', folder: 'Dev' },
    { url: 'https://docs.python.org/3/', title: 'Python documentation', folder: 'Dev' },
    { url: 'https://example.com/paradocs', title: 'Something', folder: '' },
    { url: 'https://news.example/', title: 'News', folder: '' },
  ]);
  const r = b.search('docs');
  assert.equal(r.length, 3);
  assert.equal(r[2].url, 'https://example.com/paradocs');
  assert.equal(b.search('docs', 1).length, 1);
  assert.deepEqual(b.search('python doc').map((x) => x.url), ['https://docs.python.org/3/']);
  assert.deepEqual(b.search(''), []);
});

test('importMany skips duplicates and bad URLs, keeps folders', () => {
  const b = createBookmarks({ dir: tmpDir() });
  b.toggle({ url: 'https://example.com/', title: 'Mine' });
  const r = b.importMany([
    { url: 'https://example.com/', title: 'Dup', folder: 'Bookmarks bar' },
    { url: 'https://new.example/', title: 'New', folder: 'Bookmarks bar/Dev' },
    { url: 'javascript:void(0)', title: 'Bookmarklet', folder: 'x' },
  ]);
  assert.deepEqual(r, { added: 1, skipped: 2 });
  const n = b.list().find((x) => x.url === 'https://new.example/');
  assert.equal(n.folder, 'Bookmarks bar/Dev');
  assert.equal(b.list().find((x) => x.url === 'https://example.com/').title, 'Mine');
});

test('persists atomically and loads back in order', async () => {
  const dir = tmpDir();
  const b = createBookmarks({ dir });
  b.toggle({ url: 'https://one.example/', title: 'One' });
  b.toggle({ url: 'https://two.example/', title: 'Two' });
  await b.flush();
  assert.deepEqual(fs.readdirSync(dir), ['bookmarks.json']);
  const b2 = createBookmarks({ dir });
  await b2.load();
  assert.deepEqual(b2.list().map((x) => x.title), ['One', 'Two']);
  assert.deepEqual(b2.list().map((x) => x.id), b.list().map((x) => x.id));
  assert.equal(b2.has('https://two.example/'), true);
});
