'use strict';
// The media policy: how much video and animation the pages may ask for, from
// the power source and the settings. Pages read it at document start through
// the page preload (sn:media:config) and get every change pushed to them.
//
//   maxHeight  largest video tier sites are told the device can play (0 = no cap)
//   maxFps     highest video frame rate offered (0 = no cap)
//   rafFps     requestAnimationFrame callbacks per second (0 = untouched)
//
// The shim (src/preload/media-shim.js) never hides the 480p and lower tiers,
// so a cap can lower quality but never leave a site with nothing to play.

const { EventEmitter } = require('node:events');

const FLOOR = 480;
const KEYS = new Set(['video.maxHeightOnBattery', 'video.maxHeightOnAC', 'video.prefer30fpsOnBattery', 'animations.limitOnBattery']);

function height(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(n, FLOOR);
}

function compute(settings, onBattery) {
  const get = (k) => settings.get(k);
  if (onBattery) {
    return {
      battery: true,
      maxHeight: height(get('video.maxHeightOnBattery')),
      maxFps: get('video.prefer30fpsOnBattery') === true ? 30 : 0,
      rafFps: get('animations.limitOnBattery') === false ? 0 : 30,
    };
  }
  return { battery: false, maxHeight: height(get('video.maxHeightOnAC')), maxFps: 0, rafFps: 0 };
}

const same = (a, b) => a.battery === b.battery && a.maxHeight === b.maxHeight && a.maxFps === b.maxFps && a.rafFps === b.rafFps;

/**
 * createMediaPolicy({ settings, power })
 *   settings: { get(key), on('change', (key) => {}) }
 *   power:    { onBattery(), on('change', fn) }
 * -> { current(), on('change', (cfg) => {}), off(), close() }
 */
function createMediaPolicy({ settings, power }) {
  const em = new EventEmitter();
  let cur = compute(settings, !!power.onBattery());

  const refresh = () => {
    const next = compute(settings, !!power.onBattery());
    if (same(next, cur)) return;
    cur = next;
    em.emit('change', { ...cur });
  };
  const onSetting = (key) => {
    if (typeof key !== 'string' || KEYS.has(key) || key === 'video' || key === 'animations') refresh();
  };
  settings.on('change', onSetting);
  power.on('change', refresh);

  return {
    current: () => ({ ...cur }),
    on: (ev, fn) => em.on(ev, fn),
    off: (ev, fn) => em.off(ev, fn),
    close() {
      if (settings.off) settings.off('change', onSetting);
      else if (settings.removeListener) settings.removeListener('change', onSetting);
      if (power.off) power.off('change', refresh);
      em.removeAllListeners();
    },
  };
}

module.exports = { createMediaPolicy, FLOOR };
