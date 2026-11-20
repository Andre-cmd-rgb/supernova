'use strict';
// Downloads go straight to the downloads folder (no dialog), with a short
// toast when they finish. Progress is pushed to the UI a few times a second
// at most.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

function uniquePath(dir, name) {
  const safe = (name || 'download').replace(/[/\0]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'download';
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let candidate = path.join(dir, safe);
  for (let i = 1; fs.existsSync(candidate) || fs.existsSync(candidate + '.part'); i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

function createDownloads({ settings, app, shell }) {
  const em = new EventEmitter();
  const items = new Map();
  let nextId = 1;
  let throttle = null;
  const changed = (urgent) => {
    if (urgent) { clearTimeout(throttle); throttle = null; em.emit('change'); return; }
    if (throttle) return;
    throttle = setTimeout(() => { throttle = null; em.emit('change'); }, 250);
  };

  function dir() {
    const d = settings.get('downloads.dir');
    return d && fs.existsSync(d) ? d : app.getPath('downloads');
  }

  function attach(session, windowOf) {
    session.on('will-download', (_e, item, wc) => {
      const id = nextId++;
      const target = uniquePath(dir(), item.getFilename());
      item.setSavePath(target);
      const win = windowOf(wc);
      const d = {
        id, item, path: target, filename: path.basename(target), url: item.getURL(),
        state: 'progressing', received: 0, total: item.getTotalBytes(), started: Date.now(),
        windowId: win ? win.base.id : null, toastUntil: 0, paused: false,
      };
      items.set(id, d);
      item.on('updated', (_ev, state) => {
        d.state = state;
        d.received = item.getReceivedBytes();
        d.total = item.getTotalBytes();
        d.paused = item.isPaused();
        changed(false);
      });
      item.once('done', (_ev, state) => {
        d.state = state;
        d.received = item.getReceivedBytes();
        d.item = null;
        d.toastUntil = Date.now() + 8000;
        setTimeout(() => changed(true), 8050);
        changed(true);
      });
      changed(true);
    });
  }

  function pub(d) {
    return {
      id: d.id, filename: d.filename, state: d.state, received: d.received, total: d.total, paused: d.paused,
      toast: d.toastUntil > Date.now() || d.state === 'progressing',
    };
  }

  return {
    attach,
    on: (ev, fn) => em.on(ev, fn),
    list: () => [...items.values()].slice(-8).reverse().map(pub),
    toasts: (win) => [...items.values()]
      .filter((d) => (d.windowId === null || !win || d.windowId === win.base.id) && (d.state === 'progressing' || d.toastUntil > Date.now()))
      .slice(-3).map(pub),
    act(id, action) {
      const d = items.get(id);
      if (!d) return;
      if (action === 'open' && d.state === 'completed') shell.openPath(d.path);
      else if (action === 'show') shell.showItemInFolder(d.path);
      else if (action === 'cancel' && d.item) d.item.cancel();
      else if (action === 'pause' && d.item) d.item.pause();
      else if (action === 'resume' && d.item && d.item.canResume()) d.item.resume();
      else if (action === 'dismiss') { d.toastUntil = 0; if (d.state !== 'progressing') items.delete(id); }
      changed(true);
    },
    openFolder: () => shell.openPath(dir()),
    active: () => [...items.values()].some((d) => d.state === 'progressing'),
  };
}

module.exports = { createDownloads, uniquePath };
