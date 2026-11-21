'use strict';
// A tab. Its page (a WebContentsView) exists only while it is needed:
// restored tabs have none until shown, and a hidden tab goes through
// "frozen" (no JavaScript, no timers, no wakeups) to "discarded" (renderer
// closed, only the URL and title kept). Pinned tabs are never put to sleep.

const { EventEmitter } = require('events');
const { WebContentsView } = require('electron');

let nextId = 1;

/**
 * The web preferences of every page. test/autofill.test.js starts its page
 * with these too, so it tests what ships.
 */
function pagePreferences(session) {
  return {
    session,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    // The page preload (autofill, video caps, the animation limit) runs in
    // every frame, embedded players and sign-in iframes included. Frames
    // stay sandboxed: this adds the preload, not Node.
    nodeIntegrationInSubFrames: true,
    spellcheck: true,
    backgroundThrottling: true,
    safeDialogs: true,
    navigateOnDragDrop: true,
  };
}

class Tab extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('electron').Session} opts.session
   * @param {string} [opts.url]
   * @param {object} [opts.adopt] Electron's createWindow options (window.open)
   */
  constructor(opts) {
    super();
    this.id = nextId++;
    this.session = opts.session;
    this.url = opts.url || '';
    this.title = opts.title || '';
    this.favicon = opts.favicon || '';
    this.pinned = !!opts.pinned;
    this.loading = false;
    this.audible = false;
    this.muted = false;
    this.playing = false;
    this.capturing = false;
    this.crashed = false;
    this.frozen = false;
    this.view = null;
    this.hoverUrl = '';
    this.zoom = 1;
    this.lastShown = Date.now();
    this.canGoBack = false;
    this.canGoForward = false;
    this.find = null;
    this._timers = [];
    this._hooks = opts.hooks; // { wire(tab, webContents), policy() }
    if (opts.adopt) this._createView(opts.adopt);
  }

  get live() { return !!this.view && !this.view.webContents.isDestroyed(); }
  get webContents() { return this.live ? this.view.webContents : null; }
  get discarded() { return !this.view; }

  /** Create the page if it does not exist (lazy restore / after a discard). */
  ensureView() {
    if (this.live) return this.view;
    this._createView(null);
    if (this.url) this.view.webContents.loadURL(this.url).catch(() => {});
    return this.view;
  }

  _createView(adopt) {
    const webPreferences = pagePreferences(this.session);
    this.view = adopt ? new WebContentsView({ ...adopt, webPreferences: { ...(adopt.webPreferences || {}), ...webPreferences } })
      : new WebContentsView({ webPreferences });
    this.view.setBackgroundColor('#ffffff');
    this.frozen = false;
    this.crashed = false;
    this._wire(this.view.webContents);
  }

  _wire(wc) {
    const changed = () => this.emit('changed', this);
    const nav = () => {
      this.url = wc.getURL() || this.url;
      this.canGoBack = wc.navigationHistory.canGoBack();
      this.canGoForward = wc.navigationHistory.canGoForward();
      changed();
    };
    wc.on('did-start-loading', () => { this.loading = true; changed(); });
    wc.on('did-stop-loading', () => { this.loading = false; nav(); });
    wc.on('did-navigate', (_e, url) => {
      this.url = url;
      this.hoverUrl = '';
      this.capturing = false;
      this.edited = false;
      nav();
      this.emit('navigated', this, url);
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) { this.url = url; nav(); this.emit('navigated', this, url, true); } });
    wc.on('page-title-updated', (_e, title) => { this.title = title; changed(); this.emit('title', this, title); });
    wc.on('page-favicon-updated', (_e, favicons) => {
      this.favicon = (favicons && favicons.find((f) => /^https?:|^data:image\//.test(f))) || '';
      changed();
    });
    wc.on('update-target-url', (_e, url) => { this.hoverUrl = url; changed(); });
    wc.on('audio-state-changed', (e) => { this.audible = !!e.audible; changed(); this.reschedule(); });
    wc.on('media-started-playing', () => { this.playing = true; this.reschedule(); });
    wc.on('media-paused', () => { this.playing = false; this.reschedule(); });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      this.crashed = true;
      this.loading = false;
      changed();
    });
    wc.on('zoom-changed', () => {});
    wc.on('found-in-page', (_e, result) => {
      this.find = { ...(this.find || {}), active: result.activeMatchOrdinal, matches: result.matches };
      changed();
    });
    wc.on('destroyed', () => {
      // Closed by the page itself (window.close() on a popup) or discarded.
      if (this._discarding) return;
      this.emit('closed-by-page', this);
    });
    if (this._hooks && this._hooks.wire) this._hooks.wire(this, wc);
  }

  navigate(url) {
    this.url = url;
    this.ensureView();
    this.view.webContents.loadURL(url).catch(() => {});
  }

  reload(hard = false) {
    if (!this.live) return this.ensureView();
    if (this.crashed) { this.crashed = false; return this.view.webContents.loadURL(this.url).catch(() => {}); }
    hard ? this.view.webContents.reloadIgnoringCache() : this.view.webContents.reload();
  }

  stop() { if (this.live) this.view.webContents.stop(); }
  back() { if (this.live && this.view.webContents.navigationHistory.canGoBack()) this.view.webContents.navigationHistory.goBack(); }
  forward() { if (this.live && this.view.webContents.navigationHistory.canGoForward()) this.view.webContents.navigationHistory.goForward(); }

  setMuted(muted) {
    this.muted = muted;
    if (this.live) this.view.webContents.setAudioMuted(muted);
    this.emit('changed', this);
  }

  // ----- lifecycle -----------------------------------------------------------

  /** Called when the tab becomes the visible one. */
  async shown() {
    this._visible = true;
    this.lastShown = Date.now();
    this._clearTimers();
    if (this.frozen) await this._setLifecycle('active');
  }

  /** Called when the tab is hidden: schedule freeze, then discard. */
  hidden() {
    this._visible = false;
    this.lastShown = Date.now();
    this.reschedule();
  }

  /** Re-plan sleep timers (after hide, power change, audio change). */
  reschedule() {
    this._clearTimers();
    if (this._visible || this.pinned || !this.live) return;
    const p = this._hooks && this._hooks.policy ? this._hooks.policy() : { freezeMs: 600000, discardMs: 7200000 };
    const elapsed = Date.now() - this.lastShown;
    if (!this.frozen && p.freezeMs > 0) {
      this._timers.push(setTimeout(() => this.freeze(), Math.max(0, p.freezeMs - elapsed)));
    }
    if (p.discardMs > 0) {
      this._timers.push(setTimeout(() => this.discard(), Math.max(0, p.discardMs - elapsed)));
    }
  }

  _clearTimers() {
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
  }

  // Busy tabs are neither frozen nor discarded.
  _busy() {
    return this.audible || this.playing || this.capturing || this.loading || this.pinned ||
      (this.live && this.view.webContents.isCurrentlyAudible());
  }

  async freeze() {
    if (!this.live || this.frozen || this._visible || this._busy()) return;
    if (await this._setLifecycle('frozen')) {
      this.frozen = true;
      this.emit('changed', this);
    }
  }

  async _setLifecycle(state) {
    const wc = this.webContents;
    if (!wc) return false;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Page.setWebLifecycleState', { state });
      if (state === 'active') {
        this.frozen = false;
        try { wc.debugger.detach(); } catch {}
      }
      return true;
    } catch {
      // DevTools may hold the page, or it navigated: not worth more.
      if (state === 'active') this.frozen = false;
      return false;
    }
  }

  // Not a tab the user typed text into (`edited`, from the page preload,
  // cleared when it navigates): it may be frozen, but a discard loses the text.
  discard() {
    if (!this.live || this._visible || this._busy() || this.edited) return;
    this._clearTimers();
    const view = this.view;
    this._discarding = true;
    this.emit('discarding', this, view);
    this.view = null;
    this.frozen = false;
    try { view.webContents.close({ waitForBeforeUnload: false }); } catch {}
    this._discarding = false;
    this.emit('changed', this);
  }

  destroy() {
    this._clearTimers();
    if (!this.view) return;
    const view = this.view;
    this._discarding = true;
    this.view = null;
    try { if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false }); } catch {}
  }

  snapshot(active) {
    return {
      id: this.id,
      url: this.url,
      title: this.title,
      favicon: this.favicon,
      pinned: this.pinned,
      loading: this.loading,
      audible: this.audible,
      muted: this.muted,
      crashed: this.crashed,
      sleeping: this.discarded || this.frozen,
      active: !!active,
    };
  }
}

module.exports = { Tab, pagePreferences };
