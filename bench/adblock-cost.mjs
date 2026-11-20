#!/usr/bin/env node
// What ad blocking costs the main process, with the real compiled engine:
//   - engine load from the cache (what every start pays: read + deserialize);
//   - the onBeforeRequest path (src/main/adblock.js -> Electron session) for
//     ~10k realistic requests: YouTube (pages, player, googlevideo media
//     segments, stats/ads pings), news sites with ad tech (doubleclick,
//     googlesyndication, GTM, Amazon, Criteo...) and plain first-party sites.
//
//   node bench/adblock-cost.mjs [--engine path/to/engine-ads-tracking.bin] [--requests 10000]
//
// The engine: a copy of --engine, else of the benchmark profile's
// /tmp/sn-bench-supernova/adblock/engine-ads-tracking.bin, else one built
// from the default lists (the only case that uses the network). The source
// file is only read; everything else happens in a temp dir that is removed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createAdblock } = require(path.join(here, '..', 'src', 'main', 'adblock.js'));

const argv = process.argv.slice(2);
const arg = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const ENGINE = arg('--engine', '/tmp/sn-bench-supernova/adblock/engine-ads-tracking.bin');
const N = Number(arg('--requests', 10000));
const LOADS = 15;
const WARM_PASSES = 3;

// ----- fakes: just enough Electron for createAdblock ------------------------------------

const ipcMain = { handle() {}, removeHandler() {} };
function fakeSession() {
  const ses = { beforeRequest: null };
  ses.webRequest = {
    onBeforeRequest: (filter, fn) => { ses.beforeRequest = fn === undefined ? filter : fn; },
    onHeadersReceived() {},
  };
  ses.registerPreloadScript = () => 'adblock';
  ses.unregisterPreloadScript = () => {};
  ses.protocol = { handle() {}, unhandle() {} };
  return ses;
}
function fakeTab(id, url) {
  const listeners = new Map();
  return {
    id,
    getURL: () => url,
    isDestroyed: () => false,
    on: (ev, fn) => listeners.set(ev, fn),
    once: (ev, fn) => listeners.set(ev, fn),
  };
}
const noNetwork = async (url) => { throw new Error(`bench: no network expected (${url})`); };
const quiet = { warn() {}, error: console.error, info() {}, log() {} };

