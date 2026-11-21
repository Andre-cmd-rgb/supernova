'use strict';
// Site permissions: a short prompt above the page for what a site may not
// simply take (camera, microphone, screen, location, notifications, opening
// other apps, writing to a file); remembered per site, except the screen and
// other apps (asked each time; a Block sticks) and file writes (while the
// browser runs). DRM (Netflix,
// Spotify) and fullscreen are allowed without asking, as in Chrome. Storage
// access is allowed too: Electron does not block third-party cookies, so it
// grants nothing a frame does not have already.

const path = require('path');
const { originOf, displayHost } = require('./url');

const ALWAYS = new Set([
  'fullscreen', 'clipboard-sanitized-write', 'mediaKeySystem', 'pointerLock', 'keyboardLock',
  'speaker-selection', 'storage-access', 'top-level-storage-access',
]);
const ASK = new Set([
  'media', 'display-capture', 'geolocation', 'notifications', 'midiSysex', 'midi',
  'idle-detection', 'window-management', 'openExternal', 'clipboard-read',
]);

function describe(permission, details) {
  if (permission === 'media') {
    const types = details.mediaTypes || [];
    if (types.includes('video') && types.includes('audio')) return 'use your camera and microphone';
    if (types.includes('video')) return 'use your camera';
    return 'use your microphone';
  }
  return {
    'display-capture': 'see your screen',
    geolocation: 'know your location',
    notifications: 'show notifications',
    midi: 'use MIDI devices',
    midiSysex: 'control MIDI devices',
    'idle-detection': 'know when you are away',
    'window-management': 'manage windows on your displays',
    'clipboard-read': 'read your clipboard',
  }[permission] || permission;
}

// One key per decision: camera and microphone are remembered separately.
function keysFor(permission, details) {
  if (permission === 'media') {
    const types = (details.mediaTypes && details.mediaTypes.length) ? details.mediaTypes : ['audio'];
    return types.map((t) => `media-${t}`);
  }
  return [permission];
}

// The tab a frame belongs to (Electron is loaded here, not at the top: the
// module stays testable in plain Node, which passes its own lookup).
function findWebContents(frame) {
  try {
    const { webContents } = require('electron');
    return webContents.fromFrame(frame.top) || null;
  } catch {
    return null;
  }
}

