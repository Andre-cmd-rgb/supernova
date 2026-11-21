# Supernova architecture

Supernova is a browser for Linux (Wayland first, built for Nova) that puts nothing
between you and the page. It runs on **castlabs' Electron for Content Security**
(upstream Electron plus Google's licensed Widevine), pinned in `electron.lock`.

Why Electron and not Qt WebEngine: in an early test on a ThinkPad P1 Gen 4i
(3840x2400), with 1080p30 AV1 in a YouTube-like page, Qt WebEngine drew every
video frame twice (its own pass plus Qt's) and made Hyprland redraw the whole
window: **0.93 W of GPU power against Chrome's 0.28 W**. Electron uses
Chromium's own Wayland path and video pipeline, so it costs what Chrome costs.
Measurements of the finished browser against Chrome on real YouTube are in
`bench/README.md`.

## Rules for all code

- CommonJS everywhere (`require`), no TypeScript, no frameworks, no new runtime
  dependencies without a reason written down here. Node 24 (Electron 45's).
- Nothing phones home. Network use is limited to: what the user browses, Google
  search suggestions while typing in the command bar, ad-block list updates
  (once a day), Widevine component updates (castlabs/Google), spellcheck
  dictionaries.
- Nothing runs when nothing happens: no polling timers, no looping UI
  animations. Timers are single-shot and scheduled for when they are due.
- The main process thread stays light: every request passes through it for ad
  blocking, so no synchronous disk I/O after startup (use `fs.promises`), no
  heavy loops. A blocking call that cannot be avoided (Electron needs a
  download's save path, or a "leave site?" answer, before its event returns)
  carries a `// sync-ok: <reason>` comment; `test/source-rules.test.js` fails
  on any `*Sync(` call in `src/main` without one.
- Pure logic lives in modules that do not `require('electron')` at the top, so
  `npm test` can test them with plain Node. Electron objects are passed in
  (dependency injection); only `main.js`, `window.js` and `tab.js` load
  Electron at the top (`test/source-rules.test.js` holds this). `npm test` is
  `tools/test.sh`: every `test/*.test.js` under `env -i`, with a throwaway
  HOME, XDG dirs and TMPDIR and a D-Bus address that leads nowhere, so no test
  can read or write the user's profile, keyring or session bus, and nothing a
  test leaves behind outlives the run.
- Web content is untrusted, and so is everything a page's renderer sends. A
  page never reaches `supernova://` or `file://` (see "Internal pages"), IPC
  from the browser UI is accepted only from a window's own UI and float views,
  and handlers take origins from `event.senderFrame`, never from a payload.
- Data lives in `app.getPath('userData')` (`~/.config/supernova`). Writes are
  atomic (write `file.tmp`, then rename).

## Layout

```
src/main/main.js            entry: switches, single instance, services, first window
src/main/flags.js           Chromium switches (Wayland, VA-API, GPU pinning, memory)
src/main/store.js           JsonStore: settings and small JSON files, atomic + debounced
src/main/settings-schema.js the settings' defaults, and what the settings page may write
src/main/window.js          SnWindow: one BaseWindow, the UI view and the tab views
src/main/tab.js             Tab: lazy view, freeze/discard, events
src/main/ipc.js             IPC between the UI view and the main process
src/main/shortcuts.js       keyboard shortcuts (before-input-event on every webContents)
src/main/theme.js           Nova theme colours (+ fallback), live reload
src/main/downloads.js       downloads
src/main/permissions.js     permission prompts and remembered decisions
src/main/protocol.js        supernova:// internal pages
src/main/url.js             typed input -> URL or search; command-line args; what a page may open
src/main/search.js          Google suggestions
src/main/power.js           battery or mains (powerMonitor; SUPERNOVA_FORCE_BATTERY=1|0)
src/main/history.js         history store
src/main/bookmarks.js       bookmarks store
src/main/passwords.js       password vault
src/main/autofill-ipc.js    password autofill, main side
src/main/import/chrome.js   import from Chrome/Chromium/Brave profiles
src/main/import/csv.js      import Google Password Manager CSV
src/main/adblock.js         ad and tracker blocking
src/main/media-policy.js    video quality / frame-rate policy per power source
src/preload/page-preload.js preload for every web page frame (bundled to dist/)
src/preload/autofill.js     password autofill, page side (imported by page-preload)
src/preload/media-shim.js   main-world shim: quality caps + rAF throttle
src/preload/ui-preload.js   preload for the browser UI (exposes window.sn)
src/ui/                     the browser UI (sidebar / top bar, command bar, prompts)
src/pages/                  internal pages: settings, error
tools/build.mjs             esbuild: bundles the preloads into dist/preload/
tools/fetch-electron.sh     downloads and checks the castlabs build electron.lock pins
tools/run-dev.sh            runs the source tree on that build
tools/test.sh               npm test: the unit tests in a clean environment
tools/smoke.sh              starts a build headless and checks it (CI, PKGBUILD check())
tools/lint-packaging.sh     shellcheck, actionlint, desktop entry, PKGBUILD vs electron.lock
tools/cdp.mjs               evaluates JS in a running instance over the DevTools protocol
test/                       node:test unit tests
bench/                      the measurements behind every efficiency claim
packaging/supernova         the /usr/bin launcher (unsets ELECTRON_RUN_AS_NODE)
packaging/supernova.desktop the desktop entry: web browser, New Window, New Private Window
packaging/arch/PKGBUILD     the Arch package; check() runs the unit tests and tools/smoke.sh
.github/workflows/ci.yml    CI: lint, tests and smoke from source; makepkg, install, smoke
```

Preloads run sandboxed, so they cannot `require` local files at run time:
`tools/build.mjs` bundles `src/preload/*-preload.js` with esbuild into
`dist/preload/`. Modules imported by a preload must only use `require('electron')`
(contextBridge, ipcRenderer, webFrame) and plain JS.

## Services (created once in main.js, passed around)

```js
const services = {
  settings,   // JsonStore('settings.json', DEFAULTS from settings-schema.js)
  history,    // createHistory({ dir })
  bookmarks,  // createBookmarks({ dir })
  vault,      // createVault({ dir, safeStorage })
  adblock,    // createAdblock({ cacheDir, settings })
  media,      // createMediaPolicy({ settings, power })
  downloads,  // createDownloads(...)
};
```

`power` (`src/main/power.js`: `{ onBattery(), on('change', fn) }`, wrapping
`electron.powerMonitor`) is on the shared `ctx`, next to the services.

At quit, the browser waits (at most 3 s) for history, bookmarks and the vault
to finish writing before it exits; the session and settings are written
synchronously first.

### JsonStore (`src/main/store.js`, core)

```js
const store = new JsonStore(filePath, defaults);   // loads synchronously at startup
store.get('adblock.enabled')            // dotted keys, falls back to defaults
store.set('adblock.enabled', false)     // schedules an atomic write (200 ms debounce)
store.on('change', (key, value) => {})  // EventEmitter
await store.flush()
```

Settings keys (defaults, in `src/main/settings-schema.js`). The settings page
may write only the keys it has a control for, with the values it offers
(`WRITABLE` there; a test ties it to `settings.html`): never `downloads.dir`,
`permissions`, `zoom.perHost` or `passwords.never`, which the browser writes
itself.

| key | default | meaning |
|---|---|---|
| `tabs.position` | `"left"` | `"left"` (vertical sidebar) or `"top"` |
| `sidebar.visible` | `true` | Ctrl+S toggles |
| `search.engine` | `"google"` | only Google in beta 1 |
| `search.suggestions` | `true` | Google suggestions in the command bar |
| `adblock.enabled` | `true` | |
| `adblock.allowlist` | `[]` | hostnames (registrable domains) with blocking off |
| `adblock.cookieBanners` | `false` | also hide cookie-consent banners |
| `video.maxHeightOnBattery` | `1080` | 0 = no cap; 720/1080/1440/2160 |
| `video.maxHeightOnAC` | `0` | |
| `video.prefer30fpsOnBattery` | `false` | reject >30 fps streams on battery |
| `animations.limitOnBattery` | `true` | requestAnimationFrame at 30 fps on battery |
| `tabs.freezeAfterMin` | `{ "ac": 10, "battery": 2 }` | hidden tab -> frozen (no JS, no timers) |
| `tabs.discardAfterMin` | `{ "ac": 120, "battery": 30 }` | hidden tab -> renderer closed |
| `passwords.offerToSave` | `true` | |
| `passwords.never` | `[]` | origins never to offer saving for |
| `import.chromeDone` | `false` | first-run import offered and done |
| `zoom.perHost` | `{}` | host -> zoom factor |
| `downloads.dir` | `""` | empty = XDG download dir |
| `permissions` | `{}` | `"<origin>": { "<permission>": "allow" \| "deny" }` |

## Data: history, bookmarks, passwords, import

### History (`src/main/history.js`)

```js
const history = createHistory({ dir });          // file: dir/history.json
await history.load();
history.add({ url, title, at = Date.now() });     // visit; ignores non-http(s)
history.updateTitle(url, title);
history.search(query, limit = 8)  // -> [{ url, title, visits, lastVisit, score }]
history.recent(limit = 50)
history.remove(url); history.clear();
history.importMany([{ url, title, visits, lastVisit }])  // merge, keep the best
await history.flush();
```

Ranking: frecency (visit count weighted by recency) times match quality
(prefix of host > prefix of a word in title/url > substring). Keep at most
20 000 entries (drop the lowest frecency). Fast: `search` on 20 000 entries must
take under 5 ms (it runs on every keystroke in the command bar).

### Bookmarks (`src/main/bookmarks.js`)

```js
const bookmarks = createBookmarks({ dir });       // file: dir/bookmarks.json
await bookmarks.load();
bookmarks.list()                  // -> [{ id, url, title, folder, added }]
bookmarks.has(url)
bookmarks.toggle({ url, title })  // -> true if now bookmarked
bookmarks.remove(url)
bookmarks.search(query, limit = 5)
bookmarks.importMany([{ url, title, folder }])
await bookmarks.flush();
```

### Password vault (`src/main/passwords.js`)

```js
const vault = createVault({ dir, safeStorage });  // file: dir/passwords.vault
await vault.load();
vault.available()   // -> { ok, backend } ; ok=false if safeStorage would use the
                    //    hard-coded 'basic_text' key (then refuse to store anything)
vault.count()
vault.list()                          // -> [{ id, origin, username, updated }]  (no secrets)
vault.find(origin)                    // -> [{ id, origin, username, password }]
vault.save({ origin, username, password })   // upsert by (origin, username)
vault.remove(id)
vault.importMany(entries)             // -> { added, updated, skipped }
await vault.flush();
```

`origin` is `scheme://host[:port]`. Matching for autofill: exact origin first,
then same registrable domain over https (accounts.google.com vs google.com is
NOT merged unless exact; keep it simple and safe: exact origin, plus http->https
upgrade of the same host). The whole vault is one JSON blob encrypted with
`safeStorage.encryptString`; main.js appends the switch
`--password-store=gnome-libsecret`, so the key lives in the login keyring.

### Autofill

- `src/preload/autofill.js` exports `installAutofill({ ipcRenderer })`. It runs
  in the page's isolated world (preload), in every frame (tabs set
  `nodeIntegrationInSubFrames`, which adds the preload to subframes, still
  sandboxed). It finds login forms
  (a visible password field plus the nearest username/email field), asks
  `ipcRenderer.invoke('sn:pw:query', { origin, frameUrl })` for candidates and
  fills when there is exactly one (on load, and again for fields that appear
  later); with several it fills the first and offers the rest on focus (a tiny
  in-page dropdown in a closed shadow root). It fills by itself only in a
  secure context (https, or http to this machine) and in frames of the top
  page's own origin; elsewhere (plain http to another machine, a cross-origin
  iframe) it offers the saved logins when the user focuses the field. A
  username typed on one step of a two-step sign-in is reported with
  `ipcRenderer.send('sn:pw:username', { username })`, so the password step can
  be saved with it. On submit (form submit, or a click
  on the submit button / Enter in the password field followed by navigation)
  it sends `ipcRenderer.send('sn:pw:submitted', { origin, username, password })`.
  It must never fill into cross-origin iframes with the top frame's passwords:
  the origin used is the frame's own.
- `src/main/autofill-ipc.js` exports
  `registerAutofillIpc({ ipcMain, vault, settings, promptSave })` which handles
  `sn:pw:username` (kept per tab and origin for ten minutes), and
  `sn:pw:query` (returns matches for the sender frame's real origin, taken from
  `event.senderFrame.origin`, never from the payload) and `sn:pw:submitted`
  (skips private sessions: `event.sender.session.isPersistent() === false`;
  skips origins in `passwords.never`; skips when the same password is already
  saved; otherwise calls
  `promptSave({ webContents: event.sender, origin, username, isUpdate })`, which
  the core provides and which resolves to `'save' | 'never' | 'dismiss'`).

### Import

```js
const { detectProfiles, importProfile } = require('./import/chrome');
await detectProfiles()  // -> [{ browser: 'chrome'|'chromium'|'brave'|'vivaldi'|'edge',
                        //       name, dir, passwords: n|null, bookmarks: n|null }]
await importProfile(profile, {
  what: { passwords: true, bookmarks: true, history: true, cookies: true },
  vault, bookmarks, history,
  cookies: session.cookies,          // electron Cookies object, or null
  secretLookup,                      // async (attrs) -> string|null; core passes a
                                     // wrapper around `secret-tool lookup`
}) // -> { passwords: { added, updated, skipped, failed }, bookmarks, history, cookies, errors: [] }

const { importPasswordsCsv } = require('./import/csv');
await importPasswordsCsv(filePath, vault)   // Google Password Manager / Chrome CSV
```

Chrome on Linux: `Login Data` and `Cookies` are SQLite; read a copy (Chrome may
be running and hold a lock) with the `sqlite3` CLI (`sqlite3 -json`), not a
native module. Values starting `v10` use the key `peanuts`; `v11` use the
password stored in the keyring under `application=chrome` ("Chrome Safe
Storage"; `chromium` for Chromium, `brave` for Brave). Key = PBKDF2-SHA1(pass,
'saltysalt', 1 iteration, 16 bytes); AES-128-CBC, IV = 16 spaces. Cookie
databases with `meta.version >= 24` prepend SHA-256(host_key) (32 bytes) to the
plaintext; strip it. Chrome times are microseconds since 1601-01-01.
**Never log or print secrets**, not even in tests' failure messages.

## Ad blocking and media policy

### Ad blocking (`src/main/adblock.js`)

```js
const adblock = createAdblock({ cacheDir, settings });
await adblock.init();                 // loads the cached engine (fast), else builds from lists
adblock.attach(session);              // enable on a session (default + each private one)
adblock.isActiveFor(url)              // false if disabled or the site is allowlisted
adblock.setSiteEnabled(host, bool)    // updates settings 'adblock.allowlist'
adblock.blockedCount(webContentsId)   // requests blocked for the current page
adblock.on('blocked', ({ webContentsId, url }) => {})
adblock.scheduleUpdate()              // single-shot timer, lists refreshed once a day
adblock.update()                      // refresh the lists now (settings page); joins a running build
adblock.detach(session)               // stop blocking on a session
adblock.stats()                       // { ready, enabled, variant, source, builtAt, nextUpdateAt, ... }
adblock.close()                       // clear timers, detach every session (quit, tests)
```

Built on `@ghostery/adblocker-electron` (network blocking via
`session.webRequest`, cosmetic filtering and scriptlets via its preload). The
blocker must be the only user of `session.webRequest.onBeforeRequest` and
`onHeadersReceived`; the core does not use them. Per-site allowlist applies to
everything in a tab whose top-level page is on that site. YouTube's video ads
must be blocked (scriptlets), and blocking must not break YouTube playback,
Google sign-in, Netflix, Spotify, Zoom or Patchbay.

A top-level page is only blocked by a filter that names documents (`$document`,
`$doc`: uBO's badware list), never by a plain `||site^` or a negated type
(`$~xhr`), and never redirected. With `adblock.enabled` off, sessions are
unhooked and no lists are downloaded. A damaged cache is rebuilt from the
lists; with no cache and no network the browser starts without blocking and
retries with a doubling backoff (2 min up to 1 h). One list build runs at a
time. Behaviour: `test/adblock.test.js`; cost: `bench/adblock-cost.mjs`
(~11 ms engine load, ~8 us p50 / ~50 us p99 per request).

### Media policy

- `src/main/media-policy.js`:
  `createMediaPolicy({ settings, power })` ->
  `{ current() -> { battery, maxHeight, maxFps, rafFps }, on('change', fn), off, close }`.
  `maxHeight` 0 = no cap; `maxFps` 0 = no cap; `rafFps` 0 = no throttle.
  On battery: `maxHeight = video.maxHeightOnBattery` (a cap under 480 becomes
  480), `maxFps = video.prefer30fpsOnBattery ? 30 : 0`,
  `rafFps = animations.limitOnBattery === false ? 0 : 30`.
  On AC: `video.maxHeightOnAC`, 0, 0. `'change'` fires only when one of these
  values actually changes (a power or settings event that changes nothing is
  not pushed to pages).
- `src/preload/media-shim.js` exports `applyMediaShim(config)`: a **self-contained
  function** (no closure variables, no imports; it is serialized and run in the
  page's main world with `contextBridge.executeInMainWorld`). Calling it again
  updates the caps: the state lives on `globalThis[Symbol.for('supernova.media')]`
  and the wrappers are installed once.
  - `MediaSource.isTypeSupported`, `ManagedMediaSource.isTypeSupported` and
    `MediaCapabilities.prototype.decodingInfo` report video formats over the
    cap as unsupported (decodingInfo resolves `{ supported: false }` without
    asking the browser). With both width and height known the comparison is by
    pixel count (`maxHeight^2 * 16/9`, 10% slack), so a portrait 1080p stream
    is a 1080p stream; with one of them, by tier. The browser keeps the last
    word on everything under the cap. Audio types are never touched, and 480p
    and lower are never hidden, so a site always has something to play.
  - `rafFps`: `requestAnimationFrame`/`cancelAnimationFrame` (and the `webkit`
    names) run callbacks at most `rafFps` times a second. A single-shot timer
    waits until the next frame is due, then one real rAF runs the whole batch
    with the browser's vsync timestamp, so animations stay monotonic and on
    vsync. Throttled ids start at `0x40000000`, so cancelling works across a
    switch; with `rafFps` 0 calls go straight to the browser.
  - Every wrapper is a `Proxy` of the original: same `name`, `length` and
    `this` handling, a native-looking `toString`, nothing new on `window`.
- The page preload calls it at document start:
  `const cfg = ipcRenderer.sendSync('sn:media:config')` then
  `contextBridge.executeInMainWorld({ func: applyMediaShim, args: [cfg] })`,
  and again on every `sn:media:config` the main process pushes to every frame
  when the policy changes.
- Measured: the caps cost nothing on AC (all 0) and the rAF throttle halves
  animation frames on battery; YouTube's 1080p60 stream on battery costs what
  it costs on AC (`bench/README.md`).

## Window, input and startup

### Window (`src/main/window.js`)

One `BaseWindow` holds `WebContentsView`s: the **UI view** (sidebar or top
bar, command bar), the active tab's view, and the **float view**, which draws
over the page what must sit above it: permission and save-password prompts,
the find bar, download toasts. The float view is a whole renderer (~22 MiB), so
it exists only while something needs it: it is created on first use, hidden
when nothing is shown, and closed after 30 s with nothing in it
(`FLOAT_IDLE_MS`). Messages sent while it is starting are queued, and a focus
request made while it is hidden (find opened with Ctrl+F) is applied when it
is shown. Each tab's prompts stay pending while another tab is shown, and the
UI shows only the active tab's. Hidden tabs are frozen and later discarded on
the timers in `tabs.freezeAfterMin` / `tabs.discardAfterMin`; tabs that play
or capture are left alone. A tab the user typed text into (the page preload
reports the first trusted `input` event in a text field, textarea or editable
element, `sn:edited`) may be frozen but is not discarded until it navigates,
because a discard would lose the text; Chrome keeps tabs with form input the
same way. A private window's UI uses
the private session, so the favicons it shows leave nothing behind.

### Internal pages (`src/main/protocol.js`)

`supernova://settings` and `supernova://error` are served from `src/pages`;
each host serves only its own page, script and `pages.css`, nothing else. `internalAllowed(url, name)`
decides what `window.supernova.invoke()` may call, from the calling frame's
own URL (top frame only): the settings page (path `/`) the whole API, the
error page only `theme`. A web page cannot get there: `mayOpen(from, to)` in
`url.js` refuses `supernova:` and `file:` targets unless the page is one
itself, and `window.js` applies it to every cross-document navigation a page
starts (`will-frame-navigate`, judged by the frame that started it; a file
dropped on the page may open), to redirects, `window.open` and the context
menu. The error page retries only http(s) addresses. Smoke mode checks that a
page can neither navigate itself there, nor open it, nor frame it.

### Address input (`src/main/url.js`)

`fixupNav(input)` -> `{ url, upgraded }`: a URL is opened as typed; a bare host
gets `https://` (`upgraded: true`), except local-network hosts (`localhost`,
IP addresses, `name:port`, and the `.local`, `.lan`, `.home`, `.internal`,
`.home.arpa` and similar suffixes) and hosts with a port other than 443, which
get `http://`. Anything else, a bare single word included, is a Google
search. When an upgraded address fails to load, the tab retries it once over
http, as Chrome's HTTPS upgrades do, so a device with no TLS still opens; not
when the load was stopped (-3), the name does not resolve (-105, -137), the
machine is offline (-106) or the network changed (-21).

### Theme (`src/main/theme.js`)

Colours come from the current Nova theme,
`$XDG_STATE_HOME/nova/current/theme/` (`supernova.json` if the theme has one,
else `colors.toml`; `SUPERNOVA_THEME=<file>` overrides), and fall back to
built-in light and dark palettes. Nova switches themes by swapping a symlink;
the watch follows that and in-place rewrites, and the UI recolours live. A theme without `mode` is
dark when its background's relative luminance is under 0.3, else light; with
no background either, the desktop's colour-scheme preference decides.

### Chromium switches (`src/main/flags.js`)

Wayland (Ozone), VA-API decoding with zero copy, the PipeWire screen capturer,
`BackgroundVideoTrackOptimization` (a hidden video stops decoding; audio plays
on), the integrated GPU's render node so a discrete NVIDIA card stays asleep,
`gnome-libsecret` for the password key, and no crash reports, metrics or
pings. `SUPERNOVA_EXTRA_FEATURES=A,B` appends features for experiments
(`bench/yt-bench.mjs --features`).

### Smoke mode

With `SUPERNOVA_SMOKE=1` the browser checks itself at startup: it opens the
settings page, waits for the page preload's internal API (`info`) and the UI
view's `window.sn`, prints `supernova: smoke ok {...}` and exits 0, or prints
`supernova: smoke FAILED <why>` and exits 1. It also checks that a web page
can neither navigate itself to `supernova://settings`, nor open it with
`window.open`, nor load it in an iframe. `tools/smoke.sh` runs it headless
with a throwaway profile and an empty environment, in CI and in the PKGBUILD's
`check()`.

## IPC between the UI view and the main process (core)

`window.sn` (ui-preload) exposes:
`sn.on(channel, fn)` for `sn:state` (main pushes a whole state snapshot, at
most one per frame), `sn:palette`, `sn:find-open` and `sn:find-next`;
`sn.cmd(name, ...args)` (fire and forget) and `sn.invoke(name, ...args)`
(request/response, e.g. `suggest`). The main process accepts these only from
a window's own UI and float views.