// ----- realistic requests (seeded, so every run sees the same mix) ------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
function requestSet(seed, n) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const hex = (len) => Array.from({ length: len }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');
  const b64 = (len) => Array.from({ length: len }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[Math.floor(r() * 64)]).join('');
  const int = (a, b) => a + Math.floor(r() * (b - a));

  const vid = () => b64(11);
  const yt = {
    top: () => `https://www.youtube.com/watch?v=${vid()}`,
    reqs: [
      // Media segments dominate a playing video.
      [30, 'xhr', () => `https://rr${int(1, 6)}---sn-${b64(8).toLowerCase()}.googlevideo.com/videoplayback?expire=${int(1.7e9, 1.8e9)}&ei=${b64(16)}&ip=2a02%3A810%3A${hex(4)}&id=o-${b64(44)}&itag=${pick([137, 248, 399, 136, 140, 251])}&aitags=133%2C134%2C135&source=youtube&requiressl=yes&mime=${pick(['video%2Fmp4', 'video%2Fwebm', 'audio%2Fwebm'])}&dur=${int(60, 3600)}.${int(100, 999)}&lmt=${int(1.6e15, 1.7e15)}&c=WEB&sig=${b64(60)}&range=${int(0, 9e6)}-${int(9e6, 2e7)}&rn=${int(1, 200)}&rbuf=${int(0, 120000)}`],
      [6, 'image', () => `https://i.ytimg.com/vi/${vid()}/hqdefault.jpg?sqp=-oaymwE${b64(30)}&rs=${b64(30)}`],
      [4, 'image', () => `https://yt3.ggpht.com/${b64(60)}=s68-c-k-c0x00ffffff-no-rj`],
      [5, 'xhr', () => `https://www.youtube.com/youtubei/v1/${pick(['player', 'next', 'browse', 'log_event', 'guide', 'updated_metadata'])}?prettyPrint=false`],
      [4, 'xhr', () => `https://www.youtube.com/api/stats/${pick(['qoe', 'watchtime', 'playback', 'atr'])}?ns=yt&el=detailpage&cpn=${b64(16)}&ver=2&cmt=${int(0, 3000)}.${int(0, 999)}&fmt=${int(130, 400)}&fs=0&rt=${int(0, 3000)}.${int(0, 999)}&euri&lact=${int(1, 9999)}&cl=${int(6e8, 7e8)}&state=playing&volume=100&docid=${vid()}`],
      [2, 'xhr', () => `https://www.youtube.com/api/stats/ads?ver=2&ns=1&event=2&device=1&content_v=${vid()}&el=detailpage&ei=${b64(16)}&devicever=2.${int(20240000, 20261231)}.00.00&bti=${int(1e6, 9e6)}&format=1_8_1&break_type=1&conn=0&cpn=${b64(16)}&lact=${int(1, 9999)}&m_pos=0&mt=${int(0, 30)}&p_h=360&p_w=640&rwt=${int(0, 20)}&sdkv=h.3.0&slot_pos=0&vis=0&vol=1&wt=${int(0, 30)}&ad_cpn=${b64(16)}&ad_id=${int(1e5, 9e5)}&ad_len=${int(5000, 30000)}&ad_mt=0&ad_sys=YT%3AAdSense-Viral%2CAdSense-Viral&ad_v=${vid()}`],
      [2, 'xhr', () => `https://www.youtube.com/pagead/viewthroughconversion/${int(9e8, 1e9)}/?backend=innertube&cname=1&cver=2_${int(20240000, 20261231)}&foc_id=${b64(22)}&label=followon_view&ptype=no_rmkt&random=${int(1e8, 1e9)}&cv_attributed=0`],
      [2, 'script', () => `https://www.youtube.com/s/player/${hex(8)}/player_ias.vflset/en_US/${pick(['base.js', 'embed.js', 'remote.js', 'miniplayer.js', 'endscreen.js'])}`],
      [1, 'script', () => `https://www.youtube.com/s/desktop/${hex(8)}/jsbin/${pick(['desktop_polymer.vflset/desktop_polymer.js', 'www-i18n-constants-en_US.vflset/www-i18n-constants.js', 'web-animations-next-lite.min.vflset/web-animations-next-lite.min.js'])}`],
      [1, 'font', () => `https://fonts.gstatic.com/s/roboto/v30/${b64(24)}.woff2`],
      [2, 'image', () => `https://www.youtube.com/generate_204?${b64(8)}`],
      [1, 'xhr', () => `https://play.google.com/log?format=json&hasfast=true&authuser=0`],
      [1, 'xhr', () => 'https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT'],
      [1, 'script', () => `https://www.google.com/js/th/${b64(43)}.js`],
      [2, 'xhr', () => 'https://googleads.g.doubleclick.net/pagead/id'],
      [1, 'script', () => 'https://static.doubleclick.net/instream/ad_status.js'],
      [1, 'image', () => `https://www.google.com/pagead/lvz?evtid=${b64(20)}&req_ts=${int(1.7e9, 1.8e9)}&pg=MainAppBootstrap%3AWatch&az=1&sigh=${b64(30)}`],
      [1, 'script', () => `https://www.gstatic.com/cv/js/sender/v1/cast_sender.js`],
    ],
  };
  const newsHosts = ['www.dailynews-example.com', 'www.morningpost-example.co.uk', 'www.tagesblatt-example.de', 'www.lemonde-example.fr', 'edition.worldnews-example.com'];
  const news = {
    top: () => `https://${pick(newsHosts)}/${pick(['politics', 'sport', 'tech', 'world'])}/2026/11/${b64(20).toLowerCase()}`,
    reqs: [
      [10, 'script', (top) => `${origin(top)}/assets/${pick(['app', 'vendor', 'article', 'runtime'])}.${hex(10)}.js`],
      [4, 'stylesheet', (top) => `${origin(top)}/assets/${pick(['main', 'article'])}.${hex(10)}.css`],
      [12, 'image', (top) => `https://cdn.${host(top).replace(/^www\.|^edition\./, '')}/images/${int(1e5, 9e5)}/${b64(12)}_${pick([320, 640, 1024, 1600])}.${pick(['jpg', 'webp', 'avif'])}`],
      [4, 'xhr', (top) => `${origin(top)}/api/${pick(['comments', 'related', 'live', 'paywall'])}?id=${int(1e6, 9e6)}`],
      [2, 'font', (top) => `${origin(top)}/fonts/${pick(['serif', 'sans'])}-${pick(['regular', 'bold'])}.woff2`],
      [2, 'script', () => 'https://securepubads.g.doubleclick.net/tag/js/gpt.js'],
      [3, 'xhr', () => `https://securepubads.g.doubleclick.net/gampad/ads?pvsid=${int(1e15, 9e15)}&correlator=${int(1e15, 9e15)}&eid=${int(1e7, 9e7)}&output=ldjh&gdfp_req=1&vrg=${int(2e9, 3e9)}&ptt=17&impl=fifs&iu_parts=${int(1e6, 9e6)}%2Cnews%2Carticle&enc_prev_ius=%2F0%2F1%2F2&prev_iu_szs=300x250%7C728x90`],
      [2, 'script', () => `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-${int(1e15, 9e15)}`],
      [2, 'subFrame', () => `https://tpc.googlesyndication.com/safeframe/1-0-40/html/container.html`],
      [2, 'image', () => `https://googleads.g.doubleclick.net/pagead/viewthroughconversion/${int(9e8, 1e9)}/?random=${int(1e8, 1e9)}&cv=11&fst=${int(1.7e12, 1.8e12)}&num=1`],
      [2, 'script', () => `https://www.googletagmanager.com/gtm.js?id=GTM-${b64(7).toUpperCase()}`],
      [2, 'script', () => 'https://www.google-analytics.com/analytics.js'],
      [2, 'ping', () => `https://www.google-analytics.com/g/collect?v=2&tid=G-${b64(10).toUpperCase()}&cid=${int(1e9, 9e9)}.${int(1.7e9, 1.8e9)}&en=page_view`],
      [1, 'script', () => 'https://connect.facebook.net/en_US/fbevents.js'],
      [1, 'script', () => 'https://c.amazon-adsystem.com/aax2/apstag.js'],
      [1, 'xhr', () => 'https://ib.adnxs.com/ut/v3/prebid'],
      [1, 'script', () => `https://cdn.taboola.com/libtrc/${pick(['dailynews', 'morningpost'])}/loader.js`],
      [1, 'script', () => 'https://static.criteo.net/js/ld/publishertag.js'],
      [1, 'script', () => 'https://sb.scorecardresearch.com/beacon.js'],
      [1, 'script', () => `https://script.hotjar.com/modules.${hex(20)}.js`],
      [1, 'script', () => `https://cdn.cookielaw.org/scripttemplates/otSDKStub.js`],
    ],
  };
  const siteHosts = Array.from({ length: 40 }, (_, i) => pick(['www.', 'shop.', 'docs.', 'app.', '']) + pick(['acme', 'nordic', 'fjord', 'pixel', 'tinker', 'harbor', 'lumen', 'orbit']) + i + pick(['.com', '.io', '.de', '.org', '.net']));
  const plain = {
    top: () => `https://${pick(siteHosts)}/${pick(['', 'products/', 'docs/guide/', 'blog/'])}${b64(10).toLowerCase()}`,
    reqs: [
      [10, 'script', (top) => `${origin(top)}/static/js/${pick(['main', 'chunk', 'vendors'])}.${hex(8)}.js`],
      [4, 'stylesheet', (top) => `${origin(top)}/static/css/main.${hex(8)}.css`],
      [12, 'image', (top) => `${origin(top)}/img/${pick(['products', 'avatars', 'hero'])}/${int(1, 99999)}.${pick(['webp', 'png', 'jpg', 'svg'])}`],
      [6, 'xhr', (top) => `${origin(top)}/api/v1/${pick(['items', 'search', 'cart', 'session'])}?page=${int(1, 50)}&q=${b64(6)}`],
      [2, 'font', () => `https://fonts.gstatic.com/s/inter/v13/${b64(30)}.woff2`],
      [1, 'stylesheet', () => 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap'],
      [2, 'script', () => `https://cdnjs.cloudflare.com/ajax/libs/${pick(['jquery/3.7.1/jquery.min.js', 'lodash.js/4.17.21/lodash.min.js', 'highlight.js/11.9.0/highlight.min.js'])}`],
      [1, 'script', () => `https://www.googletagmanager.com/gtag/js?id=G-${b64(10).toUpperCase()}`],
      [1, 'script', () => `https://js.stripe.com/v3/`],
    ],
  };
  const scenarios = [[45, yt], [35, news], [20, plain]];

  const tabs = [];
  const out = [];
  let tabFor = null;
  for (let i = 0; i < n; i++) {
    // A new page now and then (main-frame request), else a subresource of the current one.
    if (tabFor === null || r() < 0.01) {
      const sc = weighted(r, scenarios);
      const top = sc.top();
      const tab = fakeTab(seed * 1000 + tabs.length, top);
      tabs.push(tab);
      tabFor = { sc, top, tab };
      out.push({ url: top, resourceType: 'mainFrame', webContentsId: tab.id, webContents: tab, referrer: '', method: 'GET' });
      continue;
    }
    const [type, make] = weighted(r, tabFor.sc.reqs.map(([w, t, f]) => [w, [t, f]]));
    out.push({
      url: make(tabFor.top),
      resourceType: type,
      webContentsId: tabFor.tab.id,
      webContents: tabFor.tab,
      initiatorOrigin: origin(tabFor.top),
      referrer: tabFor.top,
      method: 'GET',
    });
  }
  return out;
}
function weighted(r, items) {
  const total = items.reduce((s, [w]) => s + w, 0);
  let x = r() * total;
  for (const [w, v] of items) { if ((x -= w) < 0) return v; }
  return items[items.length - 1][1];
}
const origin = (u) => new URL(u).origin;
const host = (u) => new URL(u).hostname;

// ----- stats ---------------------------------------------------------------------------

function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]; }
function summary(samplesUs) {
  const s = Float64Array.from(samplesUs).sort();
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, p50: pct(s, 50), p90: pct(s, 90), p99: pct(s, 99), p999: pct(s, 99.9), max: s[s.length - 1], mean };
}
const f = (x) => x.toFixed(1).padStart(7);
function line(label, st) {
  return `${label.padEnd(28)} n=${String(st.n).padStart(6)}  p50 ${f(st.p50)}  p90 ${f(st.p90)}  p99 ${f(st.p99)}  p99.9 ${f(st.p999)}  max ${f(st.max)}  mean ${f(st.mean)}  (us)`;
}

