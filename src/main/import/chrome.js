'use strict';
// Import from Chrome / Chromium / Brave / Vivaldi / Edge profiles on Linux
// (agent A). No electron here: vault, stores, cookies and secretLookup are
// injected.
//
// SQLite files are read through the sqlite3 CLI (-json) on a private copy in
// a temp dir, because the browser may be running and holding a lock.
// Decrypted values only ever live in memory; nothing here logs, and error
// strings never contain entry data.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { normalizeOrigin } = require('../passwords');

const BROWSERS = [
  { browser: 'chrome', sub: 'google-chrome', secrets: ['chrome'] },
  { browser: 'chromium', sub: 'chromium', secrets: ['chromium'] },
  { browser: 'brave', sub: path.join('BraveSoftware', 'Brave-Browser'), secrets: ['brave'] },
  // Vivaldi and Edge on Linux have been seen using the Chrome/Chromium
  // keyring entries; try their own name first.
  { browser: 'vivaldi', sub: 'vivaldi', secrets: ['vivaldi', 'chrome'] },
  { browser: 'edge', sub: 'microsoft-edge', secrets: ['microsoft-edge', 'chromium'] },
];

const HISTORY_LIMIT = 20000;
const IV = Buffer.alloc(16, 0x20); // 16 spaces
const CHUNK = 500;                 // yield to the event loop between chunks
const EPOCH_DELTA_MS = 11644473600000; // 1601-01-01 -> 1970-01-01

