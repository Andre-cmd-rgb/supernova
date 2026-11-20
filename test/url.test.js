'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixup, displayHost, searchQueryOf, originOf } = require('../src/main/url');

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
