'use strict';
// supernova:// pages (settings, error), served from src/pages.

const path = require('path');
const { pathToFileURL } = require('url');

const PAGES = path.join(__dirname, '..', 'pages');

// Each host serves its own page and files, nothing else: the API a page gets
// is decided by its host (internalAllowed), so supernova://settings/error.html
// must not exist.
const ROUTES = {
  settings: { page: 'settings.html', files: ['settings.js', 'pages.css'] },
  error: { page: 'error.html', files: ['error.js', 'pages.css'] },
};

// What each internal page may call through window.supernova.invoke().
const API = {
  settings: null, // all of it
  error: new Set(['theme']),
};

/**
 * Whether the page at `senderUrl` (the calling frame's URL, never something it
 * sent) may call the internal API's `name`.
 */
function internalAllowed(senderUrl, name) {
  let u;
  try { u = new URL(senderUrl); } catch { return false; }
  if (u.protocol !== 'supernova:' || !Object.prototype.hasOwnProperty.call(ROUTES, u.hostname)) return false;
  if (!(u.pathname === '/' || u.pathname === '')) return false;
  if (u.username || u.password || u.port) return false;
  const allowed = API[u.hostname];
  return allowed === null || allowed.has(name);
}

// Electron takes one registerSchemesAsPrivileged() call per run, so every
// scheme of ours goes into it: supernova:// and the ad blocker's surrogate
// scheme (extra), which needs CORS and CSP bypass for redirected requests.
function registerScheme(protocol, extra = []) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'supernova', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ...extra.map((s) => ({ scheme: s.scheme, privileges: { ...s.privileges } })),
  ]);
}

function handlerFor(net) {
  return (request) => {
    const u = new URL(request.url);
    const host = u.hostname;
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    let file;
    const route = Object.prototype.hasOwnProperty.call(ROUTES, host) ? ROUTES[host] : null;
    if (!route) return new Response('Not found', { status: 404 });
    if (!rel || rel === 'index.html') {
      file = path.join(PAGES, route.page);
    } else if (route.files.includes(rel)) {
      file = path.join(PAGES, rel);
    } else {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).href);
  };
}

function attach(session, net) {
  if (!session.protocol.isProtocolHandled('supernova')) session.protocol.handle('supernova', handlerFor(net));
}

module.exports = { registerScheme, attach, handlerFor, internalAllowed };
