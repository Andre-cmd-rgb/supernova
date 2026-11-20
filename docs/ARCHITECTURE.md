# Supernova architecture

Supernova is a browser for Linux (Wayland first, built for Nova) that puts nothing
between you and the page. It runs on **castlabs' Electron for Content Security**
(upstream Electron plus Google's licensed Widevine), pinned in `electron.lock`.

Why Electron and not Qt WebEngine: measured on a ThinkPad P1 Gen 4i (3840x2400),
1080p30 AV1 in a YouTube-like page, Qt WebEngine drew every video frame twice
(its own pass plus Qt's) and made Hyprland redraw the whole window: **0.93 W of
GPU power against Chrome's 0.28 W**. Electron uses Chromium's own Wayland path,
so it matches Chrome on the GPU (0.28 W) while using a third less memory
(306 MiB against 483 MiB) and less CPU. See `bench/README.md`.

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
  heavy loops.
- Pure logic lives in modules that do not `require('electron')` at the top, so
  `node --test test/` can test them with plain Node. Electron objects are passed
  in (dependency injection).
- Data lives in `app.getPath('userData')` (`~/.config/supernova`). Writes are
  atomic (write `file.tmp`, then rename).

## Layout

```
src/main/main.js            entry: switches, single instance, services, first window
src/main/flags.js           Chromium switches (Wayland, VA-API, GPU pinning, memory)
src/main/store.js           JsonStore: settings and small JSON files, atomic + debounced
src/main/window.js          SnWindow: one BaseWindow, the UI view and the tab views
src/main/tab.js             Tab: lazy view, freeze/discard, events
src/main/ipc.js             IPC between the UI view and the main process
src/main/shortcuts.js       keyboard shortcuts (before-input-event on every webContents)
src/main/theme.js           Nova theme colours (+ fallback), live reload
src/main/downloads.js       downloads
src/main/permissions.js     permission prompts and remembered decisions
src/main/protocol.js        supernova:// internal pages
src/main/url.js             input -> URL or Google search (pure)
src/main/search.js          Google suggestions
src/main/history.js         history store            (agent A)
src/main/bookmarks.js       bookmarks store          (agent A)
src/main/passwords.js       password vault           (agent A)
src/main/autofill-ipc.js    password autofill, main side (agent A)
src/main/import/chrome.js   import from Chrome/Chromium/Brave profiles (agent A)
src/main/import/csv.js      import Google Password Manager CSV (agent A)
src/main/adblock.js         ad and tracker blocking    (agent B)
src/main/media-policy.js    video quality / frame-rate policy per power source (agent B)
src/preload/page-preload.js preload for every web page frame (bundled to dist/)
src/preload/autofill.js     password autofill, page side (agent A; imported by page-preload)
src/preload/media-shim.js   main-world shim: quality caps + rAF throttle (agent B)
src/preload/ui-preload.js   preload for the browser UI (exposes window.sn)
src/ui/                     the browser UI (sidebar / top bar, command bar, prompts)
src/pages/                  internal pages: settings, error
tools/build.mjs             esbuild: bundles the preloads into dist/preload/
test/                       node:test unit tests
bench/                      the measurements behind every efficiency claim
packaging/                  launcher, .desktop, Arch PKGBUILD
```

Preloads run sandboxed, so they cannot `require` local files at run time:
`tools/build.mjs` bundles `src/preload/*-preload.js` with esbuild into
`dist/preload/`. Modules imported by a preload must only use `require('electron')`
(contextBridge, ipcRenderer, webFrame) and plain JS.

## Services (created once in main.js, passed around)

```js
const services = {
  settings,   // JsonStore('settings.json')
  history,    // createHistory({ dir })
  bookmarks,  // createBookmarks({ dir })
  vault,      // createVault({ dir, safeStorage })
  adblock,    // createAdblock({ cacheDir, settings })
  media,      // createMediaPolicy({ settings, power })
  power,      // { onBattery(): bool, on('change', fn) }  (wraps electron.powerMonitor)
};
```

### JsonStore (`src/main/store.js`, core)

```js
const store = new JsonStore(filePath, defaults);   // loads synchronously at startup
store.get('adblock.enabled')            // dotted keys, falls back to defaults
store.set('adblock.enabled', false)     // schedules an atomic write (200 ms debounce)
store.on('change', (key, value) => {})  // EventEmitter
await store.flush()
```

Settings keys (defaults):

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

## Agent A: data, passwords, import

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
  in the page's isolated world (preload), in every frame. It finds login forms
  (a visible password field plus the nearest username/email field), asks
  `ipcRenderer.invoke('sn:pw:query', { origin, frameUrl })` for candidates and
  fills when there is exactly one (on load, and again for fields that appear
  later); with several it fills the first and offers the rest on focus (a tiny
  in-page dropdown in a closed shadow root). On submit (form submit, or a click
  on the submit button / Enter in the password field followed by navigation)
  it sends `ipcRenderer.send('sn:pw:submitted', { origin, username, password })`.
  It must never fill into cross-origin iframes with the top frame's passwords:
  the origin used is the frame's own.
- `src/main/autofill-ipc.js` exports
  `registerAutofillIpc({ ipcMain, vault, settings, promptSave })` which handles
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
detectProfiles()   // -> [{ browser: 'chrome'|'chromium'|'brave'|'vivaldi'|'edge',
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

## Agent B: ad blocking and media policy

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
  `{ current() -> { maxHeight, maxFps, rafFps }, on('change', fn) }`.
  `maxHeight` 0 = no cap; `maxFps` 0 = no cap; `rafFps` 0 = no throttle.
  On battery: `maxHeight = video.maxHeightOnBattery`,
  `maxFps = prefer30fps ? 30 : 0`, `rafFps = animations.limitOnBattery ? 30 : 0`.
  On AC: `video.maxHeightOnAC`, 0, 0.
- `src/preload/media-shim.js` exports `applyMediaShim(config)`: a **self-contained
  function** (no closure variables, no imports; it is serialized and run in the
  page's main world with `contextBridge.executeInMainWorld`). It may be called
  again with a new config: keep state on a hidden global (e.g. a Symbol on
  `window`) and only install wrappers once.
  - Wrap `MediaSource.isTypeSupported`, `ManagedMediaSource.isTypeSupported`
    if present, and `navigator.mediaCapabilities.decodingInfo` so that video
    types whose `height`/`width` (YouTube passes `width=`, `height=`,
    `framerate=` in the type string; decodingInfo has `video.height`,
    `video.framerate`) exceed the cap are reported unsupported. Never touch
    audio-only types. Never reject the lowest tiers (<= 480p).
  - `rafFps`: wrap `requestAnimationFrame`/`cancelAnimationFrame` so callbacks
    run at most `rafFps` times a second, timestamps stay monotonic and
    cancellation works. Off (`rafFps` 0) must mean the original functions.
  - Must not be detectable as broken by sites (keep `toString` reasonable,
    keep `this` binding and return types).
- The core's page preload calls it at document start:
  `const cfg = ipcRenderer.sendSync('sn:media:config')` then
  `contextBridge.executeInMainWorld({ func: applyMediaShim, args: [cfg] })`,
  and again on `ipcRenderer.on('sn:media:config', (_, cfg) => ...)`.

## IPC between the UI view and the main process (core)

`window.sn` (ui-preload) exposes:
`sn.onState(fn)` (main pushes a whole state snapshot, debounced to one per
frame), `sn.cmd(name, ...args)` (fire and forget), `sn.invoke(name, ...args)`
(request/response, e.g. `suggest`).
