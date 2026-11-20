'use strict';
// Preload for the browser's own UI (sidebar, command bar, prompts).

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set(['sn:state', 'sn:palette', 'sn:find-open', 'sn:find-next']);

contextBridge.exposeInMainWorld('sn', {
  on(channel, fn) {
    if (!CHANNELS.has(channel)) throw new Error(`unknown channel ${channel}`);
    ipcRenderer.on(channel, (_e, ...args) => fn(...args));
  },
  cmd(name, ...args) { ipcRenderer.send('sn:cmd', name, ...args); },
  invoke(name, ...args) { return ipcRenderer.invoke('sn:invoke', name, ...args); },
});
