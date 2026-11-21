'use strict';
// Bookmarks store. Pure Node: no electron here.
// File: dir/bookmarks.json, atomic writes on a short single-shot debounce.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SAVE_DELAY_MS = 500;
const MAX_URL = 8192;
const MAX_TITLE = 512;

function isAllowedUrl(url) {
  return typeof url === 'string' && url.length <= MAX_URL && /^(https?:\/\/[^/?#\s]|file:\/\/)/i.test(url);
}

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}

function isWordChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c > '\u007f';
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

function createBookmarks({ dir } = {}) {
  if (!dir) throw new Error('createBookmarks: dir is required');
  const file = path.join(dir, 'bookmarks.json');
  let items = [];          // [{ id, url, title, folder, added }] in display order
  const byUrl = new Map(); // url -> item

  let dirty = false;
  let timer = null;
  let chain = Promise.resolve();

  function schedule() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; save(); }, SAVE_DELAY_MS);
    if (timer.unref) timer.unref();
  }

  function save() {
    if (!dirty) return chain;
    dirty = false;
    const data = JSON.stringify({ v: 1, items });
    chain = chain.then(async () => {
      await fsp.mkdir(dir, { recursive: true });
      await writeAtomic(file, data);
    }).catch((err) => {
      dirty = true;
      console.error('[bookmarks] save failed:', err.code || err.message);
    });
    return chain;
  }

  function insert({ url, title, folder, added, id }) {
    if (!isAllowedUrl(url) || byUrl.has(url)) return null;
    const item = {
      id: typeof id === 'string' && id ? id : crypto.randomUUID(),
      url,
      title: cleanText(title, MAX_TITLE),
      folder: cleanText(folder, 1024),
      added: Number.isFinite(added) && added > 0 ? added : Date.now(),
    };
    items.push(item);
    byUrl.set(url, item);
    return item;
  }

  function removeUrl(url) {
    if (!byUrl.delete(url)) return false;
    items = items.filter((b) => b.url !== url);
    return true;
  }

  const copy = (b) => ({ id: b.id, url: b.url, title: b.title, folder: b.folder, added: b.added });

  return {
    async load() {
      let parsed;
      try {
        parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('[bookmarks] could not read bookmarks.json:', err.code || err.message);
        return;
      }
      const loaded = parsed && Array.isArray(parsed.items) ? parsed.items : [];
      // Anything added before load() finished goes after the stored ones.
      const early = items;
      items = [];
      byUrl.clear();
      for (const b of loaded) if (b) insert(b);
      for (const b of early) insert(b);
    },

    list() { return items.map(copy); },

    has(url) { return byUrl.has(url); },

    toggle({ url, title } = {}) {
      if (removeUrl(url)) { schedule(); return false; }
      if (!insert({ url, title, folder: '' })) return false;
      schedule();
      return true;
    },

    remove(url) {
      if (removeUrl(url)) schedule();
    },

    search(query, limit = 5) {
      const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
      if (!q || !(limit > 0)) return [];
      const terms = q.split(/\s+/);
      const scored = [];
      for (const b of items) {
        const hay = (b.title + ' ' + b.url.replace(/^https?:\/\/(www\.)?/i, '')).toLowerCase();
        let score = 0;
        for (const t of terms) {
          let i = hay.indexOf(t);
          if (i === -1) { score = 0; break; }
          let s = 1;
          while (i !== -1) {
            if (i === 0) { s = 4; break; }
            if (!isWordChar(hay[i - 1])) s = 2;
            i = hay.indexOf(t, i + 1);
          }
          score += s;
        }
        if (score > 0) scored.push({ b, score });
      }
      scored.sort((x, y) => y.score - x.score || y.b.added - x.b.added);
      return scored.slice(0, limit).map((x) => copy(x.b));
    },

    importMany(entries) {
      let added = 0, skipped = 0;
      for (const it of entries || []) {
        if (it && insert({ url: it.url, title: it.title, folder: it.folder, added: it.added })) added++;
        else skipped++;
      }
      if (added) schedule();
      return { added, skipped };
    },

    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      await save();
      await chain;
    },
  };
}

module.exports = { createBookmarks };
