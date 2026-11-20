'use strict';
// Ad and tracker blocking (agent B), built on @ghostery/adblocker-electron:
// its filter engine and its cosmetic-filtering preload. The session wiring is
// our own because the library's enableBlockingInSession() registers global
// ipcMain handlers per session (a second session throws), has no per-site
// allowlist, judges requests by their Referer, and gives every scriptlet a
// user gesture.
//
// Costs (measured, see the report in docs or the agent B notes):
//   - startup: read + deserialize the cached engine (~7 MB, ~10-15 ms);
//   - per request: one main-thread call of ~10 us;
//   - list refresh: once a day, downloaded and parsed in a worker thread, so
//     the main thread only pays the deserialize.
//
// No require('electron') at the top: plain Node tests load this module.
// Electron objects come in through attach(session) or the options.

const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { isMainThread, workerData, parentPort } = require('node:worker_threads');

// Resolve the engine, tldts and the preload from the adblocker-electron
// package itself, so this works however npm lays out node_modules.
const ghosteryDir = path.dirname(require.resolve('@ghostery/adblocker-electron/package.json'));
const ghostery = createRequire(path.join(ghosteryDir, 'package.json'));
const { FiltersEngine, Request, adsAndTrackingLists, fullLists } = ghostery('@ghostery/adblocker');
const tldts = ghostery('tldts-experimental');
const PRELOAD_PATH = ghostery.resolve('@ghostery/adblocker-electron-preload');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Ads + tracking: EasyList, EasyPrivacy, Peter Lowe, uBlock Origin's filters
// (2020..2024, filters, quick-fixes, unbreak, badware, privacy, resource
// abuse; quick-fixes and filters carry the YouTube ad scriptlets). "full" adds
// the cookie-notice and annoyance lists, used when adblock.cookieBanners.
const LISTS = {
  'ads-tracking': adsAndTrackingLists,
  full: fullLists,
};
const RESOURCES_URL = adsAndTrackingLists[0].replace(/easylist\/easylist\.txt$/, 'ublock-origin/resources.json');

// uBlock Origin's `!#if` conditions, evaluated as uBO on desktop Chromium
// would: drops Firefox-, Safari-, mobile- and HTML-filtering-only filters.
// Unknown identifiers are false.
const ENV_TRUE = ['env_chromium', 'ext_ublock', 'cap_user_stylesheet'];
const ENGINE_CONFIG = {
  loadPreprocessors: true,
  loadCosmeticFilters: true,
  loadNetworkFilters: true,
  loadCSPFilters: true,
  loadExtendedSelectors: false, // procedural selectors: the preload cannot run them
  enableHtmlFiltering: false,
  enableMutationObserver: true,
  integrityCheck: true, // the CRC that lets loadCached() reject a damaged cache
};

// Only network schemes reach the handlers (supernova://, file://, data:,
// blob: never cross into JS).
const URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'];
const PASS = Object.freeze({});
const CANCEL = Object.freeze({ cancel: true });

// $redirect surrogates (noop scripts, google-analytics/gtm/ima stubs, 1x1
// gifs). Chromium refuses redirects to data: URLs (the library's way), so they
// are served from our own scheme, which works as a redirect target for
// scripts and images as is. If main.js registers SCHEME with these
// privileges (protocol.registerSchemesAsPrivileged, before app ready), XHR
// surrogates and pages with a strict CSP work too; without it those requests
// are simply blocked.
const SCHEME = Object.freeze({
  scheme: 'sn-adblock',
  privileges: Object.freeze({ standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true }),
});

const COSMETICS_CHANNEL = '@ghostery/adblocker/inject-cosmetic-filters';
const OBSERVER_CHANNEL = '@ghostery/adblocker/is-mutation-observer-enabled';

function makeEnv() {
  const env = new Map();
  for (const k of ENV_TRUE) env.set(k, true);
  return env;
}

/** Registrable domain (eTLD+1) of a URL or hostname; the hostname for IPs and
 *  single-label hosts; '' when there is none (about:blank, garbage). */
function siteOf(urlOrHost) {
  if (typeof urlOrHost !== 'string' || urlOrHost.length === 0) return '';
  const p = tldts.parse(urlOrHost);
  return (p.domain || p.hostname || '').toLowerCase();
}

// `unref` only where waiting must not keep a process alive (init's cap);
// retry pauses inside a build must keep a worker's event loop alive.
function sleep(ms, { unref = false } = {}) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (unref && t.unref) t.unref();
  });
}