function createPermissions({ settings, findTab, desktopCapturer, webContentsOfFrame = findWebContents }) {
  let nextId = 1;
  const pending = new Set();
  const sessionDecisions = new Map(); // private windows: forgotten on close
  // "<origin> <path>" the user let a site write, while the browser runs;
  // private windows' apart, forgotten with their other decisions.
  const fileWrites = { normal: new Set(), private: new Set() };
  const writesOf = (isPrivate) => (isPrivate ? fileWrites.private : fileWrites.normal);

  function stored(isPrivate) {
    return isPrivate ? null : settings.get('permissions') || {};
  }

  function decision(origin, key, isPrivate) {
    if (isPrivate) return sessionDecisions.get(`${origin} ${key}`);
    const all = stored(false);
    return all[origin] && all[origin][key];
  }

  function remember(origin, keys, value, isPrivate) {
    if (isPrivate) { for (const k of keys) sessionDecisions.set(`${origin} ${k}`, value); return; }
    const all = { ...stored(false) };
    all[origin] = { ...(all[origin] || {}) };
    for (const k of keys) all[origin][k] = value;
    settings.set('permissions', all);
  }

  function prompt(wc, origin, permission, details, text) {
    const found = findTab(wc);
    // No tab to ask in (it just closed): refused, nothing remembered.
    if (!found) return Promise.resolve('dismiss');
    const { win, tab } = found;
    return new Promise((resolve) => {
      const id = `perm-${nextId++}`;
      const p = {
        id,
        tabId: tab ? tab.id : null,
        public: {
          id, kind: 'permission', host: displayHost(origin) || origin, text,
          actions: [{ id: 'deny', label: 'Block' }, { id: 'allow', label: 'Allow', primary: true }],
        },
        // Answered first, then taken off screen: Electron's callback is never
        // left waiting on the UI.
        resolve: (action) => { pending.delete(p); resolve(action === 'allow' ? 'allow' : 'deny'); win.removePrompt(id); },
        cancel: () => { pending.delete(p); resolve('dismiss'); win.removePrompt(id); },
        tab,
      };
      pending.add(p);
      win.addPrompt(p);
    });
  }

  function attach(session) {
    const isPrivate = !session.isPersistent();
    session.setPermissionRequestHandler(async (wc, permission, callback, details) => {
      const origin = originOf(details.requestingUrl || (wc && wc.getURL()) || '');
      if (ALWAYS.has(permission)) return callback(true);
      // File System Access: reading a file or folder the user picked (in the
      // file chooser, by dropping it, or on an earlier visit) is the pick
      // itself; anything else, writing to it, is asked once per file while
      // the browser runs.
      if (permission === 'fileSystem') {
        if (!origin) return callback(false);
        if (details.fileAccessType === 'readable') return callback(true);
        const file = details.filePath || '';
        const writes = writesOf(isPrivate);
        if (file && writes.has(`${origin} ${file}`)) return callback(true);
        const answer = await prompt(wc, origin, 'fileSystem', details, `wants to save changes to ${path.basename(file) || 'a file'}`);
        if (answer === 'allow' && file) writes.add(`${origin} ${file}`);
        return callback(answer === 'allow');
      }
      // getDisplayMedia comes here first, then to the display handler below,
      // which does the asking (Electron 45, probed): here only a Block counts.
      if (permission === 'display-capture') return callback(!!origin && decision(origin, 'display-capture', isPrivate) !== 'deny');
      if (!ASK.has(permission) || !origin) return callback(false);
      const keys = keysFor(permission, details);
      const known = keys.map((k) => decision(origin, k, isPrivate));
      if (known.every((d) => d === 'allow')) { mark(wc, permission); return callback(true); }
      if (known.some((d) => d === 'deny')) return callback(false);
      let text = `wants to ${describe(permission, details)}`;
      if (permission === 'openExternal') {
        const scheme = (details.externalURL || '').split(':')[0];
        text = `wants to open a ${scheme}: link in another app`;
      }
      const answer = await prompt(wc, origin, permission, details, text);
      if (answer === 'dismiss') return callback(false);
      // Opening other apps is asked each time; a block sticks.
      if (permission !== 'openExternal' || answer === 'deny') remember(origin, keys, answer, isPrivate);
      if (answer === 'allow') mark(wc, permission);
      callback(answer === 'allow');
    });

    session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
      if (ALWAYS.has(permission)) return true;
      const origin = originOf(requestingOrigin || (details && details.requestingUrl) || '');
      if (!origin) return false;
      if (permission === 'fileSystem') {
        if (details && details.fileAccessType === 'readable') return true;
        const file = (details && details.filePath) || '';
        return !!file && writesOf(isPrivate).has(`${origin} ${file}`);
      }
      // enumerateDevices checks "audio" and "video" one by one (the devices'
      // names); Chromium's own checks after getUserMedia come with no type
      // (Electron 45, probed): a site allowed either device passes those.
      if (permission === 'media' && (!details || !details.mediaType || details.mediaType === 'unknown')) {
        return ['media-video', 'media-audio'].some((k) => decision(origin, k, isPrivate) === 'allow');
      }
      const keys = permission === 'media' ? [`media-${(details && details.mediaType) || 'audio'}`] : [permission];
      return keys.every((k) => decision(origin, k, isPrivate) === 'allow');
    });

    // getDisplayMedia (Zoom, Meet screen sharing): asked every time, as in
    // Chrome (on X11 nothing else would ask before the screen is shared; on
    // Wayland the desktop portal's picker follows). "Block" sticks.
    session.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        // A frame can be gone by now: reading it may throw.
        const wc = request.frame && request.frame.top ? webContentsOfFrame(request.frame) : null;
        const origin = originOf(request.securityOrigin || (request.frame && request.frame.url) || '');
        // No origin (a sandboxed frame, an opaque one): nobody to ask about.
        if (!origin) return callback({});
        if (decision(origin, 'display-capture', isPrivate) === 'deny') return callback({});
        // No tab to ask in: refused, but nothing remembered.
        const answer = wc ? await prompt(wc, origin, 'display-capture', {}, 'wants to see your screen') : 'dismiss';
        if (answer === 'deny') remember(origin, ['display-capture'], 'deny', isPrivate);
        if (answer !== 'allow') return callback({});
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        if (!sources.length) return callback({});
        if (wc) mark(wc, 'display-capture');
        callback({ video: sources[0] });
      } catch {
        callback({});
      }
    });
  }

  function mark(wc, permission) {
    if (permission !== 'media' && permission !== 'display-capture') return;
    const found = wc && findTab(wc);
    if (found && found.tab) found.tab.capturing = true;
  }

  return {
    attach,
    /** The last private window closed: its decisions go with it. */
    forgetPrivate() { sessionDecisions.clear(); fileWrites.private.clear(); },
    respond(id, action) {
      for (const p of pending) if (p.id === id) { p.resolve(action); return true; }
      return false;
    },
    pendingFor(tab) { return [...pending].filter((p) => p.tab === tab); },
    forSite(origin) {
      const site = { ...((stored(false) || {})[origin] || {}) };
      // Beta 1 remembered "allow" for the screen, which is asked every time now.
      if (site['display-capture'] === 'allow') delete site['display-capture'];
      return site;
    },
    reset(origin) {
      const all = { ...stored(false) };
      delete all[origin];
      settings.set('permissions', all);
      for (const key of [...fileWrites.normal]) if (key.startsWith(`${origin} `)) fileWrites.normal.delete(key);
    },
  };
}

module.exports = { createPermissions, describe, keysFor };
