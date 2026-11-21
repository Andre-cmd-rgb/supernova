'use strict';
// The supernova:// pages and their API: which page may call what, which
// files each host serves, what a page may open, and what the settings page
// may write. A web page must not reach the settings page's API by any route.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { internalAllowed, handlerFor } = require('../src/main/protocol');
const { mayOpen } = require('../src/main/url');
const { DEFAULTS, WRITABLE, checkSetting } = require('../src/main/settings-schema');

test('only the settings page itself gets the whole internal API', () => {
  assert.equal(internalAllowed('supernova://settings/', 'setSetting'), true);
  assert.equal(internalAllowed('supernova://settings', 'passwords'), true);
  assert.equal(internalAllowed('supernova://settings/#import', 'detectProfiles'), true);
  assert.equal(internalAllowed('supernova://settings/?x=1', 'info'), true);
  // Another page's file under the settings host, or any other path.
  assert.equal(internalAllowed('supernova://settings/error.html', 'setSetting'), false);
  assert.equal(internalAllowed('supernova://settings/index.html', 'setSetting'), false);
  assert.equal(internalAllowed('supernova://settings/x/../error.html', 'setSetting'), false);
  // Look-alike hosts and URLs.
  assert.equal(internalAllowed('supernova://settingsx/', 'setSetting'), false);
  assert.equal(internalAllowed('supernova://settings.evil.com/', 'setSetting'), false);
  assert.equal(internalAllowed('supernova://user@settings/', 'setSetting'), false);
  assert.equal(internalAllowed('supernova://settings:8080/', 'setSetting'), false);
  assert.equal(internalAllowed('https://settings/', 'setSetting'), false);
  assert.equal(internalAllowed('https://evil.com/?supernova://settings/', 'setSetting'), false);
  assert.equal(internalAllowed('', 'setSetting'), false);
  assert.equal(internalAllowed('not a url', 'setSetting'), false);
});

test('the error page only reads the theme', () => {
  assert.equal(internalAllowed('supernova://error/?url=https%3A%2F%2Fx.com&code=-105', 'theme'), true);
  assert.equal(internalAllowed('supernova://error/', 'setSetting'), false);
  assert.equal(internalAllowed('supernova://error/', 'passwords'), false);
  assert.equal(internalAllowed('supernova://error/settings.html', 'theme'), false);
});

test('each host serves its own page and files, and nothing else', async () => {
  const fetched = [];
  const net = { fetch: (u) => { fetched.push(u); return { ok: true, url: u }; } };
  const handle = handlerFor(net);
  const get = async (url) => {
    fetched.length = 0;
    const r = await handle({ url });
    return r.status === 404 ? 404 : path.basename(new URL(fetched[0]).pathname);
  };
  assert.equal(await get('supernova://settings/'), 'settings.html');
  assert.equal(await get('supernova://settings/settings.js'), 'settings.js');
  assert.equal(await get('supernova://settings/pages.css'), 'pages.css');
  assert.equal(await get('supernova://error/'), 'error.html');
  assert.equal(await get('supernova://error/error.js'), 'error.js');
  assert.equal(await get('supernova://settings/shared/icons.js'), 404, 'the browser UI is not an internal page');
  assert.equal(await get('supernova://settings/error.html'), 404);
  assert.equal(await get('supernova://settings/error.js'), 404);
  assert.equal(await get('supernova://error/settings.html'), 404);
  assert.equal(await get('supernova://error/settings.js'), 404);
  assert.equal(await get('supernova://nope/'), 404);
  assert.equal(await get('supernova://constructor/'), 404);
  assert.equal(await get('supernova://settings/%2e%2e%2fmain%2fmain.js'), 404);
  assert.equal(await get('supernova://settings/shared/%2e%2e%2f%2e%2e%2fmain%2fmain.js'), 404);
});

