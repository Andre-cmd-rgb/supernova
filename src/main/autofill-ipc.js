'use strict';
// Password autofill, main side (agent A). ipcMain, vault, settings and
// promptSave are injected; nothing here requires electron.
//
// The origin is always the sender frame's real origin (event.senderFrame),
// never anything the page sends. Read it synchronously at message arrival:
// after the frame navigates, senderFrame is null.

const { normalizeOrigin } = require('./passwords');

const USERNAME_TTL_MS = 10 * 60 * 1000;
const MAX_FIELD = 4096;

function frameOrigin(event) {
  let origin;
  try { origin = event && event.senderFrame && event.senderFrame.origin; } catch { origin = null; }
  return normalizeOrigin(origin) || null;
}

function isPrivate(event) {
  try { return event.sender.session.isPersistent() === false; } catch { return true; }
}

function str(v, max) {
  return typeof v === 'string' && v.length <= max ? v : null;
}

function registerAutofillIpc({ ipcMain, vault, settings, promptSave }) {
  if (!ipcMain || !vault || !settings || typeof promptSave !== 'function') {
    throw new Error('registerAutofillIpc: ipcMain, vault, settings and promptSave are required');
  }

  // Username typed on a username-only step (e.g. a login split over two
  // documents), so the password step can be matched and saved with it.
  // Key: webContents id + '\n' + origin. Memory only.
  const usernames = new Map();
  const watched = new WeakSet();
  const inFlight = new Set();

  function wcKey(event, origin) {
    return event.sender.id + '\n' + origin;
  }

  function watch(wc) {
    if (watched.has(wc) || typeof wc.once !== 'function') return;
    watched.add(wc);
    wc.once('destroyed', () => {
      const prefix = wc.id + '\n';
      for (const k of usernames.keys()) if (k.startsWith(prefix)) usernames.delete(k);
    });
  }

  function rememberedUsername(event, origin) {
    const k = wcKey(event, origin);
    const r = usernames.get(k);
    if (!r) return '';
    if (Date.now() - r.at > USERNAME_TTL_MS) { usernames.delete(k); return ''; }
    return r.username;
  }

  function onQuery(event /* , payload: ignored on purpose */) {
    const origin = frameOrigin(event);
    if (!origin) return [];
    let found;
    try { found = vault.find(origin); } catch { return []; }
    const remembered = rememberedUsername(event, origin).toLowerCase();
    const out = found.map((e) => ({
      id: e.id,
      origin: e.origin,
      username: e.username,
      password: e.password,
      preferred: !!remembered && e.username.toLowerCase() === remembered,
    }));
    if (remembered) out.sort((a, b) => b.preferred - a.preferred);
    return out;
  }

  function onUsername(event, payload) {
    const origin = frameOrigin(event);
    if (!origin || isPrivate(event)) return;
    const username = str(payload && payload.username, 1024);
    if (!username || !username.trim()) return;
    watch(event.sender);
    usernames.set(wcKey(event, origin), { username: username.trim(), at: Date.now() });
  }

  async function onSubmitted(event, payload) {
    // Everything that depends on the event is read before the first await.
    const origin = frameOrigin(event);
    if (!origin) return;
    if (isPrivate(event)) return;
    const webContents = event.sender;
    const password = str(payload && payload.password, MAX_FIELD);
    if (!password) return;
    let username = str(payload && payload.username, 1024);
    username = username ? username.trim() : '';
    if (!username) username = rememberedUsername(event, origin);

    if (settings.get('passwords.offerToSave') === false) return;
    const never = settings.get('passwords.never');
    if (Array.isArray(never) && never.includes(origin)) return;
    if (!vault.available().ok) return;

    const saved = vault.find(origin);
    if (saved.some((e) => e.password === password && (!username || e.username === username))) return;
    const exact = saved.filter((e) => e.origin === origin);
    const isUpdate = exact.some((e) => e.username === username);

    const key = wcKey(event, origin) + '\n' + username;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      let choice;
      try {
        choice = await promptSave({ webContents, origin, username, isUpdate });
      } catch {
        return;
      }
      if (choice === 'save') {
        try { vault.save({ origin, username, password }); } catch (err) {
          console.error('[autofill] could not save:', err.code || 'error');
        }
      } else if (choice === 'never') {
        const list = settings.get('passwords.never');
        const next = Array.isArray(list) ? list.slice() : [];
        if (!next.includes(origin)) next.push(origin);
        settings.set('passwords.never', next);
      }
    } finally {
      inFlight.delete(key);
    }
  }

  const onSubmittedSafe = (event, payload) => {
    onSubmitted(event, payload).catch(() => {});
  };

  ipcMain.handle('sn:pw:query', onQuery);
  ipcMain.on('sn:pw:submitted', onSubmittedSafe);
  ipcMain.on('sn:pw:username', onUsername);

  return {
    dispose() {
      if (typeof ipcMain.removeHandler === 'function') ipcMain.removeHandler('sn:pw:query');
      ipcMain.removeListener('sn:pw:submitted', onSubmittedSafe);
      ipcMain.removeListener('sn:pw:username', onUsername);
      usernames.clear();
    },
  };
}

module.exports = { registerAutofillIpc };
