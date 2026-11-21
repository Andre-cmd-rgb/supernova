'use strict';
// Supernova's main process: switches, sessions, services, windows.

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const electron = require('electron');
const {
  app, session, protocol, net, ipcMain, powerMonitor, nativeTheme, shell, safeStorage,
  desktopCapturer, webContents, dialog,
} = electron;

const { applySwitches } = require('./flags');
const { registerScheme, attach: attachProtocol } = require('./protocol');
const { JsonStore } = require('./store');
const { ThemeWatcher } = require('./theme');
const { createPower } = require('./power');
const { createSuggester } = require('./search');
const { createShortcuts } = require('./shortcuts');
const { createDownloads } = require('./downloads');
const { createPermissions } = require('./permissions');
const { registerIpc } = require('./ipc');
const { fixup, displayHost, originOf } = require('./url');

const ROOT = path.join(__dirname, '..', '..');
const VERSION = require(path.join(ROOT, 'package.json')).version;

// ----- before ready -----------------------------------------------------------

app.setName('Supernova');
app.setPath('userData', path.join(app.getPath('appData'), 'supernova'));
if (process.env.SUPERNOVA_PROFILE) app.setPath('userData', path.resolve(process.env.SUPERNOVA_PROFILE));
app.setDesktopName('supernova.desktop');

const argv = process.argv.slice(app.isPackaged ? 1 : 2);
const startPrivate = argv.includes('--private') || argv.includes('--incognito');
applySwitches(app);
// The ad blocker is loaded before ready: its surrogate scheme has to be
// registered along with supernova:// (one registration per run).
const adblockModule = optional('./adblock', {});
registerScheme(protocol, adblockModule.SCHEME ? [adblockModule.SCHEME] : []);

// Sites see Chrome, which they all support; "Electron" in the user agent makes
// some of them (Google sign-in, Zoom) refuse or degrade.
const chromeMajor = String(process.versions.chrome || '0').split('.')[0];
app.userAgentFallback = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;

if (!app.requestSingleInstanceLock({ argv })) {
  app.quit();
  process.exit(0);
}

const { DEFAULTS, checkSetting } = require('./settings-schema');

function optional(modPath, fallback) {
  try {
    return require(modPath);
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND' || !String(err.message).includes(path.basename(modPath))) throw err;
    console.warn(`supernova: ${modPath} missing, running without it`);
    return fallback;
  }
}

function urlsFrom(args, cwd) {
  const out = [];
  for (const a of args) {
    if (!a || a.startsWith('-')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(a)) out.push(a);
    // sync-ok: a stat per command-line argument, at start or a second launch
    else if (fs.existsSync(path.resolve(cwd || process.cwd(), a))) out.push('file://' + path.resolve(cwd || process.cwd(), a));
    else { const u = fixup(a); if (u) out.push(u); }
  }
  return out;
}

// ----- state --------------------------------------------------------------------

const windows = new Set();
let lastFocused = null;
let services = null;
let themeWatcher = null;
let power = null;
let downloads = null;
let permissions = null;
let shortcuts = null;
let suggester = null;
let sessionStore = null;
let privateSession = null;
let quitting = false;
const promptHandlers = new Map(); // prompt id -> resolver (password prompts)
let nextPromptId = 1;
const pagePreload = path.join(ROOT, 'dist', 'preload', 'page-preload.js');

