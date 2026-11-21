'use strict';
// One browser window: a BaseWindow holding the browser UI (sidebar or top
// bar, and the command bar when open), a small floating view for prompts and
// the find bar, and the tabs' pages. Only the active tab's page is attached.

const { BaseWindow, WebContentsView, Menu, clipboard, shell } = require('electron');
const { EventEmitter } = require('events');
const { Tab } = require('./tab');
const { fixupNav, displayHost, searchUrl, mayOpen } = require('./url');

const SIDEBAR_W = 240;
const TOPBAR_H = 40;
const FLOAT_IDLE_MS = 30000;

class SnWindow extends EventEmitter {
  /**
   * @param {object} ctx  shared context from main.js
   * @param {object} opts { private, bounds, tabs: [{url,title,favicon,pinned}], active }
   */
  constructor(ctx, opts = {}) {
    super();
    this.ctx = ctx;
    this.private = !!opts.private;
    this.session = ctx.sessionFor(this.private);
    this.tabs = [];
    this.active = null;
    this.closedTabs = [];
    this.overlay = false;
    this.htmlFullscreen = false;
    this.immersive = false;
    this.prompts = [];
    this.floatSize = { width: 0, height: 0 };
    this.findOpen = false;
    this._statePending = null;
    this._closing = false;

    const b = opts.bounds || {};
    this.base = new BaseWindow({
      width: b.width || 1400,
      height: b.height || 900,
      x: b.x,
      y: b.y,
      minWidth: 480,
      minHeight: 320,
      show: false,
      frame: ctx.frame,
      backgroundColor: ctx.theme().background,
      title: this.private ? 'Supernova (private)' : 'Supernova',
      icon: ctx.icon,
    });

    const uiPrefs = {
      preload: ctx.uiPreload,
      sandbox: true,
      contextIsolation: true,
      spellcheck: false,
      // The UI only repaints when state changes; nothing animates in it.
      backgroundThrottling: true,
      // A private window's UI loads its tabs' favicons: in the private
      // session, so they leave nothing in the persistent cache or cookies.
      session: this.session,
    };
    this._uiPrefs = uiPrefs;
    this.ui = new WebContentsView({ webPreferences: uiPrefs });
    this.ui.setBackgroundColor('#00000000');
    this.base.contentView.addChildView(this.ui);
    this._wireUiView(this.ui);
    this.ui.webContents.loadFile(ctx.uiFile, { query: { view: 'chrome', private: this.private ? '1' : '0' } });
    // The float view (prompts, find bar, download toasts) is a renderer of its
    // own, ~22 MiB, and idle nearly always: made when first needed and closed
    // FLOAT_IDLE_MS after it was last shown (see _ensureFloat).
    this.float = null;
    this._floatQueue = [];
    this._floatIdle = null;
    this._floatFocus = false;

    // Show as soon as the UI has painted once (a local file: a few ms), with
    // a fallback so a slow disk never leaves the window invisible.
    const show = () => { if (!this.base.isDestroyed() && !this.base.isVisible()) { this.base.show(); this.focusPage(); } };
    this.ui.webContents.once('did-finish-load', show);
    setTimeout(show, 600);

    this.base.on('resize', () => this.layout());
    this.base.on('enter-full-screen', () => this.layout());
    this.base.on('leave-full-screen', () => {
      if (this.htmlFullscreen && this.active && this.active.live) this.active.webContents.exitFullscreen?.();
      this.htmlFullscreen = false;
      this.immersive = false;
      this.layout();
      this.pushState();
    });
    this.base.on('focus', () => ctx.focused(this));
    this.base.on('close', () => { this._closing = true; this.emit('close', this); });
    this.base.on('closed', () => {
      for (const t of this.tabs) t.destroy();
      clearTimeout(this._floatIdle);
      for (const v of [this.ui, this.float]) try { if (v) v.webContents.close(); } catch {}
      this.emit('closed', this);
    });

    this._hooks = {
      wire: (tab, wc) => this._wireTab(tab, wc),
      policy: () => ctx.lifecyclePolicy(),
    };

    const restore = Array.isArray(opts.tabs) ? opts.tabs.filter((t) => t && t.url) : [];
    for (const t of restore) this.newTab({ ...t, background: true, lazy: true });
    const startIndex = Math.min(Math.max(0, opts.active | 0), this.tabs.length - 1);
    if (this.tabs.length) this.activate(this.tabs[startIndex]);
    if (opts.url) this.newTab({ url: opts.url });
    if (!this.tabs.length) this.openPalette({ newTab: true });
    this.layout();
  }