let sqliteBin = null;
function sqlite3Path() {
  if (!sqliteBin) sqliteBin = fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';
  return sqliteBin;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ---------- detection (synchronous, small reads only) ----------

function readJsonSync(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function profileSort(a, b) {
  const n = (s) => (s === 'Default' ? -1 : Number(s.slice(8)));
  return n(a) - n(b);
}

function countBookmarkNodes(json) {
  let n = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'url') { if (isImportableUrl(node.url)) n++; return; }
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  const roots = (json && json.roots) || {};
  for (const k of ['bookmark_bar', 'other', 'synced']) walk(roots[k]);
  return n;
}

function countPasswordsSync(dir) {
  let total = null;
  for (const name of ['Login Data', 'Login Data For Account']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      // Read-only and lock-free on the live file: good enough for a count.
      const uri = pathToFileURL(file).href + '?immutable=1';
      const out = execFileSync(sqlite3Path(), ['-init', '/dev/null', '-readonly', uri,
        'SELECT count(*) FROM logins WHERE blacklisted_by_user = 0 AND length(password_value) > 0;'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      const n = parseInt(out, 10);
      if (Number.isFinite(n)) total = (total || 0) + n;
    } catch { /* unknown */ }
  }
  return total;
}

// -> [{ browser, name, dir, passwords: n|null, bookmarks: n|null }]
// Options are for tests only (default: $XDG_CONFIG_HOME or ~/.config).
function detectProfiles({ configDir } = {}) {
  const base = configDir || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const out = [];
  for (const b of BROWSERS) {
    const root = path.join(base, b.sub);
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    const localState = readJsonSync(path.join(root, 'Local State'));
    const info = (localState && localState.profile && localState.profile.info_cache) || {};
    for (const d of names.filter((n) => n === 'Default' || /^Profile \d+$/.test(n)).sort(profileSort)) {
      const dir = path.join(root, d);
      const hasData = ['Login Data', 'Bookmarks', 'History', 'Preferences'].some((f) => fs.existsSync(path.join(dir, f)));
      if (!hasData) continue;
      const bm = readJsonSync(path.join(dir, 'Bookmarks'));
      const display = info[d] && typeof info[d].name === 'string' && info[d].name.trim() ? info[d].name.trim() : d;
      out.push({
        browser: b.browser,
        name: display,
        dir,
        passwords: countPasswordsSync(dir),
        bookmarks: bm ? countBookmarkNodes(bm) : null,
      });
    }
  }
  return out;
}

// ---------- sqlite helpers ----------

function sqliteJson(db, sql) {
  return new Promise((resolve, reject) => {
    execFile(sqlite3Path(), ['-init', '/dev/null', '-bail', '-json', db, sql],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, timeout: 120000 },
      (err, stdout, stderr) => {
        if (err) {
          const why = String(stderr || '').split('\n').find((l) => l.trim()) || (err.code === 'ENOENT' ? 'sqlite3 is not installed' : 'sqlite3 failed');
          reject(new Error(why.replace(/^(Error|Parse error)[^:]*:\s*/i, '').slice(0, 160)));
          return;
        }
        try { resolve(stdout.trim() ? JSON.parse(stdout) : []); } catch { reject(new Error('unreadable sqlite3 output')); }
      });
  });
}

async function columns(db, table) {
  const rows = await sqliteJson(db, `SELECT name FROM pragma_table_info('${table}');`);
  return new Set(rows.map((r) => r.name));
}

// Copy a SQLite file (plus its WAL / rollback journal) into tmp.
async function copyDb(src, tmp, name) {
  try { await fsp.access(src); } catch { return null; }
  const dst = path.join(tmp, name);
  await fsp.copyFile(src, dst);
  for (const suffix of ['-wal', '-journal']) {
    try { await fsp.copyFile(src + suffix, dst + suffix); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return dst;
}

// ---------- crypto ----------

function deriveKey(password) {
  return crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), 'saltysalt', 1, 16, 'sha1');
}

function aesDecrypt(key, body) {
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, IV);
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    return null;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
function toText(buf) {
  try { return utf8.decode(buf); } catch { return null; }
}

function createKeys(browser, secretLookup) {
  const keys = { v10: deriveKey('peanuts'), empty: deriveKey(''), v11: undefined, looked: false };
  keys.loadV11 = async () => {
    if (keys.looked) return keys.v11;
    keys.looked = true;
    keys.v11 = null;
    if (typeof secretLookup !== 'function') return null;
    const b = BROWSERS.find((x) => x.browser === browser);
    const apps = b ? b.secrets : ['chrome', 'chromium'];
    for (const application of apps) {
      let pass = null;
      try { pass = await secretLookup({ application }); } catch { pass = null; }
      if (typeof pass === 'string' && pass.length) {
        keys.v11 = deriveKey(pass.replace(/\r?\n$/, ''));
        break;
      }
    }
    return keys.v11;
  };
  return keys;
}

// -> Buffer (plaintext) or null. v10 = 'peanuts'; v11 = keyring password
// (some old builds used an empty one).
function decryptBlob(buf, keys) {
  if (!buf || buf.length < 19) return null;
  const prefix = buf.toString('latin1', 0, 3);
  const body = buf.subarray(3);
  if (body.length % 16) return null;
  if (prefix === 'v10') return aesDecrypt(keys.v10, body);
  if (prefix === 'v11') return (keys.v11 && aesDecrypt(keys.v11, body)) || aesDecrypt(keys.empty, body);
  return null;
}

const hasV11 = (rows, field) => rows.some((r) => typeof r[field] === 'string' && r[field].startsWith('763131')); // hex('v11')

function chromeTimeToMs(v) {
  // Chrome stores microseconds since 1601 as a decimal string in JSON files.
  if (typeof v !== 'string' || !/^\d{1,20}$/.test(v) || v === '0') return undefined;
  const ms = Number(BigInt(v) / 1000n - BigInt(EPOCH_DELTA_MS));
  return ms > 0 ? ms : undefined;
}

function isImportableUrl(url) {
  return typeof url === 'string' && /^https?:\/\/[^/?#\s]/i.test(url);
}

// ---------- the four imports ----------

async function importPasswords(dir, tmp, keys, vault, result) {
  const stats = { added: 0, updated: 0, skipped: 0, failed: 0 };
  result.passwords = stats;
  const avail = vault.available();
  if (!avail.ok) {
    result.errors.push('Passwords were not imported: ' + avail.reason);
    return;
  }
  const entries = [];
  let v11Missing = 0;
  let found = false;
  for (const [file, name] of [['Login Data', 'login.db'], ['Login Data For Account', 'login-account.db']]) {
    const db = await copyDb(path.join(dir, file), tmp, name);
    if (!db) continue;
    found = true;
    const cols = await columns(db, 'logins');
    const when = cols.has('date_password_modified')
      ? '(CASE WHEN date_password_modified > 0 THEN date_password_modified ELSE date_created END)'
      : 'date_created';
    const rows = await sqliteJson(db,
      `SELECT origin_url AS o, signon_realm AS r, username_value AS u, hex(password_value) AS p,
              ${when} / 1000 - ${EPOCH_DELTA_MS} AS t
         FROM logins WHERE blacklisted_by_user = 0 AND length(password_value) > 0;`);
    if (hasV11(rows, 'p')) await keys.loadV11();
    for (let i = 0; i < rows.length; i++) {
      if (i && i % CHUNK === 0) await tick();
      const r = rows[i];
      const origin = normalizeOrigin(r.r) || normalizeOrigin(r.o);
      if (!origin) { stats.skipped++; continue; } // android://, federated, ...
      const isV11 = r.p.startsWith('763131');
      const plain = decryptBlob(Buffer.from(r.p, 'hex'), keys);
      const password = plain && toText(plain);
      if (!password) {
        stats.failed++;
        if (isV11 && !keys.v11) v11Missing++;
        continue;
      }
      entries.push({ origin, username: typeof r.u === 'string' ? r.u : '', password, updated: r.t > 0 ? r.t : undefined });
    }
  }
  if (!found) { result.errors.push('Passwords: this profile has no Login Data.'); return; }
  if (v11Missing) result.errors.push(`Passwords: ${v11Missing} could not be decrypted because the browser's key was not found in the keyring.`);
  else if (stats.failed) result.errors.push(`Passwords: ${stats.failed} could not be decrypted.`);
  const r = vault.importMany(entries);
  entries.length = 0;
  stats.added = r.added;
  stats.updated = r.updated;
  stats.skipped += r.skipped;
}

async function readBookmarksJson(dir, keys) {
  const lists = [];
  for (const name of ['Bookmarks', 'AccountBookmarks']) {
    try { lists.push(JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'))); } catch { /* absent */ }
  }
  if (!lists.length) {
    // Newer Chrome also writes an os_crypt-encrypted copy; use it only when
    // the plain file is gone.
    try {
      const buf = await fsp.readFile(path.join(dir, 'EncryptedBookmarks2'));
      if (buf.toString('latin1', 0, 3) === 'v11') await keys.loadV11();
      const plain = decryptBlob(buf, keys);
      const text = plain && toText(plain);
      if (text) lists.push(JSON.parse(text));
    } catch { /* absent or unreadable */ }
  }
  return lists;
}

async function importBookmarks(dir, keys, bookmarks, result) {
  const lists = await readBookmarksJson(dir, keys);
  if (!lists.length) {
    result.bookmarks = { added: 0, skipped: 0 };
    result.errors.push('Bookmarks: this profile has no bookmarks file.');
    return;
  }
  const items = [];
  let skipped = 0;
  const walk = (node, folder) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'url') {
      if (isImportableUrl(node.url)) items.push({ url: node.url, title: node.name || '', folder, added: chromeTimeToMs(node.date_added) });
      else skipped++;
      return;
    }
    if (!Array.isArray(node.children)) return;
    const name = typeof node.name === 'string' ? node.name.trim() : '';
    const sub = folder === null ? name : (name ? (folder ? folder + '/' + name : name) : folder);
    for (const c of node.children) walk(c, sub);
  };
  for (const json of lists) {
    const roots = (json && json.roots) || {};
    for (const k of ['bookmark_bar', 'other', 'synced']) walk(roots[k], null);
  }
  const r = bookmarks.importMany(items);
  result.bookmarks = { added: r.added, skipped: r.skipped + skipped };
}

async function importHistory(dir, tmp, history, result) {
  const db = await copyDb(path.join(dir, 'History'), tmp, 'history.db');
  if (!db) {
    result.history = { added: 0, updated: 0, skipped: 0 };
    result.errors.push('History: this profile has no History file.');
    return;
  }
  const rows = await sqliteJson(db,
    `SELECT url AS u, title AS t, visit_count AS v, last_visit_time / 1000 - ${EPOCH_DELTA_MS} AS l
       FROM urls
      WHERE hidden = 0 AND visit_count > 0 AND (url LIKE 'http://%' OR url LIKE 'https://%')
      ORDER BY visit_count DESC, last_visit_time DESC
      LIMIT ${HISTORY_LIMIT};`);
  const stats = { added: 0, updated: 0, skipped: 0 };
  for (let i = 0; i < rows.length; i += CHUNK * 4) {
    const chunk = rows.slice(i, i + CHUNK * 4).map((r) => ({ url: r.u, title: r.t || '', visits: r.v, lastVisit: r.l > 0 ? r.l : undefined }));
    const r = history.importMany(chunk);
    stats.added += r.added; stats.updated += r.updated; stats.skipped += r.skipped || 0;
    await tick();
  }
  result.history = stats;
}

const SAMESITE = { '-1': 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' };

async function importCookies(dir, tmp, keys, cookies, result) {
  const stats = { added: 0, skipped: 0, failed: 0 };
  result.cookies = stats;
  let src = path.join(dir, 'Network', 'Cookies');
  if (!fs.existsSync(src)) src = path.join(dir, 'Cookies');
  const db = await copyDb(src, tmp, 'cookies.db');
  if (!db) { result.errors.push('Cookies: this profile has no Cookies file.'); return; }

  const meta = await sqliteJson(db, "SELECT value AS v FROM meta WHERE key = 'version';");
  const version = meta.length ? parseInt(meta[0].v, 10) || 0 : 0;
  const cols = await columns(db, 'cookies');
  const partition = cols.has('top_frame_site_key') ? 'top_frame_site_key' : "''";
  const rows = await sqliteJson(db,
    `SELECT host_key AS h, name AS n, value AS v, hex(encrypted_value) AS e, path AS p,
            CASE WHEN has_expires != 0 AND is_persistent != 0 AND expires_utc > 0
                 THEN expires_utc / 1000000 - ${EPOCH_DELTA_MS / 1000} ELSE 0 END AS x,
            is_secure AS s, is_httponly AS ho, samesite AS ss, ${partition} AS tf
       FROM cookies;`);
  if (hasV11(rows, 'e')) await keys.loadV11();

  const nowSec = Date.now() / 1000;
  let v11Missing = 0;
  const batch = [];
  const flushBatch = async () => {
    const results = await Promise.allSettled(batch.map((d) => cookies.set(d)));
    for (const r of results) { if (r.status === 'fulfilled') stats.added++; else stats.failed++; }
    batch.length = 0;
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.x > 0 && r.x <= nowSec) { stats.skipped++; continue; } // expired
    if (r.tf) { stats.skipped++; continue; } // partitioned (CHIPS): cannot be set unpartitioned safely
    const host = String(r.h || '');
    if (!host || /[\s/]/.test(host)) { stats.failed++; continue; }
    let value = typeof r.v === 'string' ? r.v : '';
    if (!value && r.e) {
      const plain = decryptBlob(Buffer.from(r.e, 'hex'), keys);
      let body = plain;
      if (plain && version >= 24) {
        const digest = crypto.createHash('sha256').update(host, 'utf8').digest();
        body = plain.length >= 32 && plain.subarray(0, 32).equals(digest) ? plain.subarray(32) : null;
      }
      value = body ? toText(body) : null;
      if (value === null) {
        stats.failed++;
        if (r.e.startsWith('763131') && !keys.v11) v11Missing++;
        continue;
      }
    }
    const secure = !!r.s;
    const cookiePath = typeof r.p === 'string' && r.p.startsWith('/') ? r.p : '/';
    const details = {
      url: (secure ? 'https://' : 'http://') + host.replace(/^\./, '') + cookiePath,
      name: String(r.n || ''),
      value,
      path: cookiePath,
      secure,
      httpOnly: !!r.ho,
      sameSite: SAMESITE[r.ss] || 'unspecified',
    };
    if (host.startsWith('.')) details.domain = host; // host-only cookies get no domain
    if (r.x > 0) details.expirationDate = r.x;
    batch.push(details);
    if (batch.length >= 64) await flushBatch();
  }
  if (batch.length) await flushBatch();
  rows.length = 0;
  if (typeof cookies.flushStore === 'function') { try { await cookies.flushStore(); } catch { /* ignore */ } }
  if (v11Missing) result.errors.push(`Cookies: ${v11Missing} could not be decrypted because the browser's key was not found in the keyring.`);
  else if (stats.failed) result.errors.push(`Cookies: ${stats.failed} could not be imported.`);
}

// importProfile(profile, { what, vault, bookmarks, history, cookies, secretLookup })
// -> { passwords, bookmarks, history, cookies, errors: [] }
// Each part is null when not requested, else counts:
// passwords { added, updated, skipped, failed }, bookmarks { added, skipped },
// history { added, updated, skipped }, cookies { added, skipped, failed }.
async function importProfile(profile, opts = {}) {
  const { what, vault, bookmarks, history, cookies, secretLookup } = opts;
  const want = (k) => (what ? !!what[k] : true);
  const result = { passwords: null, bookmarks: null, history: null, cookies: null, errors: [] };
  const dir = profile && profile.dir;
  if (!dir || !fs.existsSync(dir)) {
    result.errors.push('The profile folder was not found.');
    return result;
  }
  const keys = createKeys(profile.browser, secretLookup);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'supernova-import-'));
  const step = async (name, fn) => {
    try { await fn(); } catch (err) {
      result.errors.push(`${name[0].toUpperCase()}${name.slice(1)}: ${err && err.message ? err.message : 'failed'}`);
    }
  };
  try {
    if (want('passwords') && vault) await step('passwords', () => importPasswords(dir, tmp, keys, vault, result));
    if (want('bookmarks') && bookmarks) await step('bookmarks', () => importBookmarks(dir, keys, bookmarks, result));
    if (want('history') && history) await step('history', () => importHistory(dir, tmp, history, result));
    if (want('cookies') && cookies) await step('cookies', () => importCookies(dir, tmp, keys, cookies, result));
  } finally {
    keys.v11 = keys.v10 = keys.empty = null;
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  for (const store of [vault, bookmarks, history]) {
    if (store && typeof store.flush === 'function') { try { await store.flush(); } catch { /* reported by the store */ } }
  }
  return result;
}

module.exports = {
  detectProfiles,
  importProfile,
  // exposed for tests
  _internal: { deriveKey, decryptBlob, chromeTimeToMs },
};