const ctx = {
  electron,
  get services() { return services; },
  get power() { return power; },
  get downloads() { return downloads; },
  get shortcuts() { return shortcuts; },
  frame: !(process.env.HYPRLAND_INSTANCE_SIGNATURE || process.env.SWAYSOCK || process.env.NIRI_SOCKET ||
    /hyprland|sway|niri|river/i.test(process.env.XDG_CURRENT_DESKTOP || '')),
  icon: path.join(ROOT, 'assets', 'icons', 'supernova-256.png'),
  uiFile: path.join(ROOT, 'src', 'ui', 'index.html'),
  uiPreload: path.join(ROOT, 'dist', 'preload', 'ui-preload.js'),
  theme: () => (themeWatcher ? themeWatcher.current : { background: '#ffffff', mode: 'light' }),
  sessionFor,
  focused: (w) => { lastFocused = w; },
  lifecyclePolicy,
  onNavigated(w, tab, url) {
    if (!w.private && services.history && /^https?:/.test(url)) services.history.add({ url, title: tab.title });
  },
  onTitle(w, tab, title) {
    if (!w.private && services.history && /^https?:/.test(tab.url)) services.history.updateTitle(tab.url, title);
  },
  wireTab(w, tab, wc) {
    // A page asking "leave this site?" (unsaved work): ask, as Chrome does.
    wc.on('will-prevent-unload', (e) => {
      // sync-ok: Electron needs the answer before the event returns.
      const choice = dialog.showMessageBoxSync(w.base, {
        type: 'question', buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1,
        title: 'Leave site?', message: 'Leave site?', detail: 'Changes you made may not be saved.',
      });
      if (choice === 0) e.preventDefault();
      // Staying cancels a quit in progress: the next one starts over.
      else { quitting = false; flushedForQuit = false; }
    });
  },
  pendingPrompts(tab) {
    const list = permissions ? permissions.pendingFor(tab) : [];
    for (const [id, h] of promptHandlers) if (h.tab === tab) list.push({ cancel: () => h.resolve('dismiss', id) });
    return list;
  },
  newWindow,
  windowForWebContents,
  findTab,
  toggleBookmark(w) {
    const t = w.active;
    if (!t || !/^https?:/.test(t.url) || !services.bookmarks) return;
    services.bookmarks.toggle({ url: t.url, title: t.title });
    w.pushState();
  },
  toggleSidebar() {
    services.settings.set('sidebar.visible', services.settings.get('sidebar.visible') === false);
  },
  setSetting(key, value) { services.settings.set(key, value); },
  toggleDevTools(w) {
    const wc = w.active && w.active.webContents;
    if (!wc) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools(); else wc.openDevTools({ mode: 'detach' });
  },
  openSettings(w, hash = '', { background = false } = {}) {
    const existing = w.tabs.find((t) => t.url.startsWith('supernova://settings'));
    if (existing) { if (!background) w.activate(existing); if (hash) existing.navigate(`supernova://settings/${hash}`); return; }
    w.newTab({ url: `supernova://settings/${hash}`, background, lazy: background });
  },
  openDownloadsFolder() { downloads.openFolder(); },
  quit() { app.quit(); },
  respondPrompt(w, id, action, data) {
    if (permissions && permissions.respond(id, action)) return;
    const h = promptHandlers.get(id);
    if (h) h.resolve(action, id, data);
  },
  async suggest(w, query) { return suggestFor(w, query); },
  async suggestRemote(w, query) {
    const q = query.trim();
    if (!q || w.private || !services.settings.get('search.suggestions')) return [];
    const direct = fixup(q);
    if (direct && !direct.startsWith('https://www.google.com/search?q=')) return [];
    return (await suggester(q)).map((s) => ({ type: 'search', title: s, url: fixup(s), remote: true }));
  },
  tabMenu(w, tab) {
    const { Menu } = electron;
    Menu.buildFromTemplate([
      { label: 'Reload', click: () => tab.reload() },
      { label: 'Duplicate', enabled: !!tab.url, click: () => w.newTab({ url: tab.url, opener: tab }) },
      { label: tab.pinned ? 'Unpin (lets it sleep)' : 'Pin (keeps it awake)', click: () => w.setPinned(tab, !tab.pinned) },
      { label: tab.muted ? 'Unmute' : 'Mute', click: () => tab.setMuted(!tab.muted) },
      { type: 'separator' },
      { label: 'Close other tabs', click: () => { for (const t of w.tabs.filter((x) => x !== tab && !x.pinned)) w.closeTab(t); } },
      { label: 'Close', click: () => w.closeTab(tab) },
    ]).popup({ window: w.base });
  },
  internalApi: null,
};

function windowForWebContents(wc) {
  if (!wc) return null;
  for (const w of windows) {
    if (w.ui.webContents === wc || (w.float && w.float.webContents === wc)) return w;
    for (const t of w.tabs) if (t.webContents === wc) return w;
  }
  // DevTools or a popup's opener chain: fall back to the hosting window.
  return lastFocused && windows.has(lastFocused) ? lastFocused : [...windows][0] || null;
}

