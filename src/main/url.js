'use strict';
// What the user typed in the command bar -> a URL to load, or a Google search;
// what the command line asks to open; what a page may open.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SEARCH = 'https://www.google.com/search?q=';

const SCHEMES = /^(https?|file|about|supernova|chrome|view-source|data|blob|mailto|ftp):/i;
const TLD = /^[a-z][a-z0-9-]{1,62}$/i;
// File extensions that are not top-level domains: "notes.txt" is a search.
const NOT_TLD = new Set(('txt js mjs cjs py pdf jpg jpeg png gif webp exe json css cpp hpp java html htm sh rs log csv ' +
  'mp3 mp4 mkv webm svg xml yml yaml toml ini conf cfg tar gz xz zst rar iso deb rpm dll so o c h kt rb php lua sql ' +
  'wav flac doc docx xls xlsx ppt pptx odt ods jsx tsx vue scss lock bak tmp md5 sha256').split(' '));

// Names that only exist on a local network (RFC 6762 appendix G, RFC 8375):
// these hosts are reached over http, as typed, like an IP address.
const LOCAL_SUFFIXES = ['local', 'lan', 'home', 'internal', 'intranet', 'corp', 'private', 'localdomain', 'home.arpa'];

function searchUrl(query) {
  return SEARCH + encodeURIComponent(query.trim());
}

function isIPv4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * fixup('youtube.com') -> 'https://youtube.com/'
 * fixup('localhost:8080') -> 'http://localhost:8080/'
 * fixup('how tall is everest') -> Google search
 */
function fixup(input) {
  return fixupNav(input).url;
}

/**
 * Like fixup(), and says whether Supernova chose https itself for an address
 * typed without a scheme ({ url, upgraded: true }): such a load falls back to
 * http once if https fails, as Chrome's HTTPS-Upgrades do. Hosts on the local
 * network and addresses with a port other than 443 are http from the start.
 */
function fixupNav(input) {
  const text = String(input || '').trim();
  const plain = (url) => ({ url, upgraded: false });
  if (!text) return plain(null);
  if (/^view-source:/i.test(text)) return plain(text);
  if (SCHEMES.test(text)) {
    try { return plain(new URL(text).href); } catch { return plain(searchUrl(text)); }
  }
  if (/\s/.test(text)) return plain(searchUrl(text));
  if (text.startsWith('/') || text.startsWith('~/')) {
    const home = process.env.HOME || '';
    return plain('file://' + encodeURI(text.startsWith('~/') ? home + text.slice(1) : text));
  }
  // host[:port][/path] ?
  const m = /^([^/?#:]+|\[[0-9a-f:.]+\])(:\d{1,5})?([/?#].*)?$/i.exec(text);
  if (m) {
    const host = m[1].toLowerCase();
    const local = host === 'localhost' || host.endsWith('.localhost') || isIPv4(host) || host.startsWith('[') ||
      LOCAL_SUFFIXES.some((suffix) => host.endsWith('.' + suffix));
    const tld = host.includes('.') ? host.slice(host.lastIndexOf('.') + 1) : '';
    const looksLikeDomain = host.includes('.') && TLD.test(tld) && !NOT_TLD.has(tld.toLowerCase()) && !host.startsWith('.') && !host.endsWith('.') &&
      host.split('.').every((label) => /^[a-z0-9¡-￿-]+$/i.test(label) && label.length > 0);
    // "intranet:8080" is a host on the local network, as in Chrome.
    const singleLabelWithPort = !host.includes('.') && !!m[2] && /^[a-z0-9-]+$/i.test(host);
    if (local || looksLikeDomain || singleLabelWithPort) {
      // A port other than 443 is a service of its own, usually plain http.
      const http = local || singleLabelWithPort || (m[2] && m[2] !== ':443');
      try { return { url: new URL((http ? 'http://' : 'https://') + text).href, upgraded: !http }; } catch { return plain(searchUrl(text)); }
    }
  }
  return plain(searchUrl(text));
}

/** The text shown for a URL in the UI: host without www, or the whole URL for non-web schemes. */
function displayHost(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname.replace(/^www\./, '');
    if (u.protocol === 'supernova:') return u.hostname || u.pathname.replace(/^\/+/, '');
    return u.protocol.replace(':', '');
  } catch {
    return '';
  }
}

/** If the URL is a Google search results page, the query; else null. */
function searchQueryOf(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/search') return u.searchParams.get('q');
  } catch {}
  return null;
}

function originOf(url) {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

// As a URL parser reads it: tabs and newlines anywhere are dropped, control
// characters and spaces around it too ("java\tscript:" is javascript:).
const cleanUrl = (url) => String(url || '').replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');

const schemeOf = (url) => {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(cleanUrl(url));
  return m ? m[1].toLowerCase() : '';
};

/**
 * Whether a page at `from` may make the browser open `to`: a link it follows,
 * a frame it loads, a window it opens, an entry of its context menu. Internal
 * pages (their API) and local files open only from their own kind, so a web
 * page can reach neither; javascript: URLs are never opened for a page.
 * What the user types in the command bar does not go through here.
 */
function mayOpen(from, to) {
  const target = innerScheme(to);
  if (target === 'javascript') return false;
  if (target === 'supernova' || target === 'file') return innerScheme(from) === target;
  return true;
}

// The scheme that decides: view-source:, blob: and filesystem: wrap another
// URL (view-source:file:///etc/passwd is a file).
function innerScheme(url) {
  let rest = cleanUrl(url);
  for (let i = 0; i < 4; i++) {
    const s = schemeOf(rest);
    if (s !== 'view-source' && s !== 'blob' && s !== 'filesystem') return s;
    rest = cleanUrl(rest.slice(s.length + 1));
  }
  return 'javascript'; // nested deeper than any real URL: refuse
}

/**
 * The browser's own command-line arguments, from process.argv. From source
 * (`appDir` set) the app folder is among them, and Chromium switches may come
 * before it (electron --ozone-platform=headless . url): the folder itself is
 * dropped, not a fixed number of arguments.
 */
function ownArgs(processArgv, appDir = null) {
  const dir = appDir ? path.resolve(appDir) : null;
  return processArgv.slice(1).filter((a) => !dir || String(a).startsWith('-') || path.resolve(String(a)) !== dir);
}

/** What the command line asks to open: URLs, local files, or what to search. */
function urlsFrom(args, cwd = process.cwd()) {
  const out = [];
  for (const a of args) {
    if (!a || a.startsWith('-') || innerScheme(a) === 'javascript') continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a) || SCHEMES.test(a)) { out.push(a); continue; }
    const file = path.resolve(cwd, a);
    // sync-ok: a stat per command-line argument, at start or a second launch
    if (fs.existsSync(file)) { out.push(pathToFileURL(file).href); continue; } // "a b#1.html" stays one file
    const u = fixup(a);
    // "localhost:3000" is an address; "magnet:?xt=…" is left for another app.
    if (u) out.push(u.startsWith(SEARCH) && schemeOf(a) ? a : u);
  }
  return out;
}

module.exports = { fixup, fixupNav, searchUrl, displayHost, searchQueryOf, originOf, mayOpen, ownArgs, urlsFrom };
