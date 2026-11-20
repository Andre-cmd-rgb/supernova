'use strict';
// Battery or mains, from UPower through Electron's powerMonitor, with a
// test override (SUPERNOVA_FORCE_BATTERY=1|0).

const { EventEmitter } = require('events');

function createPower(powerMonitor) {
  const em = new EventEmitter();
  const forced = process.env.SUPERNOVA_FORCE_BATTERY;
  let onBattery = forced ? forced === '1' : safe(() => powerMonitor.isOnBatteryPower(), false);
  const set = (v) => {
    if (forced || v === onBattery) return;
    onBattery = v;
    em.emit('change', onBattery);
  };
  powerMonitor.on('on-battery', () => set(true));
  powerMonitor.on('on-ac', () => set(false));
  return {
    onBattery: () => onBattery,
    on: (ev, fn) => em.on(ev, fn),
    off: (ev, fn) => em.off(ev, fn),
  };
}

function safe(fn, dflt) {
  try { return fn(); } catch { return dflt; }
}

module.exports = { createPower };
