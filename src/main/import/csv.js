'use strict';
// Import passwords from a CSV export (agent A).
// Google Password Manager / Chrome: name,url,username,password,note
// Also understood: Firefox (url,username,password,...,timePasswordChanged),
// Bitwarden (login_uri,login_username,login_password,type), and the common
// "Title,URL,Username,Password" style of other managers.
// Never logs; error messages never contain row data.

const fsp = require('node:fs/promises');

const MAX_BYTES = 32 * 1024 * 1024;

// RFC 4180-ish: quoted fields with "" escapes, commas and newlines inside
// quotes, CRLF / LF / CR line ends, optional UTF-8 BOM.
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

const URL_COLS = ['url', 'login_uri', 'login url', 'website', 'web site', 'uri', 'origin', 'hostname'];
const USER_COLS = ['username', 'login_username', 'user name', 'login name', 'login', 'user', 'email', 'e-mail'];
const PASS_COLS = ['password', 'login_password'];
const TIME_COLS = ['timepasswordchanged']; // Firefox, ms since epoch

function columnIndex(header, names) {
  for (const name of names) {
    const i = header.indexOf(name);
    if (i !== -1) return i;
  }
  return -1;
}

function firstUrl(value) {
  for (const part of String(value || '').split(/[\n,]/)) {
    const v = part.trim();
    if (!v) continue;
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : 'https://' + v);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
    } catch { /* next */ }
  }
  return null;
}

// -> { added, updated, skipped }. Throws a readable Error for unusable files
// and the vault's error when it cannot store passwords.
async function importPasswordsCsv(filePath, vault) {
  const st = await fsp.stat(filePath);
  if (st.size > MAX_BYTES) throw new Error('This file is too large to be a password export.');
  const rows = parseCsv(await fsp.readFile(filePath, 'utf8'));
  if (!rows.length) throw new Error('The CSV file is empty.');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const iUrl = columnIndex(header, URL_COLS);
  const iUser = columnIndex(header, USER_COLS);
  const iPass = columnIndex(header, PASS_COLS);
  const iTime = columnIndex(header, TIME_COLS);
  const iType = header.indexOf('type'); // Bitwarden: login | note | card | identity
  if (iUrl === -1 || iPass === -1) {
    throw new Error('This CSV does not look like a password export (it needs "url" and "password" columns).');
  }
  const entries = [];
  let skipped = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (iType !== -1 && row[iType] && row[iType].trim().toLowerCase() !== 'login') { skipped++; continue; }
    const url = firstUrl(row[iUrl]);
    const password = row[iPass] || '';
    if (!url || !password) { skipped++; continue; }
    const e = { url, username: iUser !== -1 ? (row[iUser] || '').trim() : '', password };
    const t = iTime !== -1 ? Number(row[iTime]) : NaN;
    if (Number.isFinite(t) && t > 0) e.updated = t;
    entries.push(e);
  }
  const res = vault.importMany(entries);
  entries.length = 0;
  if (typeof vault.flush === 'function') await vault.flush();
  return { added: res.added, updated: res.updated, skipped: res.skipped + skipped };
}

module.exports = { importPasswordsCsv, parseCsv };
