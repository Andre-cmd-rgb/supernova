'use strict';
// Preload for every frame of every web page (bundled into dist/preload by
// tools/build.mjs; sandboxed, so only 'electron' can be required at run time).

const { contextBridge, ipcRenderer } = require('electron');
const { applyMediaShim } = require('./media-shim');
const { installAutofill } = require('./autofill');

const proto = location.protocol;
const web = proto === 'http:' || proto === 'https:';

// Video quality caps and the animation frame rate, in the page's own world,
// before any of its scripts run.
if (web) {
  try {
    const cfg = ipcRenderer.sendSync('sn:media:config');
    if (cfg) contextBridge.executeInMainWorld({ func: applyMediaShim, args: [cfg] });
  } catch {}
  ipcRenderer.on('sn:media:config', (_e, cfg) => {
    try { contextBridge.executeInMainWorld({ func: applyMediaShim, args: [cfg] }); } catch {}
  });
}

// Mouse back/forward buttons.
if (window === window.top) {
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      ipcRenderer.send('sn:nav', e.button === 3 ? 'back' : 'forward');
    }
  }, true);
}

if (web) {
  try { installAutofill({ ipcRenderer }); } catch {}
  // The user typed text into this page (any frame): the tab is then not
  // discarded until it navigates, which would lose the text (Chrome keeps
  // tabs with form input the same way). Checkboxes, selects and search
  // boxes do not count. Told once per document.
  const TEXT = /^(text|email|password|tel|url|number|)$/;
  const typed = (e) => {
    const t = e.target;
    if (!e.isTrusted || !t) return;
    const text = t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && TEXT.test(t.type || ''));
    if (!text) return;
    window.removeEventListener('input', typed, true);
    ipcRenderer.send('sn:edited');
  };
  window.addEventListener('input', typed, true);
}

// Internal pages (supernova://settings) get a small API; the main process
// checks the sender's URL again on every call.
if (proto === 'supernova:' && window === window.top) {
  const listeners = new Set();
  ipcRenderer.on('sn:internal-event', (_e, name, data) => { for (const fn of listeners) fn(name, data); });
  contextBridge.exposeInMainWorld('supernova', {
    invoke: (name, ...args) => ipcRenderer.invoke('sn:internal', name, ...args),
    on: (fn) => { listeners.add(fn); },
  });
}
