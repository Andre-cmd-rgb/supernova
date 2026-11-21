'use strict';
// The settings: their defaults, and which of them the settings page may
// change, with the values each may take. The settings page is the only
// caller of setSetting; anything it does not offer is not writable through
// it (downloads.dir, permissions, zoom, passwords.never: the browser itself
// writes those).

const DEFAULTS = {
  'tabs.position': 'left',
  'sidebar.visible': true,
  'search.engine': 'google',
  'search.suggestions': true,
  'adblock.enabled': true,
  'adblock.allowlist': [],
  'adblock.cookieBanners': false,
  'video.maxHeightOnBattery': 1080,
  'video.maxHeightOnAC': 0,
  'video.prefer30fpsOnBattery': false,
  'animations.limitOnBattery': true,
  'tabs.freezeAfterMin': { ac: 10, battery: 2 },
  'tabs.discardAfterMin': { ac: 120, battery: 30 },
  'passwords.offerToSave': true,
  'passwords.never': [],
  'import.chromeDone': false,
  'zoom.perHost': {},
  'downloads.dir': '',
  permissions: {},
};

const bool = (v) => typeof v === 'boolean';
const oneOf = (...values) => (v) => values.includes(v);
const minutes = (max) => (v) => !!v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).every((k) => k === 'ac' || k === 'battery') &&
  ['ac', 'battery'].every((k) => Number.isInteger(v[k]) && v[k] >= 0 && v[k] <= max);
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

const WRITABLE = {
  'tabs.position': oneOf('left', 'top'),
  'sidebar.visible': bool,
  'search.suggestions': bool,
  'adblock.enabled': bool,
  'adblock.cookieBanners': bool,
  'adblock.allowlist': (v) => Array.isArray(v) && v.length <= 10000 && v.every((h) => typeof h === 'string' && HOST.test(h)),
  'video.maxHeightOnBattery': oneOf(0, 720, 1080, 1440),
  'video.maxHeightOnAC': oneOf(0, 1080, 1440, 2160),
  'video.prefer30fpsOnBattery': bool,
  'animations.limitOnBattery': bool,
  'tabs.freezeAfterMin': minutes(999),
  'tabs.discardAfterMin': minutes(9999),
  'passwords.offerToSave': bool,
};

/** Throws unless the settings page may set `key` to `value`. */
function checkSetting(key, value) {
  if (!Object.prototype.hasOwnProperty.call(WRITABLE, key)) throw new Error(`${key} cannot be changed here`);
  if (!WRITABLE[key](value)) throw new Error(`not a valid value for ${key}`);
}

module.exports = { DEFAULTS, WRITABLE, checkSetting };