// ----- building an engine (worker thread or in-process) ------------------------

async function fetchText(fetchImpl, url, { timeoutMs, retryPauseMs, cancelled, tries = 3 }) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length === 0) throw new Error('empty response');
      return text;
    } catch (err) {
      if (i >= tries || cancelled()) throw new Error(`${url}: ${err.message}`);
    }
    await sleep(retryPauseMs * i);
    if (cancelled()) throw new Error(`${url}: build cancelled`);
  }
}

/** Download the lists and resources, parse them, return the serialized
 *  engine (Uint8Array). CPU-heavy (~0.5 s): runs in a worker normally. */
async function buildEngineBytes({ urls, resourcesUrl, timeoutMs, retryPauseMs = 1000, fetchImpl, concurrency = 4 }) {
  // A few connections at a time: a burst of 15 parallel downloads from
  // raw.githubusercontent.com regularly stalls the biggest files.
  const all = [...urls, resourcesUrl];
  const texts = new Array(all.length);
  let next = 0;
  // One file that cannot be had fails the build: the other connections stop
  // too, instead of downloading (and retrying) the rest for nothing while
  // the next attempt is already scheduled.
  let failed = false;
  const cancelled = () => failed;
  const worker = async () => {
    while (!failed && next < all.length) {
      const i = next++;
      try {
        texts[i] = await fetchText(fetchImpl, all[i], { timeoutMs, retryPauseMs, cancelled });
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, all.length) }, worker));
  const resources = texts.pop();
  const lists = texts;
  JSON.parse(resources); // fail early on a broken resources file
  const engine = FiltersEngine.parse(lists.join('\n'), ENGINE_CONFIG);
  engine.updateResources(resources, String(resources.length));
  engine.updateEnv(makeEnv());
  return engine.serialize();
}

if (!isMainThread && workerData && workerData.snAdblockBuild === true) {
  buildEngineBytes({ ...workerData, fetchImpl: globalThis.fetch })
    .then((bytes) => parentPort.postMessage({ ok: true, bytes }, [bytes.buffer]))
    .catch((err) => parentPort.postMessage({ ok: false, error: String((err && err.message) || err) }));
}

function buildInWorker(job) {
  const { Worker } = require('node:worker_threads');
  return new Promise((resolve, reject) => {
    let settled = false;
    const w = new Worker(__filename, { workerData: { snAdblockBuild: true, ...job } });
    w.once('message', (m) => {
      settled = true;
      if (m && m.ok) resolve(m.bytes);
      else reject(Object.assign(new Error((m && m.error) || 'build failed'), { network: true }));
    });
    w.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
    w.once('exit', (code) => { if (!settled) { settled = true; reject(new Error(`build worker exited (${code})`)); } });
  });
}

async function writeAtomic(file, bytes) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, bytes);
  await fsp.rename(tmp, file);
}

/** Each scriptlet in its own function scope (no global helpers left for
 *  sites to find), all in one executeJavaScript call. */
function wrapScriptlets(scripts) {
  let out = '';
  for (const s of scripts) out += `try{(function(){${s}\n})();}catch(e){}\n`;
  return out;
}

// ipcMain is process-wide; one handler per channel serves every session and
// every instance (found through the sender's session).
const owners = new WeakMap(); // session -> instance internals
const ipcReady = new WeakSet(); // ipcMain objects with our handlers

function ensureIpc(ipcMain) {
  if (ipcReady.has(ipcMain)) return;
  ipcReady.add(ipcMain);
  const ownerOf = (event) => {
    const ses = event && event.sender && event.sender.session;
    return ses ? owners.get(ses) : undefined;
  };
  try {
    ipcMain.handle(COSMETICS_CHANNEL, (event, url, msg) => {
      const o = ownerOf(event);
      if (o) o.onCosmetics(event, url, msg);
    });
    ipcMain.handle(OBSERVER_CHANNEL, (event) => {
      const o = ownerOf(event);
      return o ? o.observerWanted(event) : false;
    });
  } catch (err) {
    console.error('adblock: cosmetic filtering IPC unavailable:', err.message);
  }
}

// ----- the service ---------------------------------------------------------------

/**
 * createAdblock({ cacheDir, settings, ...options })
 * Options (all optional, mainly for tests): fetch, useWorker (true), ipcMain,
 * now (Date.now), updateIntervalMs (1 day), startupDelayMs (1 min, first
 * refresh of a stale cache), retryMs (2 min, doubled per failure up to
 * retryMaxMs 1 h), initTimeoutMs (5 s, how long init() waits for a first-run
 * download), fetchTimeoutMs (20 s per file), fetchRetryMs (1 s, pause before
 * the 2nd try of a file, doubled before the 3rd), lists ({ 'ads-tracking':
 * [urls], full: [urls] }), resourcesUrl, log (console).
 */
