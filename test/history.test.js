'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createHistory, MAX_ENTRIES } = require('../src/main/history');

const DAY = 86400000;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sn-history-'));

test('add ignores non-http(s) and counts visits', () => {
  const h = createHistory({ dir: tmpDir() });
  assert.equal(h.add({ url: 'chrome://settings', title: 'x' }), false);
  assert.equal(h.add({ url: 'file:///etc/passwd' }), false);
  assert.equal(h.add({ url: 'javascript:alert(1)' }), false);
  assert.equal(h.add({ url: 'https://example.com/', title: 'Example' }), true);
  h.add({ url: 'https://example.com/', title: 'Example Domain' });
  const [e] = h.recent();
  assert.equal(e.url, 'https://example.com/');
  assert.equal(e.visits, 2);
  assert.equal(e.title, 'Example Domain');
  assert.equal(h.size(), 1);
});

test('search ranks host prefix above word prefix above substring', () => {
  const h = createHistory({ dir: tmpDir() });
  const now = Date.now();
  h.importMany([
    { url: 'https://github.com/', title: 'GitHub', visits: 5, lastVisit: now - DAY },
    { url: 'https://news.example.com/git-tips', title: 'Tips', visits: 5, lastVisit: now - DAY },
    { url: 'https://example.org/legit', title: 'Legit stuff', visits: 5, lastVisit: now - DAY },
  ]);
  const r = h.search('git');
  assert.deepEqual(r.map((x) => x.url), [
    'https://github.com/',
    'https://news.example.com/git-tips',
    'https://example.org/legit',
  ]);
  assert.ok(r[0].score > r[1].score && r[1].score > r[2].score);
  for (const x of r) assert.deepEqual(Object.keys(x).sort(), ['lastVisit', 'score', 'title', 'url', 'visits']);
});

test('search: frecency, multiple terms, scheme/www in the query, limit', () => {
  const h = createHistory({ dir: tmpDir() });
  const now = Date.now();
  h.importMany([
    { url: 'https://www.youtube.com/', title: 'YouTube', visits: 300, lastVisit: now - 2 * DAY },
    { url: 'https://www.youtube.com/watch?v=1', title: 'Cats compilation', visits: 1, lastVisit: now - 400 * DAY },
    { url: 'https://www.youtube.com/watch?v=2', title: 'Rust talk', visits: 3, lastVisit: now - 3 * DAY },
  ]);
  assert.equal(h.search('you')[0].url, 'https://www.youtube.com/');
  assert.equal(h.search('https://www.you')[0].url, 'https://www.youtube.com/');
  assert.deepEqual(h.search('youtube rust').map((x) => x.url), ['https://www.youtube.com/watch?v=2']);
  assert.equal(h.search('you', 2).length, 2);
  assert.deepEqual(h.search('   '), []);
  assert.deepEqual(h.search('zzz-not-there'), []);
  // a site visited a lot recently beats one visited once long ago
  const r = h.search('youtube.com/watch');
  assert.equal(r[0].url, 'https://www.youtube.com/watch?v=2');
});

test('updateTitle, recent, remove, clear', () => {
  const h = createHistory({ dir: tmpDir() });
  const now = Date.now();
  h.add({ url: 'https://a.example/', title: 'A', at: now - 3000 });
  h.add({ url: 'https://b.example/', title: 'B', at: now - 2000 });
  h.add({ url: 'https://c.example/', title: 'C', at: now - 1000 });
  h.updateTitle('https://a.example/', 'Alpha');
  assert.equal(h.search('alpha')[0].url, 'https://a.example/');
  assert.deepEqual(h.recent(2).map((e) => e.url), ['https://c.example/', 'https://b.example/']);
  h.remove('https://c.example/');
  assert.deepEqual(h.recent().map((e) => e.url), ['https://b.example/', 'https://a.example/']);
  h.clear();
  assert.deepEqual(h.recent(), []);
});

test('importMany merges and keeps the best values', () => {
  const h = createHistory({ dir: tmpDir() });
  h.importMany([{ url: 'https://x.example/', title: 'Old', visits: 10, lastVisit: 1000 }]);
  const r = h.importMany([
    { url: 'https://x.example/', title: 'New', visits: 3, lastVisit: 5000 },
    { url: 'https://y.example/', title: 'Y', visits: 1, lastVisit: 10 },
    { url: 'ftp://nope/', title: 'no' },
  ]);
  assert.deepEqual(r, { added: 1, updated: 1, skipped: 1 });
  const x = h.recent().find((e) => e.url === 'https://x.example/');
  assert.deepEqual({ v: x.visits, l: x.lastVisit, t: x.title }, { v: 10, l: 5000, t: 'New' });
});