function findTab(wc) {
  if (!wc) return null;
  const host = wc.hostWebContents || wc;
  for (const w of windows) for (const t of w.tabs) if (t.webContents === host) return { win: w, tab: t };
  return null;
}

function lifecyclePolicy() {
  const s = services.settings;
  const mode = power.onBattery() ? 'battery' : 'ac';
  const f = s.get('tabs.freezeAfterMin') || {};
  const d = s.get('tabs.discardAfterMin') || {};
  return { freezeMs: (Number(f[mode]) || 0) * 60000, discardMs: (Number(d[mode]) || 0) * 60000 };
}

// ----- sessions ----------------------------------------------------------------

function setupSession(ses) {
  attachProtocol(ses, net);
  if (fs.existsSync(pagePreload)) { // sync-ok: once per session
    ses.registerPreloadScript({ type: 'frame', id: 'supernova-page', filePath: pagePreload });
  } else {
    console.warn('supernova: dist/preload missing; run `npm run build`');
  }
  if (services.adblock) services.adblock.attach(ses);
  downloads.attach(ses, (wc) => windowForWebContents(wc));
  permissions.attach(ses);
  try {
    const avail = new Set(ses.availableSpellCheckerLanguages);
    const want = [...app.getPreferredSystemLanguages(), 'en-US'].map((l) => l.replace('_', '-'))
      .filter((l, i, a) => avail.has(l) && a.indexOf(l) === i).slice(0, 3);
    if (want.length) ses.setSpellCheckerLanguages(want);
  } catch {}
}

function sessionFor(isPrivate) {
  if (!isPrivate) return session.defaultSession;
  if (!privateSession) {
    privateSession = session.fromPartition(`private-${Date.now()}`, { cache: false });
    setupSession(privateSession);
  }
  return privateSession;
}

// ----- windows -------------------------------------------------------------------

function newWindow(opts = {}) {
  const { SnWindow } = require('./window');
  const w = new SnWindow(ctx, opts);
  windows.add(w);
  lastFocused = w;
  w.on('session-changed', saveSessionSoon);
  w.on('close', () => {
    // The last ordinary window closing is what the next start restores;
    // any other window closing is simply forgotten.
    const others = [...windows].filter((x) => x !== w && !x.private);
    if (!w.private && !quitting) {
      if (others.length) saveSession(others);
      else saveSession([w]);
    }
  });
  w.on('closed', () => {
    windows.delete(w);
    if (lastFocused === w) lastFocused = [...windows].pop() || null;
    if (w.private && ![...windows].some((x) => x.private) && privateSession) {
      const ses = privateSession;
      privateSession = null;
      permissions.forgetPrivate();
      ses.clearStorageData().catch(() => {});
      ses.clearCache().catch(() => {});
    }
  });
  return w;
}

let saveTimer = null;
function saveSessionSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSession(), 1000);
}

function saveSession(list) {
  clearTimeout(saveTimer);
  const ws = (list || [...windows]).filter((w) => !w.private && !w.base.isDestroyed());
  if (!ws.length) return;
  sessionStore.replace({ version: 1, windows: ws.map((w) => w.sessionData()) });
}

// ----- the command bar --------------------------------------------------------------

async function suggestFor(w, query) {
  const q = query.trim();
  const out = [];
  if (!q) {
    // Empty: the open tabs, most recent first, then recent history.
    for (const t of w.tabs.filter((t) => t !== w.active).sort((a, b) => b.lastShown - a.lastShown).slice(0, 6)) {
      out.push({ type: 'tab', tabId: t.id, title: t.title || displayHost(t.url), url: t.url, favicon: t.favicon });
    }
    if (services.history && !w.private) {
      for (const h of services.history.recent(6)) if (!out.some((o) => o.url === h.url)) out.push({ type: 'history', title: h.title, url: h.url });
    }
    return out;
  }
  const lower = q.toLowerCase();
  const direct = fixup(q);
  const isUrl = direct && !direct.startsWith('https://www.google.com/search?q=');
  out.push(isUrl ? { type: 'url', title: direct, url: direct } : { type: 'search', title: q, url: direct });
  for (const t of w.tabs) {
    if (out.length >= 4) break;
    if ((t.title || '').toLowerCase().includes(lower) || (t.url || '').toLowerCase().includes(lower)) {
      out.push({ type: 'tab', tabId: t.id, title: t.title || displayHost(t.url), url: t.url, favicon: t.favicon });
    }
  }
  const seen = new Set(out.map((o) => o.url));
  if (services.bookmarks) {
    for (const b of services.bookmarks.search(q, 3)) if (!seen.has(b.url)) { seen.add(b.url); out.push({ type: 'bookmark', title: b.title, url: b.url }); }
  }
  if (services.history && !w.private) {
    for (const h of services.history.search(q, 5)) if (!seen.has(h.url)) { seen.add(h.url); out.push({ type: 'history', title: h.title, url: h.url }); }
  }
  // Google's suggestions are asked for separately (suggestRemote), so local
  // matches show at once.
  return out.slice(0, 10);
}

