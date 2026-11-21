'use strict';
// Keyboard shortcuts, checked before the page sees the key (before-input-event
// on every page and on the UI). Returns true when a shortcut took the key.

function keyOf(input) {
  const parts = [];
  if (input.control || input.meta) parts.push('ctrl');
  if (input.alt) parts.push('alt');
  if (input.shift) parts.push('shift');
  let key = (input.key || '').toLowerCase();
  // Digits and +/- by physical key, so layouts (es, it) behave the same.
  if (/^Digit\d$/.test(input.code || '')) key = input.code.slice(5);
  if (input.code === 'Equal' || input.code === 'NumpadAdd') key = key === '+' || input.code === 'NumpadAdd' ? '+' : '=';
  if (input.code === 'Minus' || input.code === 'NumpadSubtract') key = '-';
  if (input.code === 'Numpad0' && (input.control || input.meta)) key = '0';
  if (key === ' ') key = 'space';
  parts.push(key);
  return parts.join('+');
}

function createShortcuts(app) {
  const map = {
    'ctrl+t': (w) => w.openPalette({ newTab: true }),
    'ctrl+l': (w) => w.openPalette(),
    'ctrl+k': (w) => w.openPalette(),
    'alt+d': (w) => w.openPalette(),
    'f6': (w) => w.openPalette(),
    'ctrl+w': (w) => w.active && w.closeTab(w.active),
    'ctrl+f4': (w) => w.active && w.closeTab(w.active),
    'ctrl+shift+t': (w) => w.reopenClosedTab(),
    'ctrl+tab': (w) => w.cycle(1),
    'ctrl+pagedown': (w) => w.cycle(1),
    'ctrl+shift+tab': (w) => w.cycle(-1),
    'ctrl+pageup': (w) => w.cycle(-1),
    'ctrl+r': (w) => w.active && w.active.reload(),
    'f5': (w) => w.active && w.active.reload(),
    'ctrl+shift+r': (w) => w.active && w.active.reload(true),
    'shift+f5': (w) => w.active && w.active.reload(true),
    'ctrl+f5': (w) => w.active && w.active.reload(true),
    'alt+arrowleft': (w) => w.active && w.active.back(),
    'alt+arrowright': (w) => w.active && w.active.forward(),
    'browserback': (w) => w.active && w.active.back(),
    'browserforward': (w) => w.active && w.active.forward(),
    'ctrl+f': (w) => w.openFind(),
    'f3': (w) => (w.findOpen ? w.floatSend('sn:find-next', 1) : w.openFind()),
    'shift+f3': (w) => w.findOpen && w.floatSend('sn:find-next', -1),
    'ctrl+d': (w) => app.toggleBookmark(w),
    'ctrl+s': (w) => app.toggleSidebar(),
    'ctrl+=': (w) => w.zoom(1),
    'ctrl++': (w) => w.zoom(1),
    'ctrl+shift++': (w) => w.zoom(1),
    'ctrl+shift+=': (w) => w.zoom(1),
    'ctrl+-': (w) => w.zoom(-1),
    'ctrl+0': (w) => w.zoom(0),
    'f11': (w) => w.toggleImmersive(),
    'f12': (w) => app.toggleDevTools(w),
    'ctrl+shift+i': (w) => app.toggleDevTools(w),
    'ctrl+shift+j': (w) => app.toggleDevTools(w),
    'ctrl+u': (w) => w.active && w.newTab({ url: 'view-source:' + w.active.url, opener: w.active }),
    'ctrl+n': () => app.newWindow({}),
    'ctrl+shift+n': () => app.newWindow({ private: true }),
    'ctrl+shift+p': () => app.newWindow({ private: true }),
    'ctrl+p': (w) => w.active && w.active.webContents && w.active.webContents.print({}, () => {}),
    'ctrl+h': (w) => w.openPalette({ newTab: true, text: '' }),
    'ctrl+j': () => app.openDownloadsFolder(),
    'ctrl+,': (w) => app.openSettings(w),
    'ctrl+m': (w) => w.active && w.active.setMuted(!w.active.muted),
    'ctrl+shift+w': (w) => w.base.close(),
    'ctrl+shift+q': () => app.quit(),
  };
  for (let i = 1; i <= 8; i++) map[`ctrl+${i}`] = (w) => w.tabs[i - 1] && w.activate(w.tabs[i - 1]);
  map['ctrl+9'] = (w) => w.tabs.length && w.activate(w.tabs[w.tabs.length - 1]);
  for (let i = 1; i <= 9; i++) map[`alt+${i}`] = map[`ctrl+${i}`];

  return {
    keyOf,
    handle(win, input, tab) {
      if (input.type !== 'keyDown') return false;
      const key = keyOf(input);
      // Escape belongs to the page (dialogs, fullscreen) unless our UI is open.
      if (key === 'escape') {
        if (win.overlay && win.tabs.length) { win.closePalette(); return true; }
        if (win.findOpen) { win.closeFind(); return true; }
        if (!tab && win.prompts.length) return false;
        if (tab && tab.loading && !win.htmlFullscreen) { tab.stop(); return false; }
        return false;
      }
      const fn = map[key];
      if (!fn) return false;
      // Keys typed into the UI's own inputs keep editing shortcuts.
      if (!tab && ['ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+z'].includes(key)) return false;
      if (input.isAutoRepeat && !/tab|page|arrow|[=+-]$/.test(key)) return true;
      fn(win, tab);
      return true;
    },
  };
}

module.exports = { createShortcuts, keyOf };
