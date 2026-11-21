'use strict';
// Site permissions through the handlers Electron calls, with a fake session:
// what is asked, what is remembered, what is never handed out silently.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPermissions } = require('../src/main/permissions');

const SITE = 'https://meet.example';

function setup({ persistent = true, noTab = false, saved, findTab } = {}) {
  const store = saved ? { permissions: saved } : {};
  const settings = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
  const prompts = [];
  const tab = { id: 1 };
  const win = { addPrompt: (p) => prompts.push(p), removePrompt() {} };
  const wc = { id: 7, isDestroyed: () => false, getURL: () => SITE + '/room' };
  const perms = createPermissions({
    settings,
    findTab: findTab || (() => (noTab ? null : { win, tab })),
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
    if (action === 'dismiss') p.cancel(); else p.resolve(action);
    return p;
  };
  return { store, prompts, request, share, check, answer, perms, h };
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

// getDisplayMedia, as Electron 45 runs it: the request handler (as
// "display-capture"), then the display handler.
async function getDisplayMedia(s, action) {
  const asked = s.request('display-capture', { mediaTypes: ['video'] });
  await s.answer(action);
  if (!(await asked)) return 'refused';
  return s.share();
}

test('screen sharing is asked once per share, never remembered; a block sticks', async () => {
  const s = setup();
  assert.deepEqual(await getDisplayMedia(s, 'allow'), { video: { id: 'screen:0' } });
  assert.equal(s.prompts.length, 0, 'one prompt per share, not two');
  assert.deepEqual(await getDisplayMedia(s, 'allow'), { video: { id: 'screen:0' } }, 'asked again: an allow is not remembered');
  assert.equal(s.check('display-capture'), false, 'never reported as granted');

  assert.equal(await getDisplayMedia(s, 'deny'), 'refused');
  assert.equal(s.store.permissions[SITE]['display-capture'], 'deny');
  assert.equal(await s.request('display-capture', { mediaTypes: ['video'] }), false, 'blocked without asking');
  assert.equal(await s.share(), null);
  assert.equal(s.prompts.length, 0);
});

test('getUserMedia for the desktop is asked too: it never reaches the display handler', async () => {
  // chromeMediaSource: "desktop" captures on a yes from the request handler
  // alone, with the same details as getDisplayMedia.
  const s = setup();
  const r = s.request('display-capture', { mediaTypes: ['video'] });
  const p = await s.answer('deny');
  assert.match(p.public.text, /see your screen/);
  assert.equal(await r, false);
});

test('desktop capture with sound says so', async () => {
  const s = setup();
  const r = s.request('display-capture', { mediaTypes: ['audio', 'video'] });
  const p = await s.answer('deny');
  assert.match(p.public.text, /see your screen and hear your computer's sound/);
  assert.equal(await r, false);
});

test('Electron\'s callback is answered once, with a refusal, when something throws', async () => {
  const s = setup({ findTab: () => { throw new Error('tab gone'); } });
  assert.equal(await s.request('geolocation'), false);
  // A tab already destroyed, and no requesting URL: refused, not thrown.
  const calls = [];
  const gone = { id: 9, isDestroyed: () => true, getURL() { throw new Error('Object has been destroyed'); } };
  s.h.request(gone, 'geolocation', (ok) => calls.push(ok), {});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [false]);
});

test('an about:srcdoc frame asks as its own origin', async () => {
  const s = setup();
  const r = s.request('geolocation', { requestingUrl: 'about:srcdoc', securityOrigin: SITE + '/' });
  const p = await s.answer('allow');
  assert.equal(p.public.host, 'meet.example');
  assert.equal(await r, true);
});

test('the request handler\'s yes is good for one share, for that site, for seconds', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const s = setup();
  const asked = s.request('display-capture', { mediaTypes: ['video'] });
  await s.answer('allow');
  assert.equal(await asked, true);
  t.mock.timers.tick(11000);
  const late = s.share();
  await s.answer('dismiss'); // too late: asked again
  assert.equal(await late, null);

  const again = s.request('display-capture', { mediaTypes: ['video'] });
  await s.answer('allow');
  await again;
  const other = s.share('https://other.example');
  await s.answer('dismiss'); // another site: asked
  assert.equal(await other, null);
  const used = s.share();
  await s.answer('dismiss'); // the grant went with the first share that came
  assert.equal(await used, null);
});

test('an allow for the screen saved by beta 1 is dropped at start', async () => {
  const s = setup({ saved: { [SITE]: { 'display-capture': 'allow', geolocation: 'allow' }, 'https://x.example': { 'display-capture': 'allow' } } });
  assert.deepEqual(s.store.permissions, { [SITE]: { geolocation: 'allow' } });
  const r = s.share();
  await s.answer('deny');
  assert.equal(await r, null);
});

test('a prompt with no tab to show it in refuses and remembers nothing', async () => {
  const s = setup({ noTab: true });
  assert.equal(await s.request('geolocation'), false);
  assert.equal(await s.share(), null);
  assert.equal(s.store.permissions, undefined);
});

test('a frame with no origin never gets the screen', async () => {
  const s = setup();
  assert.equal(await s.share('null'), null);
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
  // The check with no type is camera pan/tilt/zoom: never granted.
  assert.equal(s.check('media', {}), false);
  assert.equal(s.check('media', { mediaType: 'unknown' }), false);
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

test('a private window\'s screen grant goes with it', async () => {
  const s = setup({ persistent: false });
  const asked = s.request('display-capture', { mediaTypes: ['video'] });
  await s.answer('allow');
  await asked;
  s.perms.forgetPrivate();
  const r = s.share();
  await s.answer('dismiss'); // asked: the grant is gone
  assert.equal(await r, null);
});
