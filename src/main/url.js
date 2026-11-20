'use strict';
// What the user typed in the command bar -> a URL to load, or a Google search.

const SEARCH = 'https://www.google.com/search?q=';

const SCHEMES = /^(https?|file|about|supernova|chrome|view-source|data|blob|mailto|ftp):/i;
const TLD = /^[a-z][a-z0-9-]{1,62}$/i;
// File extensions that are not top-level domains: "notes.txt" is a search.
const NOT_TLD = new Set(('txt js mjs cjs py pdf jpg jpeg png gif webp exe json css cpp hpp java html htm sh rs log csv ' +
  'mp3 mp4 mkv webm svg xml yml yaml toml ini conf cfg tar gz xz zst rar iso deb rpm dll so o c h kt rb php lua sql ' +
  'wav flac doc docx xls xlsx ppt pptx odt ods jsx tsx vue scss lock bak tmp md5 sha256').split(' '));

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
  const text = String(input || '').trim();
  if (!text) return null;
  if (/^view-source:/i.test(text)) return text;
  if (SCHEMES.test(text)) {
    try { return new URL(text).href; } catch { return searchUrl(text); }
  }
  if (/\s/.test(text)) return searchUrl(text);
  if (text.startsWith('/') || text.startsWith('~/')) {
    const home = process.env.HOME || '';
    return 'file://' + encodeURI(text.startsWith('~/') ? home + text.slice(1) : text);
  }
  // host[:port][/path] ?
  const m = /^([^/?#:]+|\[[0-9a-f:.]+\])(:\d{1,5})?([/?#].*)?$/i.exec(text);
  if (m) {
    const host = m[1].toLowerCase();
    const local = host === 'localhost' || host.endsWith('.localhost') || isIPv4(host) || host.startsWith('[');
    const tld = host.includes('.') ? host.slice(host.lastIndexOf('.') + 1) : '';
    const looksLikeDomain = host.includes('.') && TLD.test(tld) && !NOT_TLD.has(tld.toLowerCase()) && !host.startsWith('.') && !host.endsWith('.') &&
      host.split('.').every((label) => /^[a-z0-9¡-￿-]+$/i.test(label) && label.length > 0);
    // "intranet:8080" is a host on the local network, as in Chrome.
    const singleLabelWithPort = !host.includes('.') && !!m[2] && /^[a-z0-9-]+$/i.test(host);
    if (local || looksLikeDomain || singleLabelWithPort) {
      const scheme = local || singleLabelWithPort ? 'http://' : 'https://';
      try { return new URL(scheme + text).href; } catch { return searchUrl(text); }
    }
  }
  return searchUrl(text);
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

module.exports = { fixup, searchUrl, displayHost, searchQueryOf, originOf };