// ----- password prompts (hook for autofill-ipc) ----------------------------------------

function promptSave({ webContents: wc, origin, username, isUpdate }) {
  const found = findTab(wc);
  if (!found) return Promise.resolve('dismiss');
  const { win, tab } = found;
  return new Promise((resolve) => {
    const id = `pw-${nextPromptId++}`;
    const host = displayHost(origin) || origin;
    const h = {
      tab,
      resolve: (action) => {
        promptHandlers.delete(id);
        win.removePrompt(id);
        resolve(action === 'save' || action === 'never' ? action : 'dismiss');
      },
    };
    promptHandlers.set(id, h);
    win.addPrompt({
      id, tabId: tab.id, persistent: true,
      public: {
        id, kind: 'password', host,
        text: isUpdate ? `Update the saved password for ${username || 'this account'}?` : `Save the password${username ? ` for ${username}` : ''}?`,
        actions: [{ id: 'never', label: 'Never here' }, { id: 'dismiss', label: 'Not now' }, { id: 'save', label: isUpdate ? 'Update' : 'Save', primary: true }],
      },
    });
  });
}

// HTTP authentication (routers, intranets): a small prompt with two fields.
function promptLogin(wc, details, authInfo, callback) {
  const found = findTab(wc);
  if (!found) return callback();
  const { win, tab } = found;
  const id = `auth-${nextPromptId++}`;
  const h = {
    tab,
    resolve: (action, _id, data) => {
      promptHandlers.delete(id);
      win.removePrompt(id);
      if (action === 'login' && data) callback(String(data.username || ''), String(data.password || ''));
      else callback();
    },
  };
  promptHandlers.set(id, h);
  win.addPrompt({
    id, tabId: tab.id, persistent: true,
    public: {
      id, kind: 'auth', host: authInfo.host + (authInfo.port && ![80, 443].includes(authInfo.port) ? `:${authInfo.port}` : ''),
      text: authInfo.realm ? `asks you to sign in (“${authInfo.realm}”)` : 'asks you to sign in',
      fields: [{ name: 'username', label: 'Username' }, { name: 'password', label: 'Password', type: 'password' }],
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'login', label: 'Sign in', primary: true }],
    },
  });
}

function secretLookup(attrs) {
  const args = ['lookup'];
  for (const [k, v] of Object.entries(attrs || {})) args.push(k, String(v));
  return new Promise((resolve) => {
    execFile('secret-tool', args, { timeout: 15000 }, (err, stdout) => resolve(err ? null : String(stdout).replace(/\n$/, '') || null));
  });
}

// ----- internal pages' API ------------------------------------------------------------

