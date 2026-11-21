'use strict';
// Site permissions through the handlers Electron calls, with a fake session:
// what is asked, what is remembered, what is never handed out silently.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPermissions } = require('../src/main/permissions');

const SITE = 'https://meet.example';

function setup({ persistent = true } = {}) {
  const store = {};
  const settings = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
  const prompts = [];
  const tab = { id: 1 };
  const win = { addPrompt: (p) => prompts.push(p), removePrompt() {} };
  const wc = { getURL: () => SITE + '/room' };
  const perms = createPermissions({
    settings,
    findTab: () => ({ win, tab }),
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
});

test('screen sharing is asked every time, and a block sticks', async () => {
  const s = setup();
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
});

test('a frame with no origin never gets the screen', async () => {
  const s = setup();
  assert.deepEqual(await s.share('null'), {});
  assert.equal(s.prompts.length, 0);
});

test('a site allowed the camera may read the devices\' names', async () => {
  const s = setup();
  assert.equal(s.check('media', { mediaType: 'unknown' }), false);
  const r = s.request('media', { mediaTypes: ['video'] });
  await s.answer('allow');
  assert.equal(await r, true);
  assert.equal(s.check('media', { mediaType: 'video' }), true);
  assert.equal(s.check('media', { mediaType: 'audio' }), false);
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