// ----- run -----------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-adblock-cost-'));
const instances = [];
process.on('exit', () => { for (const a of instances) a.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const cacheDir = path.join(tmp, 'adblock');
const cacheFile = path.join(cacheDir, 'engine-ads-tracking.bin');
fs.mkdirSync(cacheDir, { recursive: true });

let engineFrom;
if (fs.existsSync(ENGINE)) {
  fs.copyFileSync(ENGINE, cacheFile);
  engineFrom = `copy of ${ENGINE}`;
} else {
  console.log(`no ${ENGINE}: building one from the default lists (network)...`);
  const t0 = performance.now();
  const builder = createAdblock({ cacheDir, settings: null, ipcMain, useWorker: false, initTimeoutMs: 120000, log: quiet });
  instances.push(builder);
  await builder.init();
  builder.close();
  if (!builder.stats().ready) throw new Error('could not build the engine (network?)');
  engineFrom = `built from the default lists in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
}
const engineBytes = fs.statSync(cacheFile).size;

// Engine load from the cache, as at every start (fresh instance each time).
const loadMs = [];
let adblock = null;
for (let i = 0; i < LOADS; i++) {
  const a = createAdblock({ cacheDir, settings: null, ipcMain, useWorker: false, fetch: noNetwork, log: quiet });
  instances.push(a);
  const t0 = performance.now();
  await a.init();
  loadMs.push(performance.now() - t0);
  const st = a.stats();
  if (st.source !== 'cache') throw new Error(`engine did not load from the cache (${JSON.stringify(st)})`);
  if (i < LOADS - 1) a.close();
  else adblock = a;
}

const ses = fakeSession();
adblock.attach(ses);
const listener = ses.beforeRequest;

function pass(reqs) {
  const us = new Float64Array(reqs.length);
  const verdicts = { cancel: 0, redirect: 0, pass: 0 };
  const byHost = new Map();
  let res = null;
  const cb = (r) => { res = r; };
  for (let i = 0; i < reqs.length; i++) {
    const d = reqs[i];
    const t0 = process.hrtime.bigint();
    listener(d, cb);
    us[i] = Number(process.hrtime.bigint() - t0) / 1000;
    const v = res.cancel ? 'cancel' : res.redirectURL ? 'redirect' : 'pass';
    verdicts[v] += 1;
    if (v !== 'pass') { const h = host(d.url); byHost.set(h, (byHost.get(h) || 0) + 1); }
  }
  return { us, verdicts, byHost };
}

// Pass 1: cold (the engine decodes filter buckets lazily on first use).
const cold = pass(requestSet(1, N));
// Then fresh, never-seen URLs with the same mix: the steady state.
const warm = [];
for (let i = 0; i < WARM_PASSES; i++) warm.push(pass(requestSet(2 + i, N)));
const warmUs = warm.flatMap((p) => Array.from(p.us));
const byType = new Map();
const lastSet = requestSet(2 + WARM_PASSES - 1, N);
const last = warm[warm.length - 1];
lastSet.forEach((d, i) => { const k = d.resourceType; if (!byType.has(k)) byType.set(k, []); byType.get(k).push(last.us[i]); });
const ytOnly = [];
const gvOnly = [];
lastSet.forEach((d, i) => {
  const h = host(d.url);
  if (h.endsWith('googlevideo.com')) gvOnly.push(last.us[i]);
  else if (h.endsWith('youtube.com')) ytOnly.push(last.us[i]);
});

const load = Float64Array.from(loadMs).sort();
console.log(`supernova ad blocking cost  (node ${process.version}, ${os.cpus()[0].model.trim()}, ${os.cpus().length} threads)`);
console.log(`engine: ${engineFrom}; ${(engineBytes / 1e6).toFixed(2)} MB`);
console.log('');
console.log(`engine load from cache (init(), ${LOADS} fresh instances): p50 ${pct(load, 50).toFixed(1)} ms, min ${load[0].toFixed(1)} ms, max ${load[load.length - 1].toFixed(1)} ms`);
console.log('');
console.log(`onBeforeRequest, per request (${N} requests per pass; YouTube 45% / news + ad tech 35% / first-party sites 20%):`);
console.log(line('cold (first pass)', summary(cold.us)));
console.log(line(`warm (${WARM_PASSES} passes, new URLs)`, summary(warmUs)));
for (const [type, xs] of [...byType].sort((a, b) => b[1].length - a[1].length)) console.log(line(`  warm, ${type}`, summary(xs)));
console.log(line('  warm, *.googlevideo.com', summary(gvOnly)));
console.log(line('  warm, *.youtube.com', summary(ytOnly)));
console.log('');
const v = last.verdicts;
console.log(`verdicts (last pass): ${v.cancel} cancelled, ${v.redirect} redirected, ${v.pass} passed; adblock.blockedCount() total ${[...new Set(lastSet.map((d) => d.webContentsId))].reduce((s, id) => s + adblock.blockedCount(id), 0)}`);
console.log(`blocked/redirected hosts (last pass): ${[...last.byHost].sort((a, b) => b[1] - a[1]).map(([h, c]) => `${h} ${c}`).join(', ')}`);
const gvTotal = lastSet.filter((d) => host(d.url).endsWith('googlevideo.com')).length;
const gvHit = [...last.byHost].filter(([h]) => h.endsWith('googlevideo.com')).reduce((s, [, c]) => s + c, 0);
console.log(`googlevideo.com media segments blocked: ${gvHit} of ${gvTotal} (must be 0)`);