test('a web page can open neither internal pages nor local files', () => {
  const web = 'https://evil.example/page';
  assert.equal(mayOpen(web, 'supernova://settings/'), false);
  assert.equal(mayOpen(web, 'SUPERNOVA://settings/error.html?url=javascript:alert(1)'), false);
  assert.equal(mayOpen(web, ' supernova://settings/'), false);
  assert.equal(mayOpen(web, 'file:///home/user/.ssh/id_ed25519'), false);
  assert.equal(mayOpen(web, 'javascript:alert(1)'), false);
  assert.equal(mayOpen(web, 'view-source:file:///etc/passwd'), false);
  assert.equal(mayOpen(web, 'view-source:supernova://settings/'), false);
  assert.equal(mayOpen(web, 'blob:supernova://settings/x'), false);
  assert.equal(mayOpen(web, 'filesystem:file:///x'), false);
  assert.equal(mayOpen(web, 'view-source:view-source:view-source:view-source:view-source:https://x/'), false);
  assert.equal(mayOpen(web, 'view-source:https://example.com/'), true);
  assert.equal(mayOpen(web, 'blob:https://evil.example/1234'), true);
  assert.equal(mayOpen('view-source:supernova://settings/', 'supernova://settings/'), true);
  assert.equal(mayOpen('', 'supernova://settings/'), false, 'a fresh tab its opener drives');
  assert.equal(mayOpen('about:blank', 'supernova://settings/'), false);
  assert.equal(mayOpen('', 'file:///etc/passwd'), false, 'redirects (no page) never reach them');
  assert.equal(mayOpen(web, 'https://other.example/'), true);
  assert.equal(mayOpen(web, 'mailto:a@b.c'), true, 'other apps are asked for by the permission prompt');
  assert.equal(mayOpen('supernova://error/?url=x', 'https://example.com/'), true, 'the error page retries');
  assert.equal(mayOpen('supernova://settings/', 'supernova://settings/#import'), true);
  assert.equal(mayOpen('file:///home/u/a.html', 'file:///home/u/b.html'), true);
  assert.equal(mayOpen('supernova://settings/', 'javascript:void 0'), false);
});

test('the settings page may only write what it offers, with values it offers', () => {
  for (const key of Object.keys(WRITABLE)) {
    assert.ok(Object.prototype.hasOwnProperty.call(DEFAULTS, key), `${key} has a default`);
    assert.doesNotThrow(() => checkSetting(key, DEFAULTS[key]), `${key}: its default is valid`);
  }
  for (const key of ['downloads.dir', 'permissions', 'zoom.perHost', 'passwords.never', 'import.chromeDone', 'search.engine', '__proto__', 'nope']) {
    assert.throws(() => checkSetting(key, DEFAULTS[key]), /cannot be changed/, key);
  }
  assert.throws(() => checkSetting('tabs.position', 'bottom'));
  assert.throws(() => checkSetting('sidebar.visible', 'yes'));
  assert.throws(() => checkSetting('video.maxHeightOnAC', 123));
  assert.throws(() => checkSetting('tabs.freezeAfterMin', { ac: -1, battery: 2 }));
  assert.throws(() => checkSetting('tabs.freezeAfterMin', { ac: 1, battery: 2, extra: 3 }));
  assert.throws(() => checkSetting('tabs.discardAfterMin', null));
  assert.throws(() => checkSetting('adblock.allowlist', ['ok.com', 'not a host']));
  assert.throws(() => checkSetting('adblock.allowlist', 'ok.com'));
  assert.doesNotThrow(() => checkSetting('adblock.allowlist', ['youtube.com', 'sub.example.co.uk']));
  assert.doesNotThrow(() => checkSetting('tabs.freezeAfterMin', { ac: 0, battery: 999 }));
});

test('every setting the settings page has a control for is writable, and nothing more', () => {
  const html = require('node:fs').readFileSync(path.join(__dirname, '../src/pages/settings.html'), 'utf8');
  const controls = new Set([...html.matchAll(/data-setting="([^"]+)"/g)].map((m) => m[1]));
  controls.add('adblock.allowlist'); // the "turn back on" links
  assert.deepEqual([...controls].sort(), Object.keys(WRITABLE).sort());
});
