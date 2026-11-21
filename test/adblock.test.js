'use strict';
// Ad blocking through createAdblock's public API, with no network: filter lists
// and resources.json come from test/fixtures/adblock through an injected fetch,
// Electron's session / webContents / ipcMain are small fakes, settings are a
// real JsonStore in a temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAdblock, SCHEME } = require('../src/main/adblock');
const { JsonStore } = require('../src/main/store');

const FIXTURES = path.join(__dirname, 'fixtures', 'adblock');
const BASE = 'https://lists.test/';
const RESOURCES = `${BASE}resources.json`;
const LISTS = {
  'ads-tracking': [`${BASE}ads.txt`, `${BASE}privacy.txt`],
  full: [`${BASE}ads.txt`, `${BASE}privacy.txt`, `${BASE}annoyances.txt`],
};
// The channels of @ghostery/adblocker-electron-preload (the page side).
const COSMETICS = '@ghostery/adblocker/inject-cosmetic-filters';
const OBSERVER = '@ghostery/adblocker/is-mutation-observer-enabled';
const SETTINGS_DEFAULTS = { 'adblock.enabled': true, 'adblock.allowlist': [], 'adblock.cookieBanners': false };
const DAY = 24 * 60 * 60 * 1000;

// Nothing in this file may reach the real network.
const realFetch = globalThis.fetch;
const leaked = [];
globalThis.fetch = async (url) => {
  leaked.push(String(url));
  throw new Error('real network used in a test');
};
test.after(() => {
  globalThis.fetch = realFetch;
  assert.deepEqual(leaked, [], 'a test used the real network');
});

// ----- fakes ----------------------------------------------------------------------

/** fetch over the fixture files. `offline` rejects like a dead network,
 *  `hold` parks every request until release() (or its abort signal). */
