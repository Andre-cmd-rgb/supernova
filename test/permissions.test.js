'use strict';
// Site permissions through the handlers Electron calls, with a fake session:
// what is asked, what is remembered, what is never handed out silently.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPermissions } = require('../src/main/permissions');

const SITE = 'https://meet.example';

function setup({ persistent = true, noTab = false } = {}) {
  const store = {};
  const settings = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
  const prompts = [];
  const tab = { id: 1 };
  const win = { addPrompt: (p) => prompts.push(p), removePrompt() {} };
  const wc = { getURL: () => SITE + '/room' };
  const perms = createPermissions({
    settings,
    findTab: () => (noTab ? null : { win, tab }),
    desktopCapturer: { getSources: async () => [{ id: 'screen:0' }] },
    webContentsOfFrame: () => wc,
  });
  const h = {};
  perms.attach({
    isPersistent: () => persistent,
    setPermissionRequestHandler: (f) => { h.request = f; },
    setPermissionCheckHandler: (f) => { h.check = f; },
    setDisplayMediaRequestHandler: (f) => { h.display = f; },
  });
  const request = (permission, details = {}) => new Promise((resolve) => {
    h.request(wc, permission, resolve, { requestingUrl: SITE + '/room', ...details });
  });
  const share = (origin = SITE) => new Promise((resolve) => {
    h.display({ securityOrigin: origin, frame: { top: {}, url: origin + '/' } }, resolve);
  });
  const check = (permission, details = {}) => h.check(wc, permission, SITE, details);
  // Answer the newest prompt once it is up.
  const answer = async (action) => {
    for (let i = 0; i < 20 && !prompts.length; i++) await new Promise((r) => setImmediate(r));
    const p = prompts.pop();
    assert.ok(p, 'a prompt was shown');
    p.resolve(action);
    return p;
  };
  return { store, prompts, request, share, check, answer, perms };
}

test('reading a picked file needs no prompt; writing to it is asked once per file', async () => {
  const s = setup();
  assert.equal(await s.request('fileSystem', { fileAccessType: 'readable', filePath: '/home/u/a.txt' }), true);
  assert.equal(s.prompts.length, 0);
  assert.equal(s.check('fileSystem', { fileAccessType: 'writable', filePath: '/home/u/a.txt' }), false);

  const first = s.request('fileSystem', { fileAccessType: 'writable', filePath: '/home/u/a.txt' });
  const p = await s.answer('allow');
  assert.match(p.public.text, /save changes to a\.txt/);
  assert.equal(await first, true);
  assert.equal(await s.request('fileSystem', { fileAccessType: 'writable', filePath: '/home/u/a.txt' }), true, 'same file: not asked again');
  assert.equal(s.check('fileSystem', { fileAccessType: 'writable', filePath: '/home/u/a.txt' }), true);

  const other = s.request('fileSystem', { fileAccessType: 'writable', filePath: '/home/u/b.txt' });
  await s.answer('deny');
  assert.equal(await other, false);
  assert.equal(s.store.permissions, undefined, 'file decisions are never written to settings');

  // Anything but a read is asked, and a write with no file named is asked
  // every time rather than remembered for every file.
  const unknown = s.request('fileSystem', { filePath: '/home/u/c.txt' });
  await s.answer('deny');
  assert.equal(await unknown, false);
  for (let i = 0; i < 2; i++) {
    const nameless = s.request('fileSystem', { fileAccessType: 'writable' });
    await s.answer('allow');
    assert.equal(await nameless, true);
  }
  assert.equal(s.check('fileSystem', { fileAccessType: 'writable' }), false);

  // Forgetting the site forgets what it may write.
  s.perms.reset(SITE);
  assert.equal(s.check('fileSystem', { fileAccessType: 'writable', filePath: '/home/u/a.txt' }), false);
});

test('a private window\'s file writes are its own and forgotten with it', async () => {
  const s = setup({ persistent: false });
  const r = s.request('fileSystem', { fileAccessType: 'writable', filePath: '/home/u/a.txt' });
  await s.answer('allow');
  assert.equal(await r, true);
  assert.equal(s.check('fileSystem', { fileAccessType: 'writable', filePath: '/home/u/a.txt' }), true);
  s.perms.forgetPrivate();
  assert.equal(s.check('fileSystem', { fileAccessType: 'writable', filePath: '/home/u/a.txt' }), false);
});

test('screen sharing is asked every time, and a block sticks', async () => {
  const s = setup();
  // getDisplayMedia reaches the request handler first (as "display-capture"),
  // then the display handler, which is the one that asks: one prompt, not two.
  assert.equal(await s.request('display-capture', { mediaTypes: ['video'] }), true);
  assert.equal(s.prompts.length, 0);
  let r = s.share();
  await s.answer('allow');
  assert.deepEqual(await r, { video: { id: 'screen:0' } });

  r = s.share();
  await s.answer('allow');
  assert.deepEqual(await r, { video: { id: 'screen:0' } }, 'asked again: an allow is not remembered');

  r = s.share();
  await s.answer('deny');
  assert.deepEqual(await r, {});
  assert.deepEqual(await s.share(), {}, 'blocked without asking');
  assert.equal(s.prompts.length, 0);
  assert.equal(s.store.permissions[SITE]['display-capture'], 'deny');
  assert.equal(await s.request('display-capture', { mediaTypes: ['video'] }), false);
});

test('an allow for the screen saved by beta 1 is neither used nor shown', async () => {
  const s = setup();
  s.store.permissions = { [SITE]: { 'display-capture': 'allow', geolocation: 'allow' } };
  assert.deepEqual(s.perms.forSite(SITE), { geolocation: 'allow' });
  const r = s.share();
  await s.answer('deny');
  assert.deepEqual(await r, {});
});

test('a prompt with no tab to show it in refuses and remembers nothing', async () => {
  const s = setup({ noTab: true });
  assert.equal(await s.request('geolocation'), false);
  assert.deepEqual(await s.share(), {});
  assert.equal(s.store.permissions, undefined);
});

test('a frame with no origin never gets the screen', async () => {
  const s = setup();
  assert.deepEqual(await s.share('null'), {});
  assert.equal(s.prompts.length, 0);
});

test('camera and microphone checks, as Electron 45 makes them', async () => {
  const s = setup();
  assert.equal(s.check('media', {}), false);
  const r = s.request('media', { mediaTypes: ['video'] });
  await s.answer('allow');
  assert.equal(await r, true);
  // enumerateDevices: one check per kind, for the devices' names.
  assert.equal(s.check('media', { mediaType: 'video' }), true);
  assert.equal(s.check('media', { mediaType: 'audio' }), false);
  // Chromium's own checks after getUserMedia carry no type.
  assert.equal(s.check('media', {}), true);
  assert.equal(s.check('media', { mediaType: 'unknown' }), true);
});

test('private windows remember nothing on disk and forget on close', async () => {
  const s = setup({ persistent: false });
  const r = s.request('geolocation');
  await s.answer('allow');
  assert.equal(await r, true);
  assert.equal(s.store.permissions, undefined);
  assert.equal(await s.request('geolocation'), true, 'remembered for the private session');
  s.perms.forgetPrivate();
  const again = s.request('geolocation');
  await s.answer('deny');
  assert.equal(await again, false, 'asked again after the last private window closed');
});
