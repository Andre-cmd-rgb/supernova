'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixup, fixupNav, displayHost, searchQueryOf, originOf } = require('../src/main/url');

const G = 'https://www.google.com/search?q=';

test('domains become https URLs', () => {
  assert.equal(fixup('youtube.com'), 'https://youtube.com/');
  assert.equal(fixup('www.netflix.com/browse'), 'https://www.netflix.com/browse');
  assert.equal(fixup('patchbay.piserver.stream'), 'https://patchbay.piserver.stream/');
  assert.equal(fixup('  github.com/Andre-cmd-rgb  '), 'https://github.com/Andre-cmd-rgb');
});

test('local hosts and ports use http', () => {
  assert.equal(fixup('localhost:8080'), 'http://localhost:8080/');
  assert.equal(fixup('192.168.1.1'), 'http://192.168.1.1/');
  assert.equal(fixup('10.42.0.233:8765/up'), 'http://10.42.0.233:8765/up');
  assert.equal(fixup('intranet:3000'), 'http://intranet:3000/');
  // Names that exist only on the local network, as typed for a Pi or a NAS.
  assert.equal(fixup('piserver.local:8319'), 'http://piserver.local:8319/');
  assert.equal(fixup('nas.lan'), 'http://nas.lan/');
  assert.equal(fixup('router.home.arpa/admin'), 'http://router.home.arpa/admin');
  // A port other than 443 is its own service, usually plain http.
  assert.equal(fixup('example.com:8080'), 'http://example.com:8080/');
  assert.equal(fixup('example.com:443'), 'https://example.com/');
});

test('only an https Supernova chose itself falls back to http', () => {
  assert.deepEqual(fixupNav('neverssl.com'), { url: 'https://neverssl.com/', upgraded: true });
  assert.deepEqual(fixupNav('https://example.com'), { url: 'https://example.com/', upgraded: false });
  assert.deepEqual(fixupNav('http://example.com'), { url: 'http://example.com/', upgraded: false });
  assert.deepEqual(fixupNav('piserver.local:8319'), { url: 'http://piserver.local:8319/', upgraded: false });
  assert.equal(fixupNav('how tall is everest').upgraded, false);
});

test('everything else is a Google search', () => {
  assert.equal(fixup('how tall is everest'), G + 'how%20tall%20is%20everest');
  assert.equal(fixup('netflix'), G + 'netflix');
  assert.equal(fixup('c++'), G + 'c%2B%2B');
  assert.equal(fixup('what is 1.5'), G + 'what%20is%201.5');
  assert.equal(fixup('file.txt'), G + 'file.txt');
});

test('explicit schemes are kept', () => {
  assert.equal(fixup('http://example.com'), 'http://example.com/');
  assert.equal(fixup('supernova://settings'), 'supernova://settings');
  assert.equal(fixup('about:blank'), 'about:blank');
  assert.equal(fixup('view-source:https://a.com'), 'view-source:https://a.com');
  assert.equal(fixup(''), null);
});

test('display helpers', () => {
  assert.equal(displayHost('https://www.youtube.com/watch?v=x'), 'youtube.com');
  assert.equal(displayHost('supernova://settings/'), 'settings');
  assert.equal(searchQueryOf(G + 'cats%20dogs'), 'cats dogs');
  assert.equal(searchQueryOf('https://example.com/search?q=x'), null);
  assert.equal(originOf('https://accounts.google.com/v3/signin'), 'https://accounts.google.com');
  assert.equal(originOf('data:text/html,hi'), null);
});

test('ownArgs drops the app folder wherever the switches put it', () => {
  const { ownArgs } = require('../src/main/url');
  const app = '/opt/sn/app';
  assert.deepEqual(ownArgs(['electron', app, 'https://a.com'], app), ['https://a.com']);
  assert.deepEqual(ownArgs(['electron', '--ozone-platform=headless', app, 'https://a.com'], app), ['--ozone-platform=headless', 'https://a.com']);
  assert.deepEqual(ownArgs(['electron', '--x', '/opt/sn/app/', 'b.com'], app), ['--x', 'b.com'], 'a trailing slash is the same folder');
  assert.deepEqual(ownArgs(['supernova', '--private', 'https://a.com'], null), ['--private', 'https://a.com'], 'packaged: nothing to drop');
});

test('urlsFrom opens URLs, files and searches, never javascript:', () => {
  const { urlsFrom } = require('../src/main/url');
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-args-'));
  fs.writeFileSync(path.join(dir, 'page.html'), '<p>x</p>');
  fs.writeFileSync(path.join(dir, 'my notes #2?.html'), '<p>x</p>');
  const out = urlsFrom(['--flag', 'https://a.com/', 'page.html', 'my notes #2?.html', 'example.org', 'localhost:3000', 'magnet:?xt=1', 'javascript:alert(1)', 'view-source:javascript:1', 'java\tscript:alert(1)', ''], dir);
  assert.deepEqual(out, [
    'https://a.com/',
    'file://' + path.join(dir, 'page.html'),
    'file://' + path.join(dir, 'my%20notes%20%232%3F.html'),
    'https://example.org/',
    'http://localhost:3000/',
    'magnet:?xt=1',
  ]);
  assert.equal(new URL(out[2]).pathname, path.join(dir, 'my%20notes%20%232%3F.html'), 'the whole name is the path');
  fs.rmSync(dir, { recursive: true, force: true });
});
