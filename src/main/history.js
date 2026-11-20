'use strict';
// History store (agent A). Pure Node: no electron here.
//
// One JSON file (dir/history.json), loaded once, kept in memory, written
// atomically on a single-shot debounce. search() runs on every keystroke in the
// command bar, so each entry keeps a precomputed lowercase haystack and the
// scan is a plain loop over a Map with String#includes.

const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_ENTRIES = 20000;
const PRUNE_TO = MAX_ENTRIES - 200; // slack so we do not sort on every visit
const SAVE_DELAY_MS = 3000;
const MAX_URL = 8192;
const MAX_TITLE = 512;
const DAY = 86400000;

function isHttpUrl(url) {
  return typeof url === 'string' && url.length <= MAX_URL && /^https?:\/\/[^/?#\s]/i.test(url);
}

function cleanTitle(title) {
  if (typeof title !== 'string') return '';
  const t = title.replace(/\s+/g, ' ').trim();
  return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE) : t;
}

function safeDecode(s) {
  try { return decodeURI(s); } catch { return s; }
}

// "https://www.Example.com/a?b" -> "example.com/a?b" (lowercase, no scheme, no www.)
function bareUrl(url) {
  let s = url.replace(/^https?:\/\//i, '');
  s = safeDecode(s).toLowerCase();
  if (s.startsWith('www.')) s = s.slice(4);
  return s;
}

function normalizeQuery(query) {
  if (typeof query !== 'string') return '';
  let q = query.trim().toLowerCase();
  q = q.replace(/^https?:\/\//, '');
  if (q.startsWith('www.')) q = q.slice(4);
  return q.replace(/\s+/g, ' ').trim();
}

function prepare(e) {
  const bare = bareUrl(e.url);
  const slash = bare.search(/[/?#]/);
  e.host = slash === -1 ? bare : bare.slice(0, slash);
  e.isRoot = slash === -1 || bare.length - slash <= 1;
  e.hay = bare + ' ' + e.title.toLowerCase();
  // First letter of every word: a one-letter query only matches word starts,
  // and searching this short string is much cheaper than the haystack.
  let ini = '';
  const hay = e.hay;
  for (let i = 0; i < hay.length; i++) {
    if (isWordChar(hay[i]) && (i === 0 || !isWordChar(hay[i - 1]))) ini += hay[i];
  }
  e.initials = ini;
  e.logv = 1 + Math.log(1 + e.visits);
  return e;
}

function frecency(e, now) {
  const ageDays = now > e.lastVisit ? (now - e.lastVisit) / DAY : 0;
  return e.logv / (1 + ageDays / 30);
}

function isWordChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c > '\u007f';
}

const MAX_QUALITY = 12;

// Match quality of one term against an entry that is known to contain it.
// host prefix > prefix of a host label / word in title or url > substring.
function termQuality(e, t) {
  if (e.hay.startsWith(t)) {
    if (t === e.host || (e.isRoot && e.host.startsWith(t))) return 12;
    return 10;
  }
  const hay = e.hay;
  let i = hay.indexOf(t);
  while (i !== -1) {
    if (i === 0 || !isWordChar(hay[i - 1])) return 3;
    i = hay.indexOf(t, i + 1);
  }
  return 1;
}

// Keep `top` sorted by `key` descending, at most `limit` long.
function pushTop(top, item, key, limit) {
  const v = item[key];
  if (top.length >= limit && v <= top[top.length - 1][key]) return;
  let lo = 0, hi = top.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (top[mid][key] >= v) lo = mid + 1; else hi = mid;
  }
  top.splice(lo, 0, item);
  if (top.length > limit) top.pop();
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

function createHistory({ dir, maxEntries = MAX_ENTRIES } = {}) {
  if (!dir) throw new Error('createHistory: dir is required');
  const file = path.join(dir, 'history.json');
  const pruneTo = Math.max(1, Math.min(PRUNE_TO, maxEntries - Math.ceil(maxEntries / 100)));
  const map = new Map(); // url -> { url, title, visits, lastVisit, host, isRoot, hay, logv }

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
    const rows = [];
    for (const e of map.values()) rows.push([e.url, e.title, e.visits, e.lastVisit]);
    const data = JSON.stringify({ v: 1, entries: rows });
    chain = chain.then(async () => {
      await fsp.mkdir(dir, { recursive: true });
      await writeAtomic(file, data);
    }).catch((err) => {
      dirty = true;
      console.error('[history] save failed:', err.code || err.message);
    });
    return chain;
  }

  function prune() {
    if (map.size <= maxEntries) return;
    const now = Date.now();
    const all = [];
    for (const e of map.values()) all.push([frecency(e, now), e.url]);
    all.sort((a, b) => a[0] - b[0]);
    const drop = map.size - pruneTo;
    for (let i = 0; i < drop; i++) map.delete(all[i][1]);
  }

  function upsert({ url, title, visits, lastVisit }, mode) {
    if (!isHttpUrl(url)) return null;
    const t = cleanTitle(title);
    const v = Number.isFinite(visits) && visits > 0 ? Math.floor(visits) : 1;
    const at = Number.isFinite(lastVisit) && lastVisit > 0 ? lastVisit : Date.now();
    const e = map.get(url);
    if (!e) {
      map.set(url, prepare({ url, title: t, visits: v, lastVisit: at }));
      return 'added';
    }
    if (mode === 'visit') {
      e.visits += 1;
      if (at >= e.lastVisit) { e.lastVisit = at; if (t) e.title = t; }
    } else { // merge: keep the best of both
      const newer = at > e.lastVisit;
      e.visits = Math.max(e.visits, v);
      e.lastVisit = Math.max(e.lastVisit, at);
      if (t && (newer || !e.title)) e.title = t;
    }
    prepare(e);
    return 'updated';
  }

  function publicEntry(e, score) {
    const o = { url: e.url, title: e.title, visits: e.visits, lastVisit: e.lastVisit };
    if (score !== undefined) o.score = score;
    return o;
  }

  return {
    async load() {
      let parsed;
      try {
        parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('[history] could not read history.json:', err.code || err.message);
        return;
      }
      const rows = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
      for (const r of rows) {
        if (!Array.isArray(r)) continue;
        upsert({ url: r[0], title: r[1], visits: r[2], lastVisit: r[3] }, 'merge');
      }
      prune();
    },

    add({ url, title, at = Date.now() } = {}) {
      if (upsert({ url, title, visits: 1, lastVisit: at }, 'visit') === null) return false;
      prune();
      schedule();
      return true;
    },

    updateTitle(url, title) {
      const e = map.get(url);
      const t = cleanTitle(title);
      if (!e || !t || e.title === t) return;
      e.title = t;
      prepare(e);
      schedule();
    },

    search(query, limit = 8) {
      const q = normalizeQuery(query);
      if (!q || !(limit > 0)) return [];
      const terms = q.split(' ');
      const n = terms.length;
      const first = terms[0];
      // A single letter only matches at the start of a word or host.
      const single = n === 1 && first.length === 1 && isWordChar(first);
      const now = Date.now();
      const top = [];
      let min = -1; // score of the worst kept item once `top` is full
      for (const e of map.values()) {
        if (single) {
          if (!e.initials.includes(first)) continue;
        } else {
          const hay = e.hay;
          if (!hay.includes(first)) continue;
          let ok = true;
          for (let i = 1; i < n; i++) if (!hay.includes(terms[i])) { ok = false; break; }
          if (!ok) continue;
        }
        const f = frecency(e, now);
        if (f * MAX_QUALITY <= min) continue; // cannot beat the worst kept result
        let quality = 0;
        for (let i = 0; i < n; i++) quality += termQuality(e, terms[i]);
        const score = (quality / n) * f;
        if (score <= min) continue;
        pushTop(top, { e, score }, 'score', limit);
        if (top.length >= limit) min = top[top.length - 1].score;
      }
      return top.map((x) => publicEntry(x.e, Math.round(x.score * 1000) / 1000));
    },

    recent(limit = 50) {
      const top = [];
      for (const e of map.values()) pushTop(top, e, 'lastVisit', limit);
      return top.map((e) => publicEntry(e));
    },

    remove(url) {
      if (map.delete(url)) schedule();
    },

    clear() {
      if (map.size === 0) return;
      map.clear();
      schedule();
    },

    importMany(entries) {
      let added = 0, updated = 0, skipped = 0;
      for (const it of entries || []) {
        const r = it ? upsert({ url: it.url, title: it.title, visits: it.visits, lastVisit: it.lastVisit }, 'merge') : null;
        if (r === 'added') added++; else if (r === 'updated') updated++; else skipped++;
      }
      prune();
      if (added || updated) schedule();
      return { added, updated, skipped };
    },

    size() { return map.size; },

    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      await save();
      await chain;
    },
  };
}

module.exports = { createHistory, MAX_ENTRIES };