  // ----- tabs ----------------------------------------------------------------

  newTab({ url, title, favicon, pinned, background = false, lazy = false, adopt = null, opener = null } = {}) {
    const tab = new Tab({ session: this.session, url, title, favicon, pinned, adopt, hooks: this._hooks });
    tab.on('changed', () => { if (tab === this.active) this._updateTitle(); this.pushState(); });
    tab.on('closed-by-page', () => this.closeTab(tab, { byPage: true }));
    tab.on('discarding', (_t, view) => { try { this.base.contentView.removeChildView(view); } catch {} });
    tab.on('navigated', (_t, navUrl) => {
      this.ctx.onNavigated(this, tab, navUrl);
      this.emit('session-changed');
    });
    tab.on('title', (_t, t) => this.ctx.onTitle(this, tab, t));

    // New tabs from a page open next to it (and next to its other children).
    let index = this.tabs.length;
    if (opener) {
      index = this.tabs.indexOf(opener) + 1;
      while (index < this.tabs.length && this.tabs[index]._opener === opener) index++;
      tab._opener = opener;
    } else if (pinned) {
      index = this.tabs.filter((t) => t.pinned).length;
    }
    this.tabs.splice(index, 0, tab);

    if (!background) {
      this.activate(tab);
    } else if (!lazy && (url || adopt)) {
      // A background tab the user asked for loads now, hidden.
      if (!tab.live) tab.ensureView();
      tab.hidden();
    }
    this.pushState();
    this.emit('session-changed');
    return tab;
  }

  activate(tab) {
    if (!tab || this.base.isDestroyed()) return;
    const prev = this.active;
    this.active = tab;
    tab.ensureView();
    tab.view.setVisible(true);
    this.base.contentView.addChildView(tab.view);
    if (this.overlay) this.base.contentView.addChildView(this.ui);
    if (this.float && this.float.getVisible()) this.base.contentView.addChildView(this.float);
    this.layout();
    tab.shown();
    if (prev && prev !== tab) {
      if (prev.view) {
        prev.view.setVisible(false);
        try { this.base.contentView.removeChildView(prev.view); } catch {}
      }
      prev.hidden();
      if (this.findOpen) this.closeFind();
    }
    if (!this.overlay) this.focusPage();
    this._updateTitle();
    // Other tabs' prompts stay pending (a permission request waits for its
    // answer); the UI only ever shows the active tab's (_visiblePrompts).
    this.pushState();
    this.emit('session-changed');
  }

  closeTab(tab, { byPage = false } = {}) {
    const idx = this.tabs.indexOf(tab);
    if (idx < 0) return;
    if (!this.private && tab.url && !byPage) {
      this.closedTabs.push({ url: tab.url, title: tab.title, favicon: tab.favicon, index: idx });
      if (this.closedTabs.length > 25) this.closedTabs.shift();
    }
    this.tabs.splice(idx, 1);
    if (tab.view) try { this.base.contentView.removeChildView(tab.view); } catch {}
    this.prompts = this.prompts.filter((p) => p.tabId !== tab.id);
    for (const p of this.ctx.pendingPrompts(tab)) p.cancel();
    tab.destroy();
    if (this.active === tab) {
      this.active = null;
      // Back to the opener if this was its child, else the neighbour.
      const next = (tab._opener && this.tabs.includes(tab._opener)) ? tab._opener : (this.tabs[idx] || this.tabs[idx - 1]);
      if (next) this.activate(next);
    }
    if (!this.tabs.length) {
      this.base.close();
      return;
    }
    this.pushState();
    this.emit('session-changed');
  }