function buildInternalApi() {
  const s = () => services.settings;
  let importedCsv = null;
  const importer = () => optional('./import/chrome', null);
  return {
    info: () => ({
      version: VERSION,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      userData: app.getPath('userData'),
      widevine: widevineStatus(),
      vault: services.vault ? services.vault.available() : { ok: false, backend: 'missing' },
      passwords: services.vault ? services.vault.count() : 0,
      onBattery: power.onBattery(),
      media: services.media ? services.media.current() : null,
      theme: ctx.theme(),
    }),
    getSettings: () => ({ ...DEFAULTS, ...s().data }),
    setSetting: (_e, key, value) => {
      checkSetting(key, value);
      s().set(key, value);
      return true;
    },
    detectProfiles: async () => {
      const imp = importer();
      return imp ? imp.detectProfiles() : [];
    },
    importProfile: async (_e, profileDir, what) => {
      const imp = importer();
      if (!imp) throw new Error('import is not available');
      const profile = (await imp.detectProfiles()).find((p) => p.dir === profileDir);
      if (!profile) throw new Error('profile not found');
      const report = await imp.importProfile(profile, {
        what: what || { passwords: true, bookmarks: true, history: true, cookies: true },
        vault: services.vault, bookmarks: services.bookmarks, history: services.history,
        cookies: session.defaultSession.cookies, secretLookup,
      });
      s().set('import.chromeDone', true);
      return report;
    },
    importCsv: async (e) => {
      const csv = optional('./import/csv', null);
      if (!csv) throw new Error('CSV import is not available');
      const w = windowForWebContents(e.sender);
      const r = await dialog.showOpenDialog(w ? w.base : undefined, {
        title: 'Import passwords', filters: [{ name: 'CSV', extensions: ['csv'] }], properties: ['openFile'],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      const report = await csv.importPasswordsCsv(r.filePaths[0], services.vault);
      importedCsv = r.filePaths[0];
      return { ...report, file: importedCsv };
    },
    deleteFile: async (_e, file) => {
      // Only the CSV the user just picked and imported, once.
      if (!importedCsv || file !== importedCsv) throw new Error('not allowed');
      importedCsv = null;
      await fs.promises.unlink(file);
      return true;
    },
    passwords: () => (services.vault ? services.vault.list() : []),
    removePassword: (_e, id) => (services.vault ? services.vault.remove(id) : false),
    clearData: async (_e, what) => {
      const ses = session.defaultSession;
      if (what.history && services.history) services.history.clear();
      if (what.cache) await ses.clearCache();
      if (what.cookies) await ses.clearStorageData();
      return true;
    },
    isDefaultBrowser: () => new Promise((resolve) => {
      execFile('xdg-settings', ['check', 'default-web-browser', 'supernova.desktop'], (err, out) => resolve(!err && /yes/.test(String(out))));
    }),
    setDefaultBrowser: () => new Promise((resolve) => {
      execFile('xdg-settings', ['set', 'default-web-browser', 'supernova.desktop'], (err) => resolve(!err));
    }),
    sitePermissions: () => s().get('permissions') || {},
    resetSite: (_e, origin) => { permissions.reset(origin); return true; },
    adblockUpdate: async () => { if (services.adblock && services.adblock.update) await services.adblock.update(); return true; },
    theme: () => ctx.theme(),
  };
}

function widevineStatus() {
  try {
    const comps = electron.components;
    if (!comps) return { available: false };
    const st = comps.status();
    const wv = Object.values(st || {}).find((c) => /widevine/i.test(c.title || c.name || ''));
    return { available: true, status: wv ? wv.status : 'pending', version: wv ? wv.version : null };
  } catch {
    return { available: false };
  }
}

// ----- start ---------------------------------------------------------------------------

app.on('second-instance', (_e, otherArgv, cwd, data) => {
  const args = (data && data.argv) || otherArgv.slice(1);
  const urls = urlsFrom(args, cwd);
  const wantPrivate = args.includes('--private') || args.includes('--incognito');
  if (wantPrivate || args.includes('--new-window') || !windows.size) {
    newWindow({ private: wantPrivate, url: urls[0] });
    return;
  }
  const w = lastFocused && windows.has(lastFocused) ? lastFocused : [...windows][0];
  for (const u of urls) w.newTab({ url: u });
  if (!urls.length) w.openPalette({ newTab: true });
  if (w.base.isMinimized()) w.base.restore();
  w.base.focus();
});

app.on('window-all-closed', () => app.quit());
// Quitting waits for history, bookmarks and passwords to reach the disk (their
// writes are async and debounced), at most 3 s, then quits for real.
let flushedForQuit = false;
app.on('before-quit', (event) => {
  quitting = true;
  saveSession();
  // sync-ok: the session and settings are on disk before anything else at quit.
  for (const st of [sessionStore, services && services.settings]) try { st && st.flushSync(); } catch {}
  if (flushedForQuit || !services) return;
  event.preventDefault();
  flushedForQuit = true;
  const writes = ['history', 'bookmarks', 'vault'].map((k) => {
    try { return services[k] ? Promise.resolve(services[k].flush()).catch(() => {}) : null; } catch { return null; }
  });
  const limit = new Promise((resolve) => setTimeout(resolve, 3000));
  Promise.race([Promise.all(writes), limit]).then(() => app.quit());
});

app.on('login', (event, wc, details, authInfo, callback) => {
  event.preventDefault();
  promptLogin(wc, details, authInfo, callback);
});

app.whenReady().then(async () => {
  const t0 = Date.now();
  const userData = app.getPath('userData');
  const firstRun = !fs.existsSync(path.join(userData, 'settings.json')); // sync-ok: startup
  const settings = new JsonStore(path.join(userData, 'settings.json'), DEFAULTS);
  if (firstRun) settings.set('tabs.position', settings.get('tabs.position'));
  sessionStore = new JsonStore(path.join(userData, 'session.json'), {}, { delay: 500 });
  power = createPower(powerMonitor);
  themeWatcher = new ThemeWatcher({ prefersDark: () => nativeTheme.shouldUseDarkColors });
  nativeTheme.themeSource = themeWatcher.current.mode;

  const { createHistory } = optional('./history', {});
  const { createBookmarks } = optional('./bookmarks', {});
  const { createVault } = optional('./passwords', {});
  const { registerAutofillIpc } = optional('./autofill-ipc', {});
  const { createAdblock } = adblockModule;
  const { createMediaPolicy } = optional('./media-policy', {});

  services = {
    settings,
    history: createHistory ? createHistory({ dir: userData }) : null,
    bookmarks: createBookmarks ? createBookmarks({ dir: userData }) : null,
    vault: createVault ? createVault({ dir: userData, safeStorage }) : null,
    adblock: createAdblock ? createAdblock({ cacheDir: path.join(userData, 'adblock'), settings }) : null,
    media: createMediaPolicy ? createMediaPolicy({ settings, power }) : null,
    downloads: null,
  };
  const timing = (label, since) => { if (process.env.SUPERNOVA_TIMING) console.log(`supernova: ${label} ${Date.now() - since} ms`); };
  await Promise.all(['history', 'bookmarks', 'vault'].map((k) => {
    const t = Date.now();
    return services[k] && services[k].load().then(() => timing(`load ${k}`, t), (err) => {
      console.error(`supernova: could not load ${k}:`, err.message);
    });
  }));
  if (services.adblock) {
    const t = Date.now();
    try { await services.adblock.init(); } catch (err) { console.error('supernova: ad blocking unavailable:', err.message); }
    timing('adblock init', t);
  }

  downloads = createDownloads({ settings, app, shell });
  services.downloads = downloads;
  permissions = createPermissions({ settings, findTab, desktopCapturer });
  shortcuts = createShortcuts(ctx);
  suggester = createSuggester((url, opts) => net.fetch(url, opts), { lang: (app.getLocale() || 'en').split('-')[0] });
  ctx.internalApi = buildInternalApi();
  registerIpc(ctx);
  if (registerAutofillIpc && services.vault) registerAutofillIpc({ ipcMain, vault: services.vault, settings, promptSave });

  setupSession(session.defaultSession);

  // Live changes: theme, settings, power, media policy, downloads.
  themeWatcher.on('change', (theme) => {
    nativeTheme.themeSource = theme.mode;
    for (const w of windows) { w.base.setBackgroundColor(theme.background); w.pushState(); }
  });
  settings.on('change', (key) => {
    if (key === 'tabs.position' || key === 'sidebar.visible') for (const w of windows) { w.layout(); w.pushState(); }
    if (key.startsWith('tabs.')) for (const w of windows) for (const t of w.tabs) t.reschedule();
  });
  power.on('change', () => {
    for (const w of windows) { for (const t of w.tabs) t.reschedule(); w.pushState(); }
  });
  if (services.media) {
    services.media.on('change', (cfg) => {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed() || wc.getType() === 'remote') continue;
        try { for (const f of wc.mainFrame.framesInSubtree) f.send('sn:media:config', cfg); } catch {}
      }
    });
  }
  downloads.on('change', () => { for (const w of windows) w.pushState(); });
  if (services.adblock && services.adblock.on) {
    let pending = null;
    services.adblock.on('blocked', () => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; for (const w of windows) w.pushState(); }, 500);
    });
  }

  // Restore the last session, then open what the command line asked for.
  const urls = urlsFrom(argv);
  const saved = !startPrivate && sessionStore.data && Array.isArray(sessionStore.data.windows) ? sessionStore.data.windows : [];
  if (startPrivate) newWindow({ private: true, url: urls[0] });
  else if (saved.length) {
    saved.forEach((sw, i) => newWindow({ ...sw, url: i === saved.length - 1 ? urls[0] : undefined }));
    const last = [...windows].pop();
    for (const u of urls.slice(1)) last.newTab({ url: u });
  } else {
    const w = newWindow({ url: urls[0] });
    for (const u of urls.slice(1)) w.newTab({ url: u });
    // First start: the welcome page (import from Chrome). If a link opened
    // the browser, that link stays in front and the welcome waits beside it.
    if (firstRun) ctx.openSettings(w, '#welcome', { background: urls.length > 0 });
  }

  if (services.adblock && services.adblock.scheduleUpdate) services.adblock.scheduleUpdate();
  // Widevine (Netflix, Spotify): castlabs' component updater installs and
  // updates it in the background; nothing waits for it.
  try { if (electron.components) electron.components.whenReady().catch(() => {}); } catch {}
  if (process.env.SUPERNOVA_TIMING) console.log(`supernova: ready in ${Date.now() - t0} ms after app ready`);
  if (process.env.SUPERNOVA_SMOKE === '1') smokeTest();
});

