'use strict';
// supernova:// pages (settings, error), served from src/pages.

const path = require('path');
const { pathToFileURL } = require('url');

const PAGES = path.join(__dirname, '..', 'pages');
const SHARED = path.join(__dirname, '..', 'ui');

const ROUTES = {
  settings: 'settings.html',
  error: 'error.html',
};

function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'supernova', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

function handlerFor(net) {
  return (request) => {
    const u = new URL(request.url);
    const host = u.hostname;
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    let file;
    if (!rel || rel === 'index.html') {
      if (!ROUTES[host]) return new Response('Not found', { status: 404 });
      file = path.join(PAGES, ROUTES[host]);
    } else if (rel.startsWith('shared/')) {
      file = path.join(SHARED, rel.slice(7));
      if (!file.startsWith(SHARED + path.sep)) return new Response('Not found', { status: 404 });
    } else {
      file = path.join(PAGES, rel);
      if (!file.startsWith(PAGES + path.sep)) return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).href);
  };
}

function attach(session, net) {
  if (!session.protocol.isProtocolHandled('supernova')) session.protocol.handle('supernova', handlerFor(net));
}

module.exports = { registerScheme, attach };