test('keeps at most maxEntries, dropping the lowest frecency', () => {
  const h = createHistory({ dir: tmpDir(), maxEntries: 100 });
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 150; i++) rows.push({ url: `https://s${i}.example/`, title: `s${i}`, visits: i + 1, lastVisit: now - (150 - i) * DAY });
  h.importMany(rows);
  assert.ok(h.size() <= 100, `size ${h.size()}`);
  assert.ok(h.search('s149.example').length === 1, 'best entry kept');
  assert.equal(h.search('s0.example').length, 0, 'worst entry dropped');
  for (let i = 0; i < 50; i++) h.add({ url: `https://new${i}.example/` });
  assert.ok(h.size() <= 100);
  assert.equal(h.search('new49').length, 1, 'fresh visit kept');
});

test('real cap is 20 000', () => {
  assert.equal(MAX_ENTRIES, 20000);
  const h = createHistory({ dir: tmpDir() });
  const rows = [];
  for (let i = 0; i < 20500; i++) rows.push({ url: `https://h${i}.example/`, visits: 1, lastVisit: Date.now() - i * 1000 });
  h.importMany(rows);
  assert.ok(h.size() <= 20000);
});

test('persists atomically and loads back', async () => {
  const dir = tmpDir();
  const h = createHistory({ dir });
  h.add({ url: 'https://persist.example/page', title: 'Persist me' });
  h.add({ url: 'https://persist.example/page' });
  await h.flush();
  const files = await fsp.readdir(dir);
  assert.deepEqual(files, ['history.json']);
  const h2 = createHistory({ dir });
  await h2.load();
  const [e] = h2.search('persist');
  assert.equal(e.url, 'https://persist.example/page');
  assert.equal(e.visits, 2);
  assert.equal(e.title, 'Persist me');
});

test('load tolerates a missing or damaged file', async () => {
  const dir = tmpDir();
  const h = createHistory({ dir });
  await h.load();
  fs.writeFileSync(path.join(dir, 'history.json'), '{not json');
  const original = console.error;
  console.error = () => {};
  try { await h.load(); } finally { console.error = original; }
  assert.equal(h.size(), 0);
});

// The command bar searches on every keystroke. On an idle P1 the worst median is
// 1.6-2.7 ms; the limit is 25 ms so a busy machine (another build, a benchmark)
// does not fail it, while a slower algorithm (sorting all 20 000 per key) would.
test('search over 20 000 entries is fast enough to run per keystroke', (t) => {
  const h = createHistory({ dir: tmpDir() });
  const words = ['news', 'mail', 'docs', 'video', 'shop', 'maps', 'wiki', 'forum', 'blog', 'music', 'photo', 'cloud', 'code', 'game', 'travel', 'food'];
  const tlds = ['com', 'org', 'it', 'net', 'io', 'de'];
  const now = Date.now();
  const rows = [];
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) % n; };
  for (let i = 0; i < MAX_ENTRIES; i++) {
    const w1 = words[rnd(words.length)], w2 = words[rnd(words.length)];
    const host = `${rnd(3) ? 'www.' : ''}${w1}${i % 997}.${tlds[rnd(tlds.length)]}`;
    rows.push({
      url: `https://${host}/${w2}/${i}/article-about-${w1}-and-${w2}?id=${i}`,
      title: `${w1[0].toUpperCase()}${w1.slice(1)} ${w2} – page ${i} of the ${w2} section`,
      visits: 1 + rnd(200),
      lastVisit: now - rnd(365) * DAY,
    });
  }
  h.importMany(rows);
  assert.equal(h.size(), MAX_ENTRIES);
  assert.equal(h.search('docs').length, 8);

  // What typing in the command bar produces, one keystroke at a time.
  const queries = [];
  for (const word of ['github', 'news', 'youtube video', 'docs page 12', 'https://www.m', 'wiki.org/']) {
    for (let i = 1; i <= word.length; i++) queries.push(word.slice(0, i));
  }
  for (let i = 0; i < 3; i++) for (const q of queries) h.search(q); // warm up the JIT

  let worst = 0, worstQuery = '';
  for (const q of queries) {
    const times = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      h.search(q);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[2];
    if (median > worst) { worst = median; worstQuery = q; }
  }
  t.diagnostic(`worst median search time: ${worst.toFixed(2)} ms (query "${worstQuery}")`);
  assert.ok(worst < 25, `search took ${worst.toFixed(2)} ms for "${worstQuery}"`);
});