// SUPERNOVA_SMOKE=1 (CI, packaging checks): start, open the settings page,
// check that the bundled page preload and the internal API answer there and
// that the browser UI loaded, print one line and quit with 0, or 1 on failure.
async function smokeTest() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (why) => { console.log(`supernova: smoke FAILED ${why}`); app.exit(1); };
  const timer = setTimeout(() => fail('timeout'), Number(process.env.SUPERNOVA_SMOKE_TIMEOUT_MS) || 30000);
  try {
    const w = [...windows][0];
    if (!w) return fail('no window');
    ctx.openSettings(w);
    const wc = w.active && w.active.webContents;
    if (!wc) return fail('no settings tab');
    let info = null;
    for (let i = 0; i < 100 && !info; i++) {
      await sleep(100);
      if (wc.isLoading()) continue;
      info = await wc.executeJavaScript('window.supernova ? window.supernova.invoke("info") : null').catch(() => null);
    }
    if (!info) return fail('settings page: no internal API (page preload missing?)');
    const ui = await w.ui.webContents.executeJavaScript('document.readyState + " " + !!window.sn');
    if (ui !== 'complete true') return fail(`browser UI: ${ui}`);
    // A web page cannot reach the internal pages: neither by navigating
    // itself there nor through window.open (url.js mayOpen, window.js).
    const page = w.newTab({ url: 'data:text/html,<title>web page</title>' });
    for (let i = 0; i < 50 && (!page.webContents || page.webContents.isLoading() || !page.webContents.getURL().startsWith('data:')); i++) await sleep(100);
    const pwc = page.webContents;
    if (!pwc || !pwc.getURL().startsWith('data:')) return fail('could not open a web page');
    await pwc.executeJavaScript('location.href = "supernova://settings/"; 1').catch(() => null);
    const popup = await pwc.executeJavaScript('!!window.open("supernova://settings/")').catch(() => null);
    await sleep(500);
    if (!pwc.getURL().startsWith('data:')) return fail(`a web page navigated itself to ${pwc.getURL()}`);
    if (popup !== false) return fail('a web page opened supernova://settings with window.open');
    await pwc.executeJavaScript('const f = document.createElement("iframe"); f.src = "supernova://settings/"; document.body.append(f); 1').catch(() => null);
    await sleep(500);
    const inner = pwc.mainFrame.frames.map((f) => f.url).filter((u) => u.startsWith('supernova:'));
    if (inner.length) return fail(`a web page framed ${inner[0]}`);
    clearTimeout(timer);
    console.log(`supernova: smoke ok ${JSON.stringify({
      version: info.version, electron: info.electron, chrome: info.chrome, vault: info.vault && info.vault.backend,
      media: info.media, services: Object.keys(services).filter((k) => services[k]),
    })}`);
    app.exit(0);
  } catch (err) {
    fail(err.message);
  }
}
