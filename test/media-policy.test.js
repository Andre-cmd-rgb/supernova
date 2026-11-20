'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMediaPolicy } = require('../src/main/media-policy');

const DEFAULTS = {
  'video.maxHeightOnBattery': 1080,
  'video.maxHeightOnAC': 0,
  'video.prefer30fpsOnBattery': false,
  'animations.limitOnBattery': true,
};

function fakeSettings(values = {}) {
  const em = new EventEmitter();
  const data = { ...DEFAULTS, ...values };
  return Object.assign(em, {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; em.emit('change', k, v); },
  });
}

function fakePower(onBattery = false) {
  const em = new EventEmitter();
  let state = onBattery;
  return Object.assign(em, {
    onBattery: () => state,
    set: (v) => { state = v; em.emit('change', v); },
  });
}

test('on mains nothing is capped by default', () => {
  const m = createMediaPolicy({ settings: fakeSettings(), power: fakePower(false) });
  assert.deepEqual(m.current(), { battery: false, maxHeight: 0, maxFps: 0, rafFps: 0 });
});

test('on battery: 1080p cap and 30 fps animations by default', () => {
  const m = createMediaPolicy({ settings: fakeSettings(), power: fakePower(true) });
  assert.deepEqual(m.current(), { battery: true, maxHeight: 1080, maxFps: 0, rafFps: 30 });
});

test('unplugging and plugging in push the new policy once each', () => {
  const power = fakePower(false);
  const m = createMediaPolicy({ settings: fakeSettings(), power });
  const seen = [];
  m.on('change', (cfg) => seen.push(cfg));
  power.set(true);
  power.set(true);
  power.set(false);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].maxHeight, 1080);
  assert.equal(seen[1].maxHeight, 0);
});

test('settings apply live; unrelated settings do not wake the pages', () => {
  const settings = fakeSettings();
  const m = createMediaPolicy({ settings, power: fakePower(true) });
  const seen = [];
  m.on('change', (cfg) => seen.push(cfg));
  settings.set('tabs.position', 'top');
  assert.equal(seen.length, 0);
  settings.set('video.prefer30fpsOnBattery', true);
  settings.set('animations.limitOnBattery', false);
  settings.set('video.maxHeightOnBattery', 720);
  assert.deepEqual(seen.at(-1), { battery: true, maxHeight: 720, maxFps: 30, rafFps: 0 });
  assert.equal(seen.length, 3);
});

test('a cap is never below 480p, and nonsense means no cap', () => {
  const settings = fakeSettings({ 'video.maxHeightOnAC': 240 });
  const m = createMediaPolicy({ settings, power: fakePower(false) });
  assert.equal(m.current().maxHeight, 480);
  settings.set('video.maxHeightOnAC', 'banana');
  assert.equal(m.current().maxHeight, 0);
  settings.set('video.maxHeightOnAC', -5);
  assert.equal(m.current().maxHeight, 0);
});

test('current() hands out copies', () => {
  const m = createMediaPolicy({ settings: fakeSettings(), power: fakePower(true) });
  m.current().maxHeight = 1;
  assert.equal(m.current().maxHeight, 1080);
});