function fakeNet() {
  const files = new Map(fs.readdirSync(FIXTURES).map((f) => [BASE + f, fs.readFileSync(path.join(FIXTURES, f), 'utf8')]));
  const parked = [];
  const net = {
    calls: [],
    offline: false,
    hold: false,
    files,
    fetch(url, { signal } = {}) {
      url = String(url);
      net.calls.push(url);
      const answer = () => {
        if (net.offline) throw new TypeError('fetch failed');
        const body = files.get(url);
        return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
      };
      if (!net.hold) return Promise.resolve().then(answer);
      return new Promise((resolve, reject) => {
        parked.push(() => { try { resolve(answer()); } catch (err) { reject(err); } });
        if (signal) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    release() {
      net.hold = false;
      for (const go of parked.splice(0)) go();
    },
    /** Builds that got as far as downloading resources.json (once per build). */
    builds: () => net.calls.filter((u) => u === RESOURCES).length,
    fetched: (name) => net.calls.filter((u) => u === BASE + name).length,
  };
  return net;
}

/** ipcMain: handle() throws on a second handler, like Electron's. */
function fakeIpcMain() {
  const handlers = new Map();
  const ipc = {
    handlers,
    handleCalls: 0,
    handle(channel, fn) {
      ipc.handleCalls += 1;
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      handlers.set(channel, fn);
    },
    removeHandler(channel) { handlers.delete(channel); },
    invoke(channel, event, ...args) {
      const fn = handlers.get(channel);
      assert.ok(fn, `no ipcMain handler for ${channel}`);
      return Promise.resolve(fn(event, ...args));
    },
  };
  return ipc;
}

/** The parts of Electron's Session that ad blocking uses. */
function fakeSession({ persistent = true } = {}) {
  const ses = {
    beforeRequest: null,
    headersReceived: null,
    filters: {},
    preloads: new Map(),
    protocols: new Map(),
    isPersistent: () => persistent,
    webRequest: {
      onBeforeRequest(filter, listener) {
        if (listener === undefined) [filter, listener] = [null, filter];
        ses.beforeRequest = listener || null;
        ses.filters.beforeRequest = filter;
      },
      onHeadersReceived(filter, listener) {
        if (listener === undefined) [filter, listener] = [null, filter];
        ses.headersReceived = listener || null;
        ses.filters.headersReceived = filter;
      },
    },
    registerPreloadScript(script) {
      const id = script.id || `preload-${ses.preloads.size + 1}`;
      if (ses.preloads.has(id)) throw new Error(`preload script ${id} is already registered`);
      ses.preloads.set(id, script);
      return id;
    },
    unregisterPreloadScript(id) { ses.preloads.delete(id); },
    protocol: {
      handle(scheme, fn) {
        if (ses.protocols.has(scheme)) throw new Error(`${scheme} is already handled`);
        ses.protocols.set(scheme, fn);
      },
      unhandle(scheme) { ses.protocols.delete(scheme); },
      isProtocolHandled: (scheme) => ses.protocols.has(scheme),
    },
  };
  return ses;
}

/** A tab's webContents: getURL(), did-navigate on top-level commits, destroyed. */
function fakeTab(id, url = '', ses = null) {
  const wc = new EventEmitter();
  let current = url;
  let destroyed = false;
  wc.id = id;
  wc.session = ses;
  wc.getURL = () => current;
  wc.isDestroyed = () => destroyed;
  wc.navigate = (to) => { current = to; wc.emit('did-navigate', {}, to, 200, 'OK'); };
  wc.navigateInPage = (to) => { current = to; wc.emit('did-navigate-in-page', {}, to, true); };
  wc.destroy = () => { destroyed = true; wc.emit('destroyed'); };
  wc.css = [];
  wc.insertCSS = async (css, opts) => { wc.css.push({ css, opts }); return 'key'; };
  wc.scripts = [];
  wc.executeJavaScript = async (code, gesture) => { wc.scripts.push({ code, gesture }); };
  return wc;
}

let requestId = 0;
/** Run a request through the session's onBeforeRequest listener. */
function send(ses, details) {
  assert.ok(ses.beforeRequest, 'no onBeforeRequest listener on the session');
  return new Promise((resolve) => {
    ses.beforeRequest({ id: ++requestId, method: 'GET', timestamp: Date.now(), referrer: '', resourceType: 'script', ...details }, resolve);
  });
}

/** A subresource request made by the tab's top document. */
function fromTab(tab, url, type = 'script', extra = {}) {
  const top = tab.getURL();
  return { url, resourceType: type, webContentsId: tab.id, webContents: tab, initiatorOrigin: top ? new URL(top).origin : undefined, ...extra };
}

const verdict = (res) => (res.cancel === true ? 'cancel' : res.redirectURL ? 'redirect' : 'pass');

async function waitFor(what, cond, timeoutMs = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-test world: temp dir, fake net and ipcMain, and cleanup (close every
 *  instance, flush every store, remove the dir) after the test. */
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-adblock-test-'));
  const cacheDir = path.join(dir, 'adblock');
  const instances = [];
  const stores = [];
  const logs = [];
  const log = {
    warn: (...a) => logs.push(['warn', a.join(' ')]),
    error: (...a) => logs.push(['error', a.join(' ')]),
    info: (...a) => logs.push(['info', a.join(' ')]),
    log: (...a) => logs.push(['log', a.join(' ')]),
  };
  const w = {
    dir,
    cacheDir,
    logs,
    log,
    net: fakeNet(),
    ipc: fakeIpcMain(),
    settings(values = {}) {
      const store = new JsonStore(path.join(dir, `settings-${stores.length + 1}.json`), SETTINGS_DEFAULTS, { delay: 1 });
      for (const [k, v] of Object.entries(values)) store.set(k, v);
      stores.push(store);
      return store;
    },
    adblock(opts = {}) {
      const a = createAdblock({
        cacheDir,
        settings: 'settings' in opts ? opts.settings : w.settings(),
        fetch: w.net.fetch,
        ipcMain: w.ipc,
        useWorker: false,
        lists: LISTS,
        resourcesUrl: RESOURCES,
        log,
        initTimeoutMs: 2000,
        fetchTimeoutMs: 500,
        fetchRetryMs: 1,
        // Long by default: no refresh fires unless a test asks for one.
        startupDelayMs: DAY,
        retryMs: DAY,
        retryMaxMs: DAY,
        ...opts,
      });
      instances.push(a);
      return a;
    },
    cacheFiles: () => (fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((f) => f.endsWith('.bin')) : []),
  };
  t.after(async () => {
    for (const a of instances) a.close();
    for (const s of stores) await s.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return w;
}

/** An initialised instance attached to a fresh session. */
async function ready(t, opts = {}) {
  const w = world(t);
  const settings = w.settings(opts.values || {});
  const adblock = w.adblock({ settings, ...opts.adblock });
  await adblock.init();
  const ses = fakeSession();
  adblock.attach(ses);
  return { w, adblock, settings, ses };
}

// ----- engine: network, cache, failures -----------------------------------------------

test('init() builds the engine from the lists and caches it; the next start loads the cache without fetching', async (t) => {
  const w = world(t);
  const first = w.adblock();
  await first.init();
  assert.equal(first.stats().ready, true);
  assert.equal(first.stats().source, 'network');
  assert.equal(w.net.builds(), 1);
  assert.deepEqual(w.net.calls.sort(), [...LISTS['ads-tracking'], RESOURCES].sort(), 'only the configured lists');
  assert.equal(w.cacheFiles().length, 1, 'one compiled engine on disk');
  first.close();

  const net2 = fakeNet();
  const second = w.adblock({ fetch: net2.fetch });
  await second.init();
  assert.equal(second.stats().source, 'cache');
  assert.deepEqual(net2.calls, [], 'no download when the cache is good');
  const ses = fakeSession();
  second.attach(ses);
  const tab = fakeTab(1, 'https://news.example/');
  assert.equal(verdict(await send(ses, fromTab(tab, 'https://ads.example/ad.js'))), 'cancel');
});

test('uBO !#if conditions are evaluated as desktop Chromium, from the network and from the cache', async (t) => {
  const w = world(t);
  for (const source of ['network', 'cache']) {
    const a = w.adblock();
    await a.init();
    assert.equal(a.stats().source, source);
    const ses = fakeSession();
    a.attach(ses);
    const tab = fakeTab(1, 'https://news.example/');
    assert.equal(verdict(await send(ses, fromTab(tab, 'https://chromium-only.example/a.js'))), 'cancel', source);
    assert.equal(verdict(await send(ses, fromTab(tab, 'https://firefox-only.example/a.js'))), 'pass', source);
    a.close();
  }
});

test('a corrupt cache file is rebuilt from the lists and replaced, never crashing startup', async (t) => {
  const w = world(t);
  const builder = w.adblock();
  await builder.init();
  builder.close();
  const [file] = w.cacheFiles();
  const good = fs.readFileSync(path.join(w.cacheDir, file));
  const corruptions = {
    empty: Buffer.alloc(0),
    garbage: Buffer.from('this is not a compiled engine\n'.repeat(40)),
    // Just the engine version: deserializes "fine" into an empty engine.
    'version only': good.subarray(0, 2),
    truncated: good.subarray(0, 8),
    'half missing': good.subarray(0, good.length >> 1),
    'flipped byte': (() => { const b = Buffer.from(good); b[b.length >> 1] ^= 0xff; return b; })(),
  };
  for (const [name, bytes] of Object.entries(corruptions)) {
    fs.writeFileSync(path.join(w.cacheDir, file), bytes);
    const net = fakeNet();
    const a = w.adblock({ fetch: net.fetch });
    await a.init();
    assert.equal(a.stats().source, 'network', `${name}: rebuilt from the lists`);
    assert.equal(net.builds(), 1, `${name}: one build`);
    const ses = fakeSession();
    a.attach(ses);
    const tab = fakeTab(1, 'https://news.example/');
    assert.equal(verdict(await send(ses, fromTab(tab, 'https://ads.example/ad.js'))), 'cancel', `${name}: blocking works`);
    a.close();
    const net2 = fakeNet();
    const next = w.adblock({ fetch: net2.fetch });
    await next.init();
    assert.equal(next.stats().source, 'cache', `${name}: the cache was replaced by a good one`);
    assert.deepEqual(net2.calls, []);
    next.close();
  }
});

test('a corrupt cache with the network down: init() resolves, nothing is blocked, the browser starts', async (t) => {
  const w = world(t);
  fs.mkdirSync(w.cacheDir, { recursive: true });
  fs.writeFileSync(path.join(w.cacheDir, 'engine-ads-tracking.bin'), 'garbage');
  w.net.offline = true;
  const a = w.adblock();
  await a.init();
  assert.equal(a.stats().ready, false);
  const ses = fakeSession();
  a.attach(ses);
  const tab = fakeTab(1, 'https://news.example/');
  assert.equal(verdict(await send(ses, fromTab(tab, 'https://ads.example/ad.js'))), 'pass');
  assert.ok(w.logs.some(([level, msg]) => level === 'warn' && /list update failed/.test(msg)), 'the failure is logged');
});

test('network down and no cache: init() resolves with blocking off, then retries with a doubling backoff until the lists arrive', async (t) => {
  const w = world(t);
  w.net.offline = true;
  const clock = Date.now();
  const a = w.adblock({ now: () => clock, startupDelayMs: 1, retryMs: 30, retryMaxMs: 100, updateIntervalMs: DAY });
  await a.init();
  const ses = fakeSession();
  a.attach(ses);
  const tab = fakeTab(1, 'https://news.example/');
  assert.equal(a.stats().ready, false);
  assert.equal(verdict(await send(ses, fromTab(tab, 'https://ads.example/ad.js'))), 'pass', 'nothing blocked without an engine');

  const failed = () => w.logs.filter(([level, msg]) => level === 'warn' && /list update failed/.test(msg)).length;
  const delays = [];
  for (let n = 1; n <= 3; n++) {
    await waitFor(`attempt ${n} to fail`, () => failed() === n && a.stats().nextUpdateAt !== null);
    delays.push(a.stats().nextUpdateAt - clock);
  }
  assert.deepEqual(delays, [30, 60, 100], 'retryMs doubled per failure, capped at retryMaxMs');

  w.net.offline = false;
  await waitFor('the lists to arrive', () => a.stats().ready, 2000);
  assert.equal(a.stats().source, 'network');
  assert.equal(verdict(await send(ses, fromTab(tab, 'https://ads.example/ad.js'))), 'cancel');
  await waitFor('the daily refresh scheduled', () => a.stats().nextUpdateAt !== null);
  assert.equal(a.stats().nextUpdateAt, clock + DAY, 'back to the daily schedule after a success');
});

test('a hanging network holds init() for initTimeoutMs at most; the engine is swapped in when it arrives', async (t) => {
  const w = world(t);
  w.net.hold = true;
  const a = w.adblock({ initTimeoutMs: 40, fetchTimeoutMs: 5000 });
  const ses = fakeSession();
  const t0 = Date.now();
  const keepAlive = setInterval(() => {}, 1000); // the fakes hold no handles of their own
  t.after(() => clearInterval(keepAlive));
  await a.init();
  const waited = Date.now() - t0;
  assert.ok(waited >= 35 && waited < 1000, `init() waited ${waited} ms`);
  a.attach(ses);
  const tab = fakeTab(1, 'https://news.example/');
  assert.equal(verdict(await send(ses, fromTab(tab, 'https://ads.example/ad.js'))), 'pass');
  w.net.release();
  await waitFor('the engine', () => a.stats().ready);
  assert.equal(verdict(await send(ses, fromTab(tab, 'https://ads.example/ad.js'))), 'cancel');
});

test('a failed build stops downloading the remaining lists', async (t) => {
  const w = world(t);
  const many = Array.from({ length: 12 }, (_, i) => `${BASE}missing-${i}.txt`);
  const a = w.adblock({ lists: { 'ads-tracking': many, full: many } });
  await a.init(); // resolves once the build has failed
  assert.equal(a.stats().ready, false);
  const atFailure = w.net.calls.length;
  await sleep(50); // stragglers would keep going here
  assert.equal(w.net.calls.length, atFailure, 'no request after the build failed');
  const files = new Set(w.net.calls).size;
  assert.ok(files <= 4, `${files} different files requested, with 4 connections`);
});

// ----- network blocking --------------------------------------------------------------

test('matching subresources are cancelled, exceptions and everything else pass', async (t) => {
  const { ses } = await ready(t);
  const tab = fakeTab(3, 'https://news.example/article');
  const cases = [
    ['https://ads.example/ad.js', 'script', 'cancel'],
    ['https://cdn.ads.example/banner.png', 'image', 'cancel'],
    ['https://ads.example/frame.html', 'subFrame', 'cancel'],
    ['https://ads.example/allowed.js', 'script', 'pass'], // @@ exception
    ['https://news.example/app.js', 'script', 'pass'],
    ['https://news.example/style.css', 'stylesheet', 'pass'],
    ['wss://ads.example/socket', 'webSocket', 'cancel'],
    ['https://metrics.example/collect', 'xhr', 'cancel'], // from the second list
  ];
  for (const [url, type, want] of cases) {
    assert.equal(verdict(await send(ses, fromTab(tab, url, type))), want, `${type} ${url}`);
  }
});

test('$redirect filters get a surrogate from the adblock scheme instead of a cancel', async (t) => {
  const { ses } = await ready(t);
  const tab = fakeTab(4, 'https://news.example/');
  const js = await send(ses, fromTab(tab, 'https://analytics.example/ga.js', 'script'));
  assert.equal(verdict(js), 'redirect');
  assert.ok(js.redirectURL.startsWith(`${SCHEME.scheme}:`), js.redirectURL);
  const handler = ses.protocols.get(SCHEME.scheme);
  assert.equal(typeof handler, 'function', 'the surrogate scheme is served on the session');

  const res = await handler({ url: js.redirectURL, method: 'GET' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal(await res.text(), '(function(){window.ga=function(){};})();');

  const gif = await send(ses, fromTab(tab, 'https://pixel.example/p.gif', 'image'));
  assert.equal(verdict(gif), 'redirect');
  const img = await handler({ url: gif.redirectURL, method: 'GET' });
  assert.equal(img.headers.get('content-type'), 'image/gif');
  assert.equal(Buffer.from(await img.arrayBuffer()).subarray(0, 6).toString('latin1'), 'GIF89a');

  // Without the per-run secret a page cannot fetch surrogates.
  const forged = await handler({ url: `${SCHEME.scheme}://r/guess/google-analytics_ga.js`, method: 'GET' });
  assert.equal(forged.status, 404);
  // With it, names the library chokes on are a 404, not an exception (an
  // unknown name ending .js gets the library's empty script, by design).
  const prefix = js.redirectURL.slice(0, js.redirectURL.lastIndexOf('/') + 1);
  for (const name of ['__proto__', 'constructor']) {
    const r = await handler({ url: prefix + name, method: 'GET' });
    assert.equal(r.status, 404, name);
  }
  // The same URL as a document is not redirected: plain filters never touch pages.
  assert.equal(verdict(await send(ses, { url: 'https://pixel.example/', resourceType: 'mainFrame', webContentsId: 4, webContents: tab })), 'pass');
});

test('pages are never blocked by plain filters, only by $document ones', async (t) => {
  const { adblock, ses } = await ready(t);
  const tab = fakeTab(5, '');
  const page = (url) => send(ses, { url, resourceType: 'mainFrame', webContentsId: 5, webContents: tab });
  assert.equal(verdict(await page('https://ads.example/')), 'pass', '||ads.example^ hides its resources, not the site');
  assert.equal(verdict(await page('https://tracker.example/')), 'pass');
  assert.equal(verdict(await page('https://news.example/')), 'pass');
  // ||evil.example^$document, also listed hosts-style (||evil.example^) in the second list.
  assert.equal(verdict(await page('https://evil.example/landing')), 'cancel', '$document behind a plain filter');
  assert.equal(verdict(await page('https://www.evil.example/')), 'cancel');
  assert.equal(verdict(await page('https://phish.example/login')), 'cancel', '$doc,subdocument');
  assert.equal(verdict(await page('https://phish.example/help/')), 'pass', '@@||phish.example/help/$document');
  // A negated type ("everything but xhr") never means pages, as in uBO.
  assert.equal(verdict(await page('https://news.example/sponsored/story')), 'pass', '/sponsored/$~xhr');
  tab.navigate('https://news.example/');
  assert.equal(verdict(await send(ses, fromTab(tab, 'https://news.example/sponsored/teaser.png', 'image'))), 'cancel', 'but its images');
  assert.equal(verdict(await send(ses, fromTab(tab, 'https://phish.example/frame', 'subFrame'))), 'cancel');
  // $doc,subdocument is about documents: the site's scripts embedded elsewhere pass.
  assert.equal(verdict(await send(ses, fromTab(tab, 'https://phish.example/x.js'))), 'pass');
  // An allowlisted site is reachable even when a filter names it.
  adblock.setSiteEnabled('evil.example', false);
  assert.equal(verdict(await page('https://evil.example/landing')), 'pass');
});

test('$third-party and $1p options follow the document that made the request', async (t) => {
  const { ses } = await ready(t);
  const news = fakeTab(6, 'https://news.example/');
  const own = fakeTab(7, 'https://www.tracker.example/');
  const shop = fakeTab(8, 'https://www.selfads.example/');
  assert.equal(verdict(await send(ses, fromTab(news, 'https://tracker.example/t.js'))), 'cancel', 'third party');
  assert.equal(verdict(await send(ses, fromTab(own, 'https://tracker.example/t.js'))), 'pass', 'first party on its own site');
  assert.equal(verdict(await send(ses, fromTab(shop, 'https://cdn.selfads.example/x.js'))), 'cancel', '$1p on its own site');
  assert.equal(verdict(await send(ses, fromTab(news, 'https://cdn.selfads.example/x.js'))), 'pass', '$1p elsewhere');
  // A third-party iframe's own requests are judged against the iframe.
  assert.equal(verdict(await send(ses, fromTab(news, 'https://tracker.example/t.js', 'script', { initiatorOrigin: 'https://tracker.example' }))), 'pass');
  // An opaque origin (sandboxed iframe) falls back to the tab's page.
  assert.equal(verdict(await send(ses, fromTab(news, 'https://tracker.example/t.js', 'script', { initiatorOrigin: 'null' }))), 'cancel');
});

test('requests without a tab (service workers) are judged by their initiator, allowlist included', async (t) => {
  const { adblock, ses } = await ready(t);
  const sw = { url: 'https://ads.example/ad.js', resourceType: 'xhr', webContentsId: undefined, initiatorOrigin: 'https://news.example' };
  assert.equal(verdict(await send(ses, sw)), 'cancel');
  adblock.setSiteEnabled('news.example', false);
  assert.equal(verdict(await send(ses, sw)), 'pass');
});

test('$csp filters add a policy to the page, keeping the site\'s own', async (t) => {
  const { adblock, ses } = await ready(t);
  const headers = (url) => new Promise((resolve) => ses.headersReceived({
    url, resourceType: 'mainFrame', responseHeaders: { 'Content-Security-Policy': ["default-src 'self'"], 'Content-Type': ['text/html'] },
  }, resolve));
  const res = await headers('https://csp.example/');
  assert.deepEqual(res.responseHeaders['Content-Security-Policy'], ["default-src 'self'", "worker-src 'none'"]);
  assert.deepEqual(res.responseHeaders['Content-Type'], ['text/html']);
  assert.deepEqual(await headers('https://news.example/'), {}, 'untouched elsewhere');
  adblock.setSiteEnabled('csp.example', false);
  assert.deepEqual(await headers('https://csp.example/'), {}, 'untouched when allowlisted');
});

// ----- per-site allowlist and the global switch ------------------------------------------

test('setSiteEnabled(host, false) lets everything through in that site\'s tabs; true blocks again', async (t) => {
  const { adblock, settings, ses } = await ready(t);
  const news = fakeTab(10, 'https://www.news.example/a');
  const other = fakeTab(11, 'https://blog.example/');
  const ad = (tab, extra) => send(ses, fromTab(tab, 'https://ads.example/ad.js', 'script', extra));

  assert.equal(verdict(await ad(news)), 'cancel');
  adblock.setSiteEnabled('www.news.example', false);
  assert.deepEqual(settings.get('adblock.allowlist'), ['news.example'], 'stored as the registrable domain');
  assert.equal(adblock.isActiveFor('https://www.news.example/a'), false);
  assert.equal(adblock.isActiveFor('https://m.news.example/'), false, 'the whole site');
  assert.equal(adblock.isActiveFor('https://blog.example/'), true);
  assert.equal(verdict(await ad(news)), 'pass');
  assert.equal(verdict(await ad(news, { initiatorOrigin: 'https://ads.example' })), 'pass', 'third-party iframes in that tab too');
  assert.equal(verdict(await ad(other)), 'cancel', 'other tabs still blocked');
  adblock.setSiteEnabled('news.example', false);
  assert.deepEqual(settings.get('adblock.allowlist'), ['news.example'], 'no duplicates');

  adblock.setSiteEnabled('news.example', true);
  assert.deepEqual(settings.get('adblock.allowlist'), []);
  assert.equal(adblock.isActiveFor('https://www.news.example/a'), true);
  assert.equal(verdict(await ad(news)), 'cancel');
});

test('the allowlist follows the tab: navigating to or away from an allowlisted site', async (t) => {
  const { adblock, ses } = await ready(t);
  adblock.setSiteEnabled('news.example', false);
  const tab = fakeTab(12, 'https://blog.example/');
  const ad = () => send(ses, fromTab(tab, 'https://ads.example/ad.js'));
  assert.equal(verdict(await ad()), 'cancel');
  tab.navigate('https://news.example/');
  assert.equal(verdict(await ad()), 'pass');
  tab.navigate('https://blog.example/2');
  assert.equal(verdict(await ad()), 'cancel');
});

test("editing 'adblock.allowlist' in settings applies live", async (t) => {
  const { adblock, settings, ses } = await ready(t);
  const tab = fakeTab(13, 'https://news.example/');
  settings.set('adblock.allowlist', ['news.example']);
  assert.equal(adblock.isActiveFor('https://news.example/'), false);
  assert.equal(verdict(await send(ses, fromTab(tab, 'https://ads.example/ad.js'))), 'pass');
  settings.set('adblock.allowlist', []);
  assert.equal(adblock.isActiveFor('https://news.example/'), true);
  assert.equal(verdict(await send(ses, fromTab(tab, 'https://ads.example/ad.js'))), 'cancel');
});

test("'adblock.enabled' false unhooks every session and stops list updates; true hooks them back", async (t) => {
  const { w, adblock, settings, ses } = await ready(t);
  const priv = fakeSession({ persistent: false });
  adblock.attach(priv);
  for (const s of [ses, priv]) {
    assert.ok(s.beforeRequest && s.headersReceived, 'hooked');
    assert.equal(s.preloads.size, 1, 'cosmetic preload registered');
    assert.ok(s.protocols.has(SCHEME.scheme));
  }
  assert.notEqual(adblock.stats().nextUpdateAt, null, 'a refresh is scheduled');

  settings.set('adblock.enabled', false);
  for (const s of [ses, priv]) {
    assert.equal(s.beforeRequest, null, 'onBeforeRequest removed');
    assert.equal(s.headersReceived, null, 'onHeadersReceived removed');
    assert.equal(s.preloads.size, 0, 'preload removed');
    assert.equal(s.protocols.has(SCHEME.scheme), false, 'surrogate scheme removed');
  }
  assert.equal(adblock.isActiveFor('https://news.example/'), false);
  assert.equal(adblock.stats().nextUpdateAt, null, 'no list downloads while blocking is off');
  const fetchedBefore = w.net.calls.length;

  settings.set('adblock.enabled', true);
  const tab = fakeTab(14, 'https://news.example/');
  for (const s of [ses, priv]) {
    assert.equal(verdict(await send(s, fromTab(tab, 'https://ads.example/ad.js'))), 'cancel');
    assert.equal(s.preloads.size, 1);
    assert.ok(s.protocols.has(SCHEME.scheme));
  }
  assert.equal(adblock.isActiveFor('https://news.example/'), true);
  assert.notEqual(adblock.stats().nextUpdateAt, null, 'the daily refresh is back');
  assert.equal(w.net.calls.length, fetchedBefore, 'turning it back on reuses the loaded engine');
});

test("starting with 'adblock.enabled' false loads nothing until it is turned on", async (t) => {
  const w = world(t);
  const settings = w.settings({ 'adblock.enabled': false });
  const a = w.adblock({ settings });
  await a.init();
  const ses = fakeSession();
  a.attach(ses);
  assert.deepEqual(w.net.calls, []);
  assert.equal(ses.beforeRequest, null);
  assert.equal(a.stats().nextUpdateAt, null);
  settings.set('adblock.enabled', true);
  await waitFor('the engine', () => a.stats().ready);
  const tab = fakeTab(15, 'https://news.example/');
  assert.equal(verdict(await send(ses, fromTab(tab, 'https://ads.example/ad.js'))), 'cancel');
});

test("'adblock.cookieBanners' switches to the full lists, and back from the cache", async (t) => {
  const { w, adblock, settings, ses } = await ready(t);
  const tab = fakeTab(16, 'https://news.example/');
  const banner = () => send(ses, fromTab(tab, 'https://cookie-banner.example/cmp.js'));
  assert.equal(verdict(await banner()), 'pass');
  settings.set('adblock.cookieBanners', true);
  await waitFor('the full lists', () => adblock.stats().variant === 'full');
  assert.equal(w.net.fetched('annoyances.txt'), 1);
  assert.equal(verdict(await banner()), 'cancel');
  const calls = w.net.calls.length;
  settings.set('adblock.cookieBanners', false);
  await waitFor('back to ads + tracking', () => adblock.stats().variant === 'ads-tracking');
  assert.equal(w.net.calls.length, calls, 'from the cache');
  assert.equal(verdict(await banner()), 'pass');
});

// ----- counting -----------------------------------------------------------------------

test("blockedCount() and 'blocked' events count per page and reset on a new top-level page", async (t) => {
  const { adblock, ses } = await ready(t);
  const events = [];
  adblock.on('blocked', (e) => events.push(e));
  const a = fakeTab(20, 'https://news.example/');
  const b = fakeTab(21, 'https://blog.example/');
  await send(ses, fromTab(a, 'https://ads.example/1.js'));
  await send(ses, fromTab(a, 'https://ads.example/2.js'));
  await send(ses, fromTab(a, 'https://news.example/app.js'));
  await send(ses, fromTab(a, 'https://analytics.example/ga.js')); // redirected counts as blocked
  await send(ses, fromTab(b, 'https://ads.example/1.js'));
  assert.equal(adblock.blockedCount(20), 3);
  assert.equal(adblock.blockedCount(21), 1);
  assert.equal(adblock.blockedCount(99), 0, 'unknown tab');
  assert.deepEqual(events, [
    { webContentsId: 20, url: 'https://ads.example/1.js' },
    { webContentsId: 20, url: 'https://ads.example/2.js' },
    { webContentsId: 20, url: 'https://analytics.example/ga.js' },
    { webContentsId: 21, url: 'https://ads.example/1.js' },
  ]);

  a.navigateInPage('https://news.example/#comments');
  assert.equal(adblock.blockedCount(20), 3, 'same page (pushState / hash)');
  a.navigate('https://news.example/next');
  assert.equal(adblock.blockedCount(20), 0, 'new page');
  assert.equal(adblock.blockedCount(21), 1);
  await send(ses, fromTab(a, 'https://ads.example/3.js'));
  assert.equal(adblock.blockedCount(20), 1);
  a.destroy();
  assert.equal(adblock.blockedCount(20), 0);
});

// ----- sessions and IPC --------------------------------------------------------------------

test('a second (private) session is hooked too, with the ipcMain handlers registered once', async (t) => {
  const { w, adblock, ses } = await ready(t);
  const priv = fakeSession({ persistent: false });
  adblock.attach(priv);
  adblock.attach(priv); // again: nothing happens
  assert.equal(w.ipc.handleCalls, 2, 'one handler per channel');
  assert.deepEqual([...w.ipc.handlers.keys()].sort(), [COSMETICS, OBSERVER].sort());
  assert.equal(priv.preloads.size, 1);
  const tab = fakeTab(30, 'https://news.example/', priv);
  assert.equal(verdict(await send(priv, fromTab(tab, 'https://ads.example/ad.js'))), 'cancel');

  // Cosmetics answer for both sessions.
  for (const s of [ses, priv]) {
    const wc = fakeTab(31, 'https://news.example/', s);
    wc.mainFrame = { url: 'https://news.example/', processId: 3, routingId: 1, executeJavaScript: wc.executeJavaScript };
    await w.ipc.invoke(COSMETICS, { sender: wc, senderFrame: wc.mainFrame }, 'https://news.example/');
    assert.equal(wc.css.length, 1);
  }

  // Closing the private window's session leaves the default one working.
  adblock.detach(priv);
  assert.equal(priv.beforeRequest, null);
  assert.equal(priv.preloads.size, 0);
  assert.equal(priv.protocols.has(SCHEME.scheme), false);
  const normal = fakeTab(32, 'https://news.example/', ses);
  assert.equal(verdict(await send(ses, fromTab(normal, 'https://ads.example/ad.js'))), 'cancel');

  // A second instance on the same ipcMain (tests, a restart of the service) does not register again.
  const other = w.adblock();
  await other.init();
  other.attach(fakeSession());
  assert.equal(w.ipc.handleCalls, 2);
  assert.equal(w.logs.filter(([l]) => l === 'error').length, 0);
});

/** The event of the library's preload, which runs in top frames only: sent
 *  by the tab's main frame (same process and routing id). */
function cosmeticEvent(ses, url) {
  const wc = fakeTab(40, url, ses);
  const frame = { url, processId: 1, routingId: 1, scripts: [], executeJavaScript: async (code, gesture) => { frame.scripts.push({ code, gesture }); } };
  wc.mainFrame = frame;
  return { wc, frame, event: { sender: wc, senderFrame: frame, frameId: 1, processId: 1 } };
}

test('cosmetic IPC: styles and scriptlets for the top frame of a matching site', async (t) => {
  const { w, ses } = await ready(t);
  const { wc, frame, event } = cosmeticEvent(ses, 'https://news.example/article');
  await w.ipc.invoke(COSMETICS, event, 'https://news.example/article');
  assert.equal(wc.css.length, 1);
  assert.match(wc.css[0].css, /\.ad-banner\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  assert.equal(wc.css[0].opts.cssOrigin, 'user');
  assert.equal(frame.scripts.length, 1, 'scriptlets go to the frame that asked');
  assert.match(frame.scripts[0].code, /__snSetConstant/);
  assert.match(frame.scripts[0].code, /adsEnabled/);
  assert.equal(frame.scripts[0].gesture, false, 'no user gesture for scriptlets');
  assert.equal(wc.scripts.length, 0);
  assert.equal(await w.ipc.invoke(OBSERVER, event), true);

  // Later DOM updates (classes/ids seen by the preload): generic hides, no scriptlets again.
  await w.ipc.invoke(COSMETICS, event, 'https://news.example/article', { classes: ['generic-ad'], ids: [], hrefs: [] });
  assert.equal(frame.scripts.length, 1);
  assert.match(wc.css[wc.css.length - 1].css, /\.generic-ad/);

  // Another site gets no site-specific rules.
  const other = cosmeticEvent(ses, 'https://blog.example/');
  await w.ipc.invoke(COSMETICS, other.event, 'https://blog.example/');
  assert.ok(other.wc.css.every(({ css }) => !/ad-banner/.test(css)));
  assert.equal(other.frame.scripts.length, 0);
});

test('cosmetic IPC trusts the frame, not the message: its URL, top frames only, and it must still exist', async (t) => {
  const { w, ses } = await ready(t);
  // A blog asking for the news site's rules gets the blog's.
  const liar = cosmeticEvent(ses, 'https://blog.example/');
  await w.ipc.invoke(COSMETICS, liar.event, 'https://news.example/article');
  assert.ok(liar.wc.css.every(({ css }) => !/ad-banner/.test(css)));
  assert.equal(liar.frame.scripts.length, 0);
  // A subframe (or a fenced frame) of the news site: nothing (the styles
  // would land in the top frame).
  const sub = cosmeticEvent(ses, 'https://news.example/article');
  sub.wc.mainFrame = { url: 'https://host.example/', processId: 1, routingId: 2 };
  await w.ipc.invoke(COSMETICS, sub.event, 'https://news.example/article');
  assert.deepEqual(sub.wc.css, []);
  assert.deepEqual(sub.frame.scripts, []);
  assert.equal(await w.ipc.invoke(OBSERVER, sub.event), false);
  // The page on its way out while the next one is already the main frame.
  const old = cosmeticEvent(ses, 'https://news.example/article');
  old.wc.mainFrame = { url: 'https://news.example/next', processId: 2, routingId: 1 };
  await w.ipc.invoke(COSMETICS, old.event, 'https://news.example/article');
  assert.deepEqual(old.wc.css, []);
  // A frame already disposed throws when read: no answer, no crash.
  const disposed = cosmeticEvent(ses, 'https://news.example/article');
  Object.defineProperty(disposed.frame, 'url', { get() { throw new Error('Render frame was disposed'); } });
  await w.ipc.invoke(COSMETICS, disposed.event, 'https://news.example/article');
  assert.deepEqual(disposed.wc.css, []);
  // The frame went away before the message arrived.
  const gone = cosmeticEvent(ses, 'https://news.example/article');
  gone.event.senderFrame = null;
  await w.ipc.invoke(COSMETICS, gone.event, 'https://news.example/article');
  assert.deepEqual(gone.wc.css, []);
  assert.deepEqual(gone.wc.scripts, []);
});

test('cosmetic IPC answers nothing when the site is allowlisted, blocking is off or the page is not on the web', async (t) => {
  const { w, adblock, settings, ses } = await ready(t);
  const silent = async (url, why) => {
    const { wc, frame, event } = cosmeticEvent(ses, url);
    assert.equal(await w.ipc.invoke(COSMETICS, event, url), undefined, why);
    assert.equal(await w.ipc.invoke(COSMETICS, event, url, { classes: ['generic-ad'], ids: [], hrefs: [] }), undefined, why);
    assert.deepEqual(wc.css, [], `${why}: no styles`);
    assert.deepEqual(frame.scripts, [], `${why}: no scriptlets`);
    assert.equal(await w.ipc.invoke(OBSERVER, event), false, `${why}: no DOM observer`);
  };
  adblock.setSiteEnabled('news.example', false);
  await silent('https://news.example/article', 'allowlisted');
  adblock.setSiteEnabled('news.example', true);
  await silent('supernova://settings/', 'internal page');
  await silent('file:///home/user/page.html', 'local file');
  settings.set('adblock.enabled', false);
  await silent('https://news.example/article', 'blocking off');
  // An event from a session nobody attached: no answer, no crash.
  const stranger = cosmeticEvent(fakeSession(), 'https://news.example/');
  settings.set('adblock.enabled', true);
  await w.ipc.invoke(COSMETICS, stranger.event, 'https://news.example/');
  assert.deepEqual(stranger.wc.css, []);
});

// ----- scheduling -------------------------------------------------------------------------

test('a stale cache is refreshed startupDelayMs after init(), then every updateIntervalMs; close() stops it', async (t) => {
  const w = world(t);
  const builder = w.adblock();
  await builder.init();
  builder.close();
  const [file] = w.cacheFiles();
  const twoDaysAgo = new Date(Date.now() - 2 * DAY);
  fs.utimesSync(path.join(w.cacheDir, file), twoDaysAgo, twoDaysAgo);

  const net = fakeNet();
  const clock = Date.now();
  const a = w.adblock({ fetch: net.fetch, now: () => clock, startupDelayMs: 40, updateIntervalMs: 120 });
  const t0 = Date.now();
  await a.init();
  a.scheduleUpdate(); // main.js calls it again after the first window: idempotent
  assert.equal(a.stats().source, 'cache');
  assert.equal(a.stats().nextUpdateAt, clock + 40, 'stale: refresh soon after startup');
  assert.equal(net.builds(), 0, 'not during startup');

  await waitFor('the first refresh', () => a.stats().source === 'network');
  const first = Date.now() - t0;
  assert.ok(first >= 38, `refreshed after ${first} ms`);
  assert.equal(net.builds(), 1);
  assert.equal(a.stats().nextUpdateAt, clock + 120, 'then updateIntervalMs after the download');

  const t1 = Date.now();
  await waitFor('the second refresh', () => net.builds() === 2);
  const second = Date.now() - t1;
  assert.ok(second >= 110, `second refresh after ${second} ms`);

  await waitFor('rescheduled', () => !a.stats().updating && a.stats().nextUpdateAt !== null);
  a.close();
  assert.equal(a.stats().nextUpdateAt, null, 'close() clears the timer');
  await sleep(180);
  assert.equal(net.builds(), 2, 'nothing after close()');
});

test('a fresh cache is not refreshed before updateIntervalMs has passed since its download', async (t) => {
  const w = world(t);
  const builder = w.adblock();
  await builder.init();
  builder.close();
  const [file] = w.cacheFiles();
  const builtAt = fs.statSync(path.join(w.cacheDir, file)).mtimeMs;
  const net = fakeNet();
  const a = w.adblock({ fetch: net.fetch, startupDelayMs: 1, updateIntervalMs: 10 * 60 * 1000 });
  await a.init();
  assert.equal(a.stats().source, 'cache');
  assert.equal(a.stats().nextUpdateAt, builtAt + 10 * 60 * 1000);
  await sleep(30);
  assert.equal(net.builds(), 0);
});

test('one build at a time: concurrent updates share one download, a list switch waits for it', async (t) => {
  const { w, adblock, settings } = await ready(t);
  w.net.hold = true;
  const before = w.net.calls.length;
  const p1 = adblock.update();
  const p2 = adblock.update();
  adblock.scheduleUpdate();
  await sleep(10);
  assert.equal(w.net.calls.length - before, 3, 'one download of ads + privacy + resources');
  assert.equal(adblock.stats().updating, true);

  settings.set('adblock.cookieBanners', true);
  await sleep(20);
  assert.equal(w.net.fetched('annoyances.txt'), 0, 'the full lists wait for the running build');
  assert.equal(w.net.calls.length - before, 3);

  w.net.release();
  assert.deepEqual(await Promise.all([p1, p2]), [true, true]);
  await waitFor('the full lists', () => adblock.stats().variant === 'full');
  assert.equal(w.net.fetched('annoyances.txt'), 1);
  assert.equal(w.net.builds(), 3, 'init, the shared update, the switch');
});