function createAdblock({ cacheDir, settings = null, ...opts } = {}) {
  if (!cacheDir) throw new Error('createAdblock: cacheDir is required');
  const o = {
    fetch: (...a) => globalThis.fetch(...a),
    useWorker: true,
    ipcMain: null,
    now: Date.now,
    updateIntervalMs: DAY,
    startupDelayMs: MIN,
    retryMs: 2 * MIN,
    retryMaxMs: HOUR,
    initTimeoutMs: 5000,
    fetchTimeoutMs: 20000,
    fetchRetryMs: 1000,
    lists: LISTS,
    resourcesUrl: RESOURCES_URL,
    log: console,
    ...opts,
  };

  const em = new EventEmitter();
  // Surrogate URLs carry a per-run secret so pages cannot probe for them.
  const secret = require('node:crypto').randomBytes(9).toString('base64url');
  const surrogatePrefix = `${SCHEME.scheme}://r/${secret}/`;
  const st = {
    enabled: true,
    cookieBanners: false,
    allow: new Set(),
    engine: null,
    variant: null, // variant of the loaded engine
    source: null, // 'cache' | 'network'
    builtAt: 0, // when the loaded engine's lists were downloaded
    bytes: 0,
    initMs: null,
    failures: 0,
    lastFailureAt: 0,
    building: null, // { variant, promise }
    timer: null,
    nextAt: 0,
    initPromise: null,
    closed: false,
  };
  const sessions = new Map(); // session -> { hooked, preloadId }
  const tabs = new Map(); // webContentsId -> { top, active, blocked }
  const variantWanted = () => (st.cookieBanners ? 'full' : 'ads-tracking');
  const cacheFile = (variant) => path.join(cacheDir, `engine-${variant}.bin`);

  // --- settings -------------------------------------------------------------------

  function readSettings() {
    const get = (k, d) => {
      const v = settings && typeof settings.get === 'function' ? settings.get(k) : undefined;
      return v === undefined || v === null ? d : v;
    };
    st.enabled = get('adblock.enabled', true) !== false;
    st.cookieBanners = get('adblock.cookieBanners', false) === true;
    const list = get('adblock.allowlist', []);
    st.allow = new Set((Array.isArray(list) ? list : []).map(siteOf).filter(Boolean));
  }

  function isActiveFor(url) {
    if (!st.enabled) return false;
    return st.allow.size === 0 || !st.allow.has(siteOf(url));
  }

  function settingsChanged(key) {
    if (typeof key === 'string' && key !== 'adblock' && !key.startsWith('adblock.')) return;
    const wasEnabled = st.enabled;
    const wasVariant = variantWanted();
    readSettings();
    for (const t of tabs.values()) t.active = isActiveFor(t.top);
    if (st.enabled !== wasEnabled) {
      for (const ses of sessions.keys()) (st.enabled ? hook : unhook)(ses);
    }
    if (st.initPromise && st.enabled && (st.enabled !== wasEnabled || variantWanted() !== wasVariant)) {
      ensureEngine().catch(() => {});
    }
  }

  function setSiteEnabled(host, enabled) {
    const site = siteOf(String(host || ''));
    if (!site) return;
    const current = settings && typeof settings.get === 'function' ? settings.get('adblock.allowlist') : null;
    const list = (Array.isArray(current) ? current : [...st.allow]).filter((h) => siteOf(h) !== site);
    if (!enabled) list.push(site);
    if (settings && typeof settings.set === 'function') settings.set('adblock.allowlist', list);
    // Apply now too (the store may not emit, e.g. when nothing changed).
    st.allow = new Set(list.map(siteOf).filter(Boolean));
    for (const t of tabs.values()) t.active = isActiveFor(t.top);
  }

  // --- engine loading and refresh ---------------------------------------------------

  function install(engine, variant, builtAt, source, bytes) {
    st.engine = engine;
    st.variant = variant;
    st.builtAt = builtAt;
    st.source = source;
    st.bytes = bytes;
  }

  async function loadCached(variant) {
    try {
      const file = cacheFile(variant);
      const [buf, stat] = await Promise.all([fsp.readFile(file), fsp.stat(file)]);
      const engine = FiltersEngine.deserialize(buf); // throws on version/CRC mismatch
      // A file cut short a few bytes after the version deserializes without
      // an error into an empty engine whose config says "no CRC". Ours are
      // always written with the CRC on, so that is a damaged file.
      if (engine.config.integrityCheck !== true) throw new Error('damaged engine cache');
      engine.updateEnv(makeEnv());
      if (variant !== variantWanted()) return false;
      install(engine, variant, stat.mtimeMs, 'cache', buf.length);
      return true;
    } catch {
      return false;
    }
  }

  async function buildBytes(variant) {
    const job = { urls: o.lists[variant], resourcesUrl: o.resourcesUrl, timeoutMs: o.fetchTimeoutMs, retryPauseMs: o.fetchRetryMs };
    if (o.useWorker) {
      try {
        return await buildInWorker(job);
      } catch (err) {
        if (err.network) throw err;
        o.log.warn(`adblock: worker unavailable (${err.message}); building on the main thread`);
      }
    }
    return buildEngineBytes({ ...job, fetchImpl: o.fetch });
  }

  /** Download and parse the lists for `variant`, cache and load the result. */
  function refresh(variant = variantWanted()) {
    if (st.building && st.building.variant === variant) return st.building.promise;
    clearTimeout(st.timer);
    st.timer = null;
    const promise = (async () => {
      try {
        const bytes = await buildBytes(variant);
        if (st.closed) return false;
        const engine = FiltersEngine.deserialize(bytes);
        const builtAt = o.now();
        try {
          await writeAtomic(cacheFile(variant), bytes);
        } catch (err) {
          o.log.warn('adblock: could not write the engine cache:', err.message);
        }
        st.failures = 0;
        if (variant === variantWanted()) install(engine, variant, builtAt, 'network', bytes.length);
        return true;
      } catch (err) {
        st.failures += 1;
        st.lastFailureAt = o.now();
        o.log.warn(`adblock: list update failed (${st.failures}): ${err.message}`);
        return false;
      } finally {
        if (st.building && st.building.promise === promise) st.building = null;
        if (!st.closed && st.enabled) scheduleUpdate();
      }
    })();
    st.building = { variant, promise };
    return promise;
  }

  /** Make sure the wanted variant is loaded: cache first, else the network. */
  async function ensureEngine() {
    const variant = variantWanted();
    if (st.engine && st.variant === variant) return true;
    if (await loadCached(variant)) {
      scheduleUpdate();
      return true;
    }
    return refresh(variant);
  }

  function init() {
    if (st.initPromise) return st.initPromise;
    readSettings();
    if (settings && typeof settings.on === 'function') settings.on('change', settingsChanged);
    st.initPromise = (async () => {
      const t0 = performance.now();
      if (st.enabled) {
        // A first run (no cache) waits a little for the download, then goes
        // on without blocking; the engine is swapped in when it arrives.
        await Promise.race([ensureEngine(), sleep(o.initTimeoutMs, { unref: true })]);
      }
      st.initMs = performance.now() - t0;
      if (st.enabled) scheduleUpdate();
    })();
    return st.initPromise;
  }

  /** One single-shot timer for the next refresh: a day after the loaded lists
   *  were downloaded (at least startupDelayMs from now), or after a backoff
   *  when the last attempt failed. Idempotent. */
  function scheduleUpdate() {
    clearTimeout(st.timer);
    st.timer = null;
    if (st.closed || !st.enabled || st.building) return;
    const now = o.now();
    let due = st.engine && st.variant === variantWanted() ? st.builtAt + o.updateIntervalMs : now;
    if (st.failures > 0) {
      const backoff = Math.min(o.retryMaxMs, o.retryMs * 2 ** (st.failures - 1));
      due = Math.max(due, st.lastFailureAt + backoff);
    }
    const delay = Math.min(Math.max(due - now, o.startupDelayMs), 2 ** 31 - 1);
    st.nextAt = now + delay;
    st.timer = setTimeout(() => { st.timer = null; refresh(); }, delay);
    if (st.timer.unref) st.timer.unref();
  }

  /** Refresh the lists now (e.g. a "check for updates" button). */
  function update() {
    return refresh(variantWanted());
  }

  // --- per-tab state ----------------------------------------------------------------

  function tabFor(details) {
    const id = details.webContentsId;
    if (id === undefined || id === null) return null;
    let t = tabs.get(id);
    if (t !== undefined) return t;
    const wc = details.webContents;
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return null;
    const top = typeof wc.getURL === 'function' ? wc.getURL() : '';
    t = { top, active: isActiveFor(top), blocked: 0 };
    tabs.set(id, t);
    if (typeof wc.on === 'function') {
      // Cross-document main-frame commits only (not pushState), so an SPA
      // keeps one count per page load.
      wc.on('did-navigate', (_e, url) => {
        t.top = url;
        t.active = isActiveFor(url);
        t.blocked = 0;
      });
      wc.once('destroyed', () => tabs.delete(id));
    }
    return t;
  }

  function blockedCount(webContentsId) {
    const t = tabs.get(webContentsId);
    return t ? t.blocked : 0;
  }

  // --- request handlers (hot path: every request of every page) -----------------------

  function decide(details) {
    const engine = st.engine;
    if (engine === null) return PASS;
    const type = details.resourceType;
    const tab = tabFor(details);
    if (type === 'mainFrame') return PASS; // documents are never blocked
    if (tab !== null && !tab.active) return PASS;
    // The document that made the request (uBO's context); a frame with an
    // opaque origin falls back to the tab's top-level URL.
    const initiator = details.initiatorOrigin;
    const sourceUrl = initiator && initiator !== 'null' ? initiator : tab !== null ? tab.top : details.referrer || '';
    if (tab === null && !isActiveFor(sourceUrl)) return PASS; // service workers etc.
    const { match, redirect } = engine.match(Request.fromRawDetails({
      url: details.url,
      sourceUrl,
      type: type || 'other',
      tabId: details.webContentsId || 0,
    }));
    if (redirect) return { redirectURL: surrogatePrefix + encodeURIComponent(redirect.filename) };
    return match ? CANCEL : PASS;
  }

  function serveSurrogate(request) {
    const url = request.url;
    const engine = st.engine;
    if (engine === null || !url.startsWith(surrogatePrefix)) return new Response(null, { status: 404 });
    let name = '';
    try { name = decodeURIComponent(url.slice(surrogatePrefix.length)); } catch {}
    const r = engine.resources.getResource(name);
    const base64 = /;base64$/.test(r.contentType);
    const type = base64 ? r.contentType.slice(0, -7) : r.contentType;
    const body = base64 ? Buffer.from(r.body, 'base64') : r.body;
    return new Response(body, {
      headers: { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
    });
  }

  function onBeforeRequest(details, callback) {
    let res = PASS;
    try {
      res = decide(details);
    } catch (err) {
      reportOnce(err);
    }
    callback(res);
    if (res !== PASS) {
      const t = tabs.get(details.webContentsId);
      if (t) t.blocked += 1;
      em.emit('blocked', { webContentsId: details.webContentsId, url: details.url });
    }
  }

  // $csp filters: appended as an extra policy (each CSP header is enforced on
  // its own, so the site's own policy keeps its meaning).
  function onHeadersReceived(details, callback) {
    let res = PASS;
    try {
      const engine = st.engine;
      if (engine !== null && details.resourceType === 'mainFrame' && isActiveFor(details.url)) {
        const csp = engine.getCSPDirectives(Request.fromRawDetails({ url: details.url, type: 'mainFrame' }));
        if (csp) {
          const headers = { ...(details.responseHeaders || {}) };
          const name = Object.keys(headers).find((k) => k.toLowerCase() === 'content-security-policy') || 'Content-Security-Policy';
          headers[name] = [...(headers[name] || []), csp];
          res = { responseHeaders: headers };
        }
      }
    } catch (err) {
      reportOnce(err);
    }
    callback(res);
  }

  let reported = false;
  function reportOnce(err) {
    if (reported) return;
    reported = true;
    o.log.error('adblock: request handler error:', err && err.stack ? err.stack : err);
  }

  // --- cosmetic filtering (called by the library's preload, top frame only) -----------

  function cosmeticsWanted(url) {
    return st.engine !== null && st.enabled && typeof url === 'string' && /^https?:/.test(url) && isActiveFor(url);
  }

  function onCosmetics(event, url, msg) {
    if (!cosmeticsWanted(url)) return;
    const { hostname, domain } = tldts.parse(url);
    const first = msg === undefined || msg === null;
    const { active, styles, scripts } = st.engine.getCosmeticsFilters({
      url,
      hostname: hostname || '',
      domain: domain || '',
      classes: first ? undefined : msg.classes,
      hrefs: first ? undefined : msg.hrefs,
      ids: first ? undefined : msg.ids,
      getBaseRules: first,
      getInjectionRules: first,
      getExtendedRules: false,
      getRulesFromHostname: first,
      getRulesFromDOM: !first,
    });
    if (!active) return;
    const wc = event.sender;
    if (styles.length > 0) Promise.resolve(wc.insertCSS(styles, { cssOrigin: 'user' })).catch(() => {});
    if (scripts.length > 0) {
      // To the frame that asked (not the tab's current main frame), and
      // without a user gesture.
      const target = event.senderFrame || wc;
      Promise.resolve(target.executeJavaScript(wrapScriptlets(scripts), false)).catch(() => {});
    }
  }

  function observerWanted(event) {
    const url = (event.senderFrame && event.senderFrame.url) || '';
    return cosmeticsWanted(url) && st.engine.config.enableMutationObserver === true;
  }

  // --- sessions -----------------------------------------------------------------------

  const internals = { onCosmetics, observerWanted };

  function hook(ses) {
    const s = sessions.get(ses);
    if (!s || s.hooked) return;
    s.hooked = true;
    ses.webRequest.onBeforeRequest({ urls: URLS }, onBeforeRequest);
    try {
      ses.webRequest.onHeadersReceived({ urls: URLS.slice(0, 2), types: ['mainFrame'] }, onHeadersReceived);
    } catch {
      ses.webRequest.onHeadersReceived({ urls: URLS.slice(0, 2) }, onHeadersReceived);
    }
    if (ses.protocol && typeof ses.protocol.handle === 'function' && !s.scheme) {
      try {
        ses.protocol.handle(SCHEME.scheme, serveSurrogate);
        s.scheme = true;
      } catch {}
    }
    if (typeof ses.registerPreloadScript === 'function') {
      s.preloadId = ses.registerPreloadScript({ type: 'frame', id: 'supernova-adblock', filePath: PRELOAD_PATH });
    } else if (typeof ses.setPreloads === 'function') {
      ses.setPreloads([...ses.getPreloads().filter((p) => p !== PRELOAD_PATH), PRELOAD_PATH]);
    }
  }

  function unhook(ses) {
    const s = sessions.get(ses);
    if (!s || !s.hooked) return;
    s.hooked = false;
    ses.webRequest.onBeforeRequest(null);
    ses.webRequest.onHeadersReceived(null);
    if (s.scheme) {
      try { ses.protocol.unhandle(SCHEME.scheme); } catch {}
      s.scheme = false;
    }
    if (s.preloadId !== undefined && typeof ses.unregisterPreloadScript === 'function') {
      try { ses.unregisterPreloadScript(s.preloadId); } catch {}
      s.preloadId = undefined;
    } else if (typeof ses.setPreloads === 'function') {
      ses.setPreloads(ses.getPreloads().filter((p) => p !== PRELOAD_PATH));
    }
  }

  /** Enable blocking on a session (default, persistent or in-memory private
   *  ones). Calling it again for the same session does nothing. */
  function attach(ses) {
    if (!ses || sessions.has(ses)) return;
    if (!st.initPromise) readSettings();
    ensureIpc(o.ipcMain || require('electron').ipcMain);
    sessions.set(ses, { hooked: false, preloadId: undefined, scheme: false });
    owners.set(ses, internals);
    if (st.enabled) hook(ses);
  }

  /** Stop blocking on a session (e.g. a private window's session at close). */
  function detach(ses) {
    if (!sessions.has(ses)) return;
    unhook(ses);
    sessions.delete(ses);
    if (owners.get(ses) === internals) owners.delete(ses);
  }

  function stats() {
    return {
      ready: st.engine !== null,
      enabled: st.enabled,
      variant: st.variant,
      source: st.source,
      builtAt: st.builtAt,
      engineBytes: st.bytes,
      initMs: st.initMs,
      updating: st.building !== null,
      nextUpdateAt: st.timer ? st.nextAt : null,
    };
  }

  /** Stop timers and detach every session (tests, app quit). */
  function close() {
    st.closed = true;
    clearTimeout(st.timer);
    st.timer = null;
    for (const ses of [...sessions.keys()]) detach(ses);
    if (settings && typeof settings.off === 'function') settings.off('change', settingsChanged);
  }

  return Object.assign(em, {
    init,
    attach,
    detach,
    isActiveFor,
    setSiteEnabled,
    blockedCount,
    scheduleUpdate,
    update,
    stats,
    close,
  });
}

module.exports = { createAdblock, SCHEME, siteOf, wrapScriptlets, PRELOAD_PATH, ENGINE_CONFIG, _buildEngineBytes: buildEngineBytes };
