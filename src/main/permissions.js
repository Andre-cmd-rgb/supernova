'use strict';
// Site permissions: a short prompt above the page for what a site may not
// simply take (camera, microphone, screen, location, notifications, opening
// other apps); remembered per site. DRM (Netflix, Spotify) and fullscreen
// are allowed without asking, as in Chrome.

const { originOf, displayHost } = require('./url');

const ALWAYS = new Set([
  'fullscreen', 'clipboard-sanitized-write', 'mediaKeySystem', 'pointerLock', 'keyboardLock',
  'speaker-selection', 'storage-access', 'top-level-storage-access', 'fileSystem',
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

function createPermissions({ settings, findTab, desktopCapturer }) {
  let nextId = 1;
  const pending = new Set();
  const sessionDecisions = new Map(); // private windows: forgotten on close

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
    if (!found) return Promise.resolve('deny');
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
        resolve: (action) => { pending.delete(p); win.removePrompt(id); resolve(action === 'allow' ? 'allow' : 'deny'); },
        cancel: () => { pending.delete(p); win.removePrompt(id); resolve('dismiss'); },
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
      // Opening other apps is asked each time unless allowed; a block sticks.
      if (permission !== 'openExternal' || answer === 'deny') remember(origin, keys, answer, isPrivate);
      if (answer === 'allow') mark(wc, permission);
      callback(answer === 'allow');
    });

    session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
      if (ALWAYS.has(permission)) return true;
      const origin = originOf(requestingOrigin || (details && details.requestingUrl) || '');
      if (!origin) return false;
      const keys = permission === 'media' ? [`media-${(details && details.mediaType) || 'audio'}`] : [permission];
      return keys.every((k) => decision(origin, k, isPrivate) === 'allow');
    });

    // getDisplayMedia (Zoom, Meet screen sharing): the desktop portal's own
    // picker on Wayland, after the site has the permission.
    session.setDisplayMediaRequestHandler(async (request, callback) => {
      const wc = request.frame && request.frame.top ? findWebContents(request.frame) : null;
      const origin = originOf(request.securityOrigin || (request.frame && request.frame.url) || '');
      try {
        if (origin && decision(origin, 'display-capture', isPrivate) !== 'allow') {
          const answer = wc ? await prompt(wc, origin, 'display-capture', {}, 'wants to see your screen') : 'deny';
          if (answer !== 'allow') return callback({});
          remember(origin, ['display-capture'], 'allow', isPrivate);
        }
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        if (!sources.length) return callback({});
        if (wc) mark(wc, 'display-capture');
        callback({ video: sources[0] });
      } catch {
        callback({});
      }
    });
  }

  function findWebContents(frame) {
    try {
      const { webContents } = require('electron');
      return webContents.fromFrame(frame.top) || null;
    } catch {
      return null;
    }
  }

  function mark(wc, permission) {
    if (permission !== 'media' && permission !== 'display-capture') return;
    const found = wc && findTab(wc);
    if (found && found.tab) found.tab.capturing = true;
  }

  return {
    attach,
    respond(id, action) {
      for (const p of pending) if (p.id === id) { p.resolve(action); return true; }
      return false;
    },
    pendingFor(tab) { return [...pending].filter((p) => p.tab === tab); },
    forSite(origin) { return (stored(false) || {})[origin] || {}; },
    reset(origin) {
      const all = { ...stored(false) };
      delete all[origin];
      settings.set('permissions', all);
    },
  };
}

module.exports = { createPermissions, describe, keysFor };
