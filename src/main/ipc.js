'use strict';
// IPC: commands from the browser UI, sync config for page preloads, and the
// small API of supernova:// pages (checked by sender URL on every call).

function registerIpc(ctx) {
  const { ipcMain } = ctx.electron;
  const { services } = ctx;

  const winOf = (sender) => ctx.windowForWebContents(sender);

  const commands = {
    activate: (w, id) => { const t = w.tabs.find((x) => x.id === id); if (t) w.activate(t); },
    close: (w, id) => { const t = w.tabs.find((x) => x.id === id); if (t) w.closeTab(t); },
    move: (w, id, index) => { const t = w.tabs.find((x) => x.id === id); if (t) w.moveTab(t, index); },
    pin: (w, id, pinned) => { const t = w.tabs.find((x) => x.id === id); if (t) w.setPinned(t, !!pinned); },
    mute: (w, id) => { const t = w.tabs.find((x) => x.id === id); if (t) t.setMuted(!t.muted); },
    duplicate: (w, id) => { const t = w.tabs.find((x) => x.id === id); if (t && t.url) w.newTab({ url: t.url, opener: t }); },
    reloadTab: (w, id) => { const t = w.tabs.find((x) => x.id === id); if (t) t.reload(); },
    closeOthers: (w, id) => { for (const t of w.tabs.filter((x) => x.id !== id && !x.pinned)) w.closeTab(t); },
    go: (w, input, opts) => w.go(String(input || ''), opts || {}),
    activateOrGo: (w, id) => commands.activate(w, id),
    newTab: (w) => w.openPalette({ newTab: true }),
    palette: (w, open, opts) => (open ? w.openPalette(opts || {}) : w.closePalette()),
    back: (w) => w.active && w.active.back(),
    forward: (w) => w.active && w.active.forward(),
    reload: (w) => w.active && w.active.reload(),
    stop: (w) => w.active && w.active.stop(),
    find: (w, text, opts) => w.find(String(text || ''), opts || {}),
    findClose: (w) => w.closeFind(),
    floatSize: (w, width, height) => w.setFloatSize(Number(width) || 0, Number(height) || 0),
    prompt: (w, id, action, data) => ctx.respondPrompt(w, id, action, data),
    download: (w, id, action) => services.downloads.act(id, action),
    bookmark: (w) => ctx.toggleBookmark(w),
    sidebar: () => ctx.toggleSidebar(),
    tabsPosition: (w, pos) => ctx.setSetting('tabs.position', pos === 'top' ? 'top' : 'left'),
    settings: (w) => ctx.openSettings(w),
    adblockSite: (w, enabled) => {
      const t = w.active;
      if (!t || !services.adblock) return;
      try { services.adblock.setSiteEnabled(new URL(t.url).hostname, !!enabled); } catch { return; }
      t.reload();
      w.pushState();
    },
    zoom: (w, step) => w.zoom(Number(step) || 0),
    newWindow: (w, isPrivate) => ctx.newWindow({ private: !!isPrivate }),
    focusPage: (w) => w.focusPage(),
    downloadsFolder: () => ctx.openDownloadsFolder(),
    tabMenu: (w, id) => { const t = w.tabs.find((x) => x.id === id); if (t) ctx.tabMenu(w, t); },
  };

  ipcMain.on('sn:cmd', (e, name, ...args) => {
    const w = winOf(e.sender);
    const fn = commands[name];
    if (!w || !fn) return;
    try { fn(w, ...args); } catch (err) { console.error(`sn:cmd ${name}:`, err); }
  });

  ipcMain.handle('sn:invoke', async (e, name, ...args) => {
    const w = winOf(e.sender);
    if (!w) return null;
    if (name === 'suggest') return ctx.suggest(w, String(args[0] || ''));
    if (name === 'suggestRemote') return ctx.suggestRemote(w, String(args[0] || ''));
    return null;
  });

  // Page preloads read the media policy synchronously at document start.
  ipcMain.on('sn:media:config', (e) => {
    e.returnValue = services.media ? services.media.current() : { maxHeight: 0, maxFps: 0, rafFps: 0 };
  });

  ipcMain.on('sn:nav', (e, dir) => {
    const found = ctx.findTab(e.sender);
    if (!found || !found.tab) return;
    if (dir === 'back') found.tab.back(); else if (dir === 'forward') found.tab.forward();
  });

  ipcMain.handle('sn:internal', async (e, name, ...args) => {
    const url = (e.senderFrame && e.senderFrame.url) || '';
    if (!url.startsWith('supernova://settings') && !url.startsWith('supernova://error')) throw new Error('not allowed');
    if (url.startsWith('supernova://error') && name !== 'theme') throw new Error('not allowed');
    const api = ctx.internalApi;
    if (!Object.prototype.hasOwnProperty.call(api, name)) throw new Error(`unknown: ${name}`);
    return api[name](e, ...args);
  });
}

module.exports = { registerIpc };