  reopenClosedTab() {
    const t = this.closedTabs.pop();
    if (!t) return;
    const tab = this.newTab({ url: t.url, title: t.title, favicon: t.favicon });
    this.moveTab(tab, Math.min(t.index, this.tabs.length - 1));
  }

  moveTab(tab, index) {
    const from = this.tabs.indexOf(tab);
    if (from < 0) return;
    this.tabs.splice(from, 1);
    const pinnedCount = this.tabs.filter((t) => t.pinned).length;
    let to = Math.max(0, Math.min(index, this.tabs.length));
    // Pinned tabs stay above the others.
    to = tab.pinned ? Math.min(to, pinnedCount) : Math.max(to, pinnedCount);
    this.tabs.splice(to, 0, tab);
    this.pushState();
    this.emit('session-changed');
  }

  setPinned(tab, pinned) {
    tab.pinned = pinned;
    this.moveTab(tab, pinned ? this.tabs.filter((t) => t.pinned && t !== tab).length : this.tabs.length);
    tab.reschedule();
  }

  cycle(step) {
    if (!this.tabs.length) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + step + this.tabs.length) % this.tabs.length]);
  }

  /** Navigate the active tab, or a new one. `input` is what the user typed. */
  go(input, { newTab = false, background = false } = {}) {
    const { url, upgraded } = fixupNav(input);
    if (!url) return;
    const fresh = newTab || !this.active;
    const tab = fresh ? this.newTab({ url, background }) : this.active;
    // https chosen by us for a bare address: one fall back to http if it fails.
    tab.httpFallback = upgraded ? url : null;
    if (!fresh) tab.navigate(url);
    this.closePalette();
  }

  // ----- layout ---------------------------------------------------------------

  layout() {
    if (this.base.isDestroyed()) return;
    const [w, h] = this.base.getContentSize();
    const settings = this.ctx.services.settings;
    const top = settings.get('tabs.position') === 'top';
    const sidebar = settings.get('sidebar.visible') !== false;
    const fs = this.htmlFullscreen || this.immersive;
    let chrome = { x: 0, y: 0, width: 0, height: 0 };
    let page = { x: 0, y: 0, width: w, height: h };
    if (!fs) {
      if (top) {
        chrome = { x: 0, y: 0, width: w, height: TOPBAR_H };
        page = { x: 0, y: TOPBAR_H, width: w, height: Math.max(0, h - TOPBAR_H) };
      } else if (sidebar) {
        chrome = { x: 0, y: 0, width: SIDEBAR_W, height: h };
        page = { x: SIDEBAR_W, y: 0, width: Math.max(0, w - SIDEBAR_W), height: h };
      }
    }
    this.pageBounds = page;
    const overlay = this.overlay || !this.tabs.length;
    this.ui.setBounds(overlay ? { x: 0, y: 0, width: w, height: h } : chrome);
    this.ui.setVisible(overlay || (chrome.width > 0 && chrome.height > 0));
    if (this.active && this.active.view) this.active.view.setBounds(page);
    this._layoutFloat();
  }

  _wireUiView(view) {
    const wc = view.webContents;
    wc.on('before-input-event', (e, input) => { if (this.ctx.shortcuts.handle(this, input, null)) e.preventDefault(); });
    wc.on('did-finish-load', () => this.pushState(true));
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
  }

  /** The float view, made on first use. */
  _ensureFloat() {
    clearTimeout(this._floatIdle);
    this._floatIdle = null;
    if (this.float) return this.float;
    const view = new WebContentsView({ webPreferences: this._uiPrefs });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    this._wireUiView(view);
    view._ready = false;
    view.webContents.once('did-finish-load', () => {
      view._ready = true;
      for (const [channel, args] of this._floatQueue.splice(0)) view.webContents.send(channel, ...args);
      this._focusFloatIfShown();
    });
    view.webContents.loadFile(this.ctx.uiFile, { query: { view: 'float', private: this.private ? '1' : '0' } });
    this.float = view;
    return view;
  }

  /** Send to the float view, once it has loaded. */
  floatSend(channel, ...args) {
    this._floatPost(channel, args, false);
  }

  // A focus asked for while the float is hidden (it shows only once its
  // content has reported a size) is kept and given when it shows: Chromium
  // drops focus() on a hidden view, and typing would go to the page.
  _floatPost(channel, args, focus) {
    const v = this._ensureFloat();
    if (focus) this._floatFocus = true;
    if (v._ready) {
      v.webContents.send(channel, ...args);
      this._focusFloatIfShown();
    } else {
      this._floatQueue.push([channel, args]);
    }
  }

  _focusFloatIfShown() {
    if (this._floatFocus && this.float && this.float.getVisible()) {
      this._floatFocus = false;
      this.float.webContents.focus();
    }
  }

  _floatWanted() {
    return !!(this._visiblePrompts().length || this.findOpen || this.ctx.downloads.toasts(this).length);
  }

  /** Window-wide prompts and the active tab's. */
  _visiblePrompts() {
    const id = this.active && this.active.id;
    return this.prompts.filter((p) => !p.tabId || p.tabId === id);
  }

  _layoutFloat() {
    const needed = this._floatWanted();
    if (needed && !this.float) this._ensureFloat();
    const want = needed && this.floatSize.height > 0;
    if (!want || this.htmlFullscreen) {
      if (this.float && this.float.getVisible()) {
        this.float.setVisible(false);
        try { this.base.contentView.removeChildView(this.float); } catch {}
      }
      if (this.float && !needed && !this._floatIdle) {
        this._floatIdle = setTimeout(() => this._closeFloat(), FLOAT_IDLE_MS);
      }
      return;
    }
    clearTimeout(this._floatIdle);
    this._floatIdle = null;
    const p = this.pageBounds;
    const width = Math.min(this.floatSize.width || 380, p.width - 16);
    const height = Math.min(this.floatSize.height, p.height - 16);
    this.float.setBounds({ x: p.x + p.width - width - 12, y: p.y + 12, width, height });
    if (!this.float.getVisible()) {
      this.float.setVisible(true);
      this.base.contentView.addChildView(this.float);
      if (this.overlay) this.base.contentView.addChildView(this.ui);
    }
    this._focusFloatIfShown();
  }

  _closeFloat() {
    this._floatIdle = null;
    const v = this.float;
    if (!v || this._floatWanted()) return;
    this.float = null;
    this._floatQueue = [];
    this.floatSize = { width: 0, height: 0 };
    try { this.base.contentView.removeChildView(v); } catch {}
    try { v.webContents.close(); } catch {}
  }

  setFloatSize(width, height) {
    this.floatSize = { width: Math.ceil(width), height: Math.ceil(height) };
    this._layoutFloat();
  }

  // ----- overlay: the command bar ---------------------------------------------

  openPalette({ newTab = false, text = null } = {}) {
    this.overlay = true;
    this.base.contentView.addChildView(this.ui);
    this.layout();
    const current = this.active && !newTab ? this.active.url : '';
    this.ui.webContents.send('sn:palette', { newTab, text: text ?? (current.startsWith('supernova:') ? '' : current) });
    this.ui.webContents.focus();
    this.pushState();
  }

  closePalette() {
    if (!this.overlay) return;
    this.overlay = false;
    if (!this.tabs.length) return;
    if (this.active && this.active.view) this.base.contentView.addChildView(this.active.view);
    if (this.float && this.float.getVisible()) this.base.contentView.addChildView(this.float);
    this.layout();
    this.focusPage();
    this.pushState();
  }

  // ----- find in page ---------------------------------------------------------

  openFind() {
    if (!this.active || !this.active.live) return;
    this.findOpen = true;
    this.pushState();
    this._layoutFloat();
    this._floatPost('sn:find-open', [], true);
  }

  find(text, { forward = true, findNext = false } = {}) {
    const wc = this.active && this.active.webContents;
    if (!wc) return;
    if (!text) { wc.stopFindInPage('clearSelection'); this.active.find = null; this.pushState(); return; }
    this.active.find = { text, active: 0, matches: 0 };
    wc.findInPage(text, { forward, findNext, matchCase: false });
  }

  closeFind() {
    this.findOpen = false;
    this._floatFocus = false;
    const wc = this.active && this.active.webContents;
    if (wc) wc.stopFindInPage('keepSelection');
    if (this.active) this.active.find = null;
    this._layoutFloat();
    this.pushState();
    this.focusPage();
  }

  // ----- prompts (permissions, save password) ----------------------------------

  addPrompt(prompt) {
    this.prompts.push(prompt);
    this.pushState();
    this._layoutFloat();
  }

  removePrompt(id) {
    this.prompts = this.prompts.filter((p) => p.id !== id);
    this.pushState();
    this._layoutFloat();
  }

  // ----- fullscreen -----------------------------------------------------------

  setHtmlFullscreen(on) {
    this.htmlFullscreen = on;
    if (on !== this.base.isFullScreen() && !this.immersive) this.base.setFullScreen(on);
    this.layout();
    this.pushState();
  }

  toggleImmersive() {
    this.immersive = !this.immersive;
    this.base.setFullScreen(this.immersive);
    this.layout();
    this.pushState();
  }

  // ----- misc -----------------------------------------------------------------

  focusPage() {
    if (this.overlay) return;
    const wc = this.active && this.active.webContents;
    if (wc) wc.focus();
  }

  zoom(step) {
    const tab = this.active;
    const wc = tab && tab.webContents;
    if (!wc) return;
    const levels = [0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
    let z = wc.getZoomFactor();
    if (step === 0) z = 1;
    else {
      const i = levels.findIndex((l) => l >= z - 0.001);
      z = levels[Math.max(0, Math.min(levels.length - 1, (i < 0 ? levels.length - 1 : i) + step))];
    }
    wc.setZoomFactor(z);
    tab.zoom = z;
    const host = displayHost(tab.url);
    if (host && !this.private) {
      const map = { ...this.ctx.services.settings.get('zoom.perHost') };
      if (z === 1) delete map[host]; else map[host] = z;
      this.ctx.services.settings.set('zoom.perHost', map);
    }
    this.pushState();
  }

  _updateTitle() {
    if (this.base.isDestroyed()) return;
    const t = this.active ? (this.active.title || displayHost(this.active.url) || 'New tab') : 'Supernova';
    this.base.setTitle(this.private ? `${t} (private)` : t);
  }

  _wireTab(tab, wc) {
    const ctx = this.ctx;
    wc.on('before-input-event', (e, input) => { if (ctx.shortcuts.handle(this, input, tab)) e.preventDefault(); });
    wc.on('context-menu', (_e, params) => this._contextMenu(tab, params));
    wc.setWindowOpenHandler((details) => this._windowOpen(tab, details));
    // What a page starts itself, in any frame: never supernova:// or file://
    // from the web (url.js mayOpen). A redirect there is never legitimate.
    wc.on('will-frame-navigate', (e) => { if (!mayOpen(wc.getURL(), e.url)) e.preventDefault(); });
    wc.on('will-redirect', (e) => { if (!mayOpen('', e.url)) e.preventDefault(); });
    wc.on('enter-html-full-screen', () => this.setHtmlFullscreen(true));
    wc.on('leave-html-full-screen', () => this.setHtmlFullscreen(false));
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 is "aborted" (the user stopped it, or a download took over).
      if (!isMainFrame || code === -3 || !url || url.startsWith('supernova:')) return;
      // An address typed without a scheme that we tried as https: try http,
      // once (not for a name that does not resolve, or when offline).
      const fb = tab.httpFallback;
      tab.httpFallback = null;
      if (fb && url.startsWith('https:') && ![-105, -106, -137, -21].includes(code)) {
        try {
          if (new URL(fb).host === new URL(url).host) {
            wc.loadURL('http:' + url.slice('https:'.length)).catch(() => {});
            return;
          }
        } catch {}
      }
      const q = new URLSearchParams({ url, code: String(code), desc: desc || '' });
      wc.loadURL(`supernova://error/?${q}`).catch(() => {});
    });
    wc.on('did-navigate', (_e, url) => {
      tab.httpFallback = null;
      const host = displayHost(url);
      const z = host && ctx.services.settings.get('zoom.perHost')[host];
      wc.setZoomFactor(z || 1);
      tab.zoom = z || 1;
    });
    wc.setAudioMuted(tab.muted);
    ctx.wireTab(this, tab, wc);
  }

  _windowOpen(opener, details) {
    const { url, disposition } = details;
    // Links to other apps (mailto:, zoommtg:, spotify:) go through the
    // openExternal permission instead.
    if (!/^(https?|about|blob|data|file):/i.test(url) && url !== '') return { action: 'deny' };
    if (!mayOpen(opener.webContents ? opener.webContents.getURL() : opener.url, url)) return { action: 'deny' };
    const background = disposition === 'background-tab';
    return {
      action: 'allow',
      createWindow: (options) => {
        const tab = this.newTab({ adopt: options, background, opener, url });
        if (background) tab.hidden();
        return tab.view.webContents;
      },
    };
  }

  _contextMenu(tab, p) {
    const wc = tab.webContents;
    if (!wc) return;
    const items = [];
    const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
    if (p.misspelledWord) {
      for (const s of (p.dictionarySuggestions || []).slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      sep();
    }
    // A page's links open only where the page itself could go (url.js mayOpen).
    const from = wc.getURL();
    if (p.linkURL && mayOpen(from, p.linkURL)) {
      items.push({ label: 'Open link in new tab', click: () => this.newTab({ url: p.linkURL, background: true, opener: tab }) });
      if (!this.private) items.push({ label: 'Open link in private window', click: () => this.ctx.newWindow({ private: true, url: p.linkURL }) });
      items.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) });
      items.push({ label: 'Save link as…', click: () => wc.downloadURL(p.linkURL) });
      sep();
    }
    if (p.mediaType === 'image' && p.srcURL && mayOpen(from, p.srcURL)) {
      items.push({ label: 'Open image in new tab', click: () => this.newTab({ url: p.srcURL, background: true, opener: tab }) });
      items.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) });
      items.push({ label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) });
      items.push({ label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) });
      sep();
    }
    if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL && !p.srcURL.startsWith('blob:') && mayOpen(from, p.srcURL)) {
      items.push({ label: `Save ${p.mediaType} as…`, click: () => wc.downloadURL(p.srcURL) });
      sep();
    }
    if (p.isEditable) {
      items.push({ role: 'undo', enabled: p.editFlags.canUndo }, { role: 'redo', enabled: p.editFlags.canRedo });
      sep();
      items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy },
        { role: 'paste', enabled: p.editFlags.canPaste }, { role: 'pasteAndMatchStyle', label: 'Paste as plain text', enabled: p.editFlags.canPaste },
        { role: 'selectAll' });
      sep();
    } else if (p.selectionText && p.selectionText.trim()) {
      const text = p.selectionText.trim();
      items.push({ role: 'copy' });
      items.push({
        label: `Search Google for “${text.length > 32 ? text.slice(0, 31) + '…' : text}”`,
        click: () => this.newTab({ url: searchUrl(text), opener: tab }),
      });
      sep();
    }
    if (!p.linkURL && !p.isEditable && !p.selectionText && p.mediaType === 'none') {
      items.push({ label: 'Back', enabled: tab.canGoBack, click: () => tab.back() });
      items.push({ label: 'Forward', enabled: tab.canGoForward, click: () => tab.forward() });
      items.push({ label: 'Reload', click: () => tab.reload() });
      sep();
      items.push({ label: 'Print…', click: () => wc.print({}, () => {}) });
      items.push({ label: 'View page source', click: () => this.newTab({ url: 'view-source:' + tab.url, opener: tab }) });
      sep();
    }
    items.push({ label: 'Inspect', click: () => { wc.inspectElement(p.x, p.y); } });
    if (items[items.length - 1] && items[items.length - 1].type === 'separator') items.pop();
    Menu.buildFromTemplate(items).popup({ window: this.base });
  }

  // ----- state for the UI -------------------------------------------------------

  state() {
    const tab = this.active;
    const services = this.ctx.services;
    const url = tab ? tab.url : '';
    const wcId = tab && tab.live ? tab.webContents.id : -1;
    return {
      private: this.private,
      tabs: this.tabs.map((t) => t.snapshot(t === tab)),
      activeId: tab ? tab.id : null,
      url,
      host: displayHost(url),
      secure: /^https:|^supernova:|^file:/.test(url),
      title: tab ? tab.title : '',
      loading: !!(tab && tab.loading),
      canGoBack: !!(tab && tab.canGoBack),
      canGoForward: !!(tab && tab.canGoForward),
      hoverUrl: tab ? tab.hoverUrl : '',
      zoom: tab ? tab.zoom : 1,
      bookmarked: !!(url && services.bookmarks && services.bookmarks.has(url)),
      adblock: {
        enabled: !!(url && services.adblock && services.adblock.isActiveFor(url)),
        blocked: services.adblock && wcId >= 0 ? services.adblock.blockedCount(wcId) : 0,
      },
      overlay: this.overlay,
      find: this.findOpen ? (tab && tab.find) || { text: '', active: 0, matches: 0 } : null,
      prompts: this._visiblePrompts().map((p) => p.public),
      downloads: this.ctx.downloads.list(),
      toasts: this.ctx.downloads.toasts(this),
      fullscreen: this.htmlFullscreen || this.immersive,
      tabsPosition: services.settings.get('tabs.position'),
      sidebarVisible: services.settings.get('sidebar.visible') !== false,
      onBattery: this.ctx.power.onBattery(),
      theme: this.ctx.theme(),
    };
  }

  /** Push state to the UI, at most once a frame. */
  pushState(now = false) {
    if (this._statePending && !now) return;
    const send = () => {
      this._statePending = null;
      if (this.base.isDestroyed() || this._closing) return;
      const s = this.state();
      for (const v of [this.ui, this.float]) {
        if (v && !v.webContents.isDestroyed()) v.webContents.send('sn:state', s);
      }
      this._layoutFloat();
    };
    if (now) { clearTimeout(this._statePending); send(); return; }
    this._statePending = setTimeout(send, 16);
  }

  sessionData() {
    return {
      bounds: this.base.isDestroyed() ? undefined : this.base.getNormalBounds(),
      active: Math.max(0, this.tabs.indexOf(this.active)),
      tabs: this.tabs.filter((t) => t.url && !t.url.startsWith('supernova://error')).map((t) => ({
        url: t.url, title: t.title, favicon: t.favicon, pinned: t.pinned,
      })),
    };
  }
}

module.exports = { SnWindow, SIDEBAR_W, TOPBAR_H, FLOAT_IDLE_MS };
