'use strict';
// Runs in the page's own world, at document start, before any page script
// (the page preload calls contextBridge.executeInMainWorld with it). Electron
// serializes the function, so it must stay self-contained: no imports, no
// variables from outside it. test/media-shim.test.js runs it in a bare vm
// context to keep it that way.
//
// What it does, with the config from src/main/media-policy.js:
// - maxHeight / maxFps: video formats above the cap are reported as not
//   supported by MediaSource.isTypeSupported (YouTube passes width=, height=,
//   framerate= in the type) and navigator.mediaCapabilities.decodingInfo, so
//   the site picks a cheaper stream. Audio types and the 480p-and-lower tiers
//   are never touched, so there is always something to play. Sites probe when
//   a video loads: a new cap applies from the next video or reload.
// - rafFps: requestAnimationFrame callbacks run at most rafFps times a second,
//   batched on a real animation frame (timestamps stay real and monotonic).
//   Between batches no frame is requested, so the page's main thread sleeps.
//   rafFps 0 hands every call straight to the browser's own functions.
//
// Called again with a new config, it only updates the config: the wrappers
// are installed once per document.

function applyMediaShim(config) {
  'use strict';
  const g = globalThis;
  const KEY = Symbol.for('supernova.media');
  const pick = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const cfg = {
    maxHeight: pick(config && config.maxHeight),
    maxFps: pick(config && config.maxFps),
    rafFps: pick(config && config.rafFps),
  };

  const existing = g[KEY];
  if (existing && typeof existing.set === 'function') {
    existing.set(cfg);
    return;
  }

  const FLOOR = 480;
  const listeners = [];
  const st = {
    cfg,
    set(next) {
      st.cfg = next;
      for (const fn of listeners) {
        try { fn(); } catch {}
      }
    },
  };
  Object.defineProperty(g, KEY, { value: st, enumerable: false, configurable: false, writable: false });

  const Reflect_ = Reflect;
  const ProxyCtor = Proxy;
  const PromiseCtor = g.Promise;

  // "30000/1001", "59.94", 60 -> number; anything else -> NaN.
  const num = (v) => {
    if (typeof v === 'number') return v;
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!s) return NaN;
    const frac = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(s);
    if (frac) return Number(frac[1]) / Number(frac[2]);
    return Number(s);
  };

  // Is a video stream of this size and frame rate above the cap?
  function blocked(width, height, framerate) {
    const c = st.cfg;
    if (!(c.maxHeight > 0) && !(c.maxFps > 0)) return false;
    const w = num(width) > 0 ? num(width) : 0;
    const h = num(height) > 0 ? num(height) : 0;
    let low;
    let over = false;
    if (w > 0 && h > 0) {
      // Both sides known: compare pixel counts, so portrait and very wide
      // videos land in the tier they are encoded as.
      const pixels = w * h;
      low = pixels <= FLOOR * FLOOR * (16 / 9) * 1.1;
      if (c.maxHeight > 0) over = pixels > c.maxHeight * c.maxHeight * (16 / 9) * 1.1;
    } else if (h > 0 || w > 0) {
      const tier = h > 0 ? h : w * (9 / 16);
      low = tier <= FLOOR;
      if (c.maxHeight > 0) over = tier > c.maxHeight;
    } else {
      return false; // size unknown: leave it to the site
    }
    if (low) return false;
    if (over) return true;
    const fps = num(framerate);
    return c.maxFps > 0 && fps > c.maxFps + 0.5;
  }

  function parseType(type) {
    const s = String(type);
    const semi = s.indexOf(';');
    const mime = (semi < 0 ? s : s.slice(0, semi)).trim().toLowerCase();
    const params = {};
    if (semi >= 0) {
      for (const part of s.slice(semi + 1).split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      }
    }
    return { mime, params };
  }

  // Replace obj[name] (found on obj or its prototype chain) by a Proxy of the
  // original: same name, length, toString and descriptor.
  function wrap(obj, name, makeTrap) {
    let owner = obj;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner);
    if (!owner) return null;
    const d = Object.getOwnPropertyDescriptor(owner, name);
    if (!d || typeof d.value !== 'function') return null;
    const original = d.value;
    Object.defineProperty(owner, name, {
      value: new ProxyCtor(original, { apply: makeTrap(original) }),
      writable: d.writable, enumerable: d.enumerable, configurable: d.configurable,
    });
    return original;
  }

  // ----- video caps ---------------------------------------------------------

  const typeTrap = () => (target, thisArg, args) => {
    try {
      const { mime, params } = parseType(args[0]);
      if (mime.startsWith('video/') && blocked(params.width, params.height, params.framerate)) return false;
    } catch {}
    return Reflect_.apply(target, thisArg, args);
  };
  try { if (g.MediaSource) wrap(g.MediaSource, 'isTypeSupported', typeTrap); } catch {}
  try { if (g.ManagedMediaSource) wrap(g.ManagedMediaSource, 'isTypeSupported', typeTrap); } catch {}

  try {
    if (g.MediaCapabilities && g.MediaCapabilities.prototype) {
      wrap(g.MediaCapabilities.prototype, 'decodingInfo', () => (target, thisArg, args) => {
        try {
          const c = args[0];
          const v = c && typeof c === 'object' ? c.video : null;
          if (v && typeof v === 'object' && blocked(v.width, v.height, v.framerate)) {
            return PromiseCtor.resolve({ supported: false, smooth: false, powerEfficient: false, keySystemAccess: null, configuration: c });
          }
        } catch {}
        return Reflect_.apply(target, thisArg, args);
      });
    }
  } catch {}

  // ----- animation frame rate ------------------------------------------------

  const nativeRaf = g.requestAnimationFrame;
  const nativeCaf = g.cancelAnimationFrame;
  if (typeof nativeRaf !== 'function' || typeof nativeCaf !== 'function') return;
  const setT = g.setTimeout;
  const clearT = g.clearTimeout;
  const perf = g.performance;
  const report = typeof g.reportError === 'function' ? g.reportError : null;
  // Our ids live far above the browser's own (which count up from 1), so a
  // cancel can tell them apart even across a policy change.
  const OFFSET = 0x40000000;
  let nextId = 0;
  let queue = new Map();
  let scheduled = false; // a timer or a real frame is pending
  let timer = 0;
  let last = -Infinity; // timestamp of the last batch

  function frame(ts) {
    scheduled = false;
    last = ts;
    const batch = queue;
    queue = new Map();
    for (const cb of batch.values()) {
      try {
        cb(ts);
      } catch (err) {
        if (report) Reflect_.apply(report, g, [err]);
        else Reflect_.apply(setT, g, [() => { throw err; }, 0]);
      }
    }
  }

  function requestFrame() {
    timer = 0;
    Reflect_.apply(nativeRaf, g, [frame]);
  }

  function pump() {
    if (scheduled) return;
    scheduled = true;
    const fps = st.cfg.rafFps;
    // Wake a little early: the real frame then lands on the next vsync.
    const wait = fps > 0 ? last + 1000 / fps - perf.now() - 4 : 0;
    if (wait > 1) timer = Reflect_.apply(setT, g, [requestFrame, wait]);
    else requestFrame();
  }

  listeners.push(() => {
    // Throttling switched off while a batch waits on its timer: run it now.
    if (!(st.cfg.rafFps > 0) && timer) {
      Reflect_.apply(clearT, g, [timer]);
      requestFrame();
    }
  });

  const rafTrap = () => (target, thisArg, args) => {
    const cb = args[0];
    if ((!(st.cfg.rafFps > 0) && queue.size === 0) || typeof cb !== 'function') {
      return Reflect_.apply(target, thisArg, args);
    }
    nextId += 1;
    const id = OFFSET + nextId;
    queue.set(id, cb);
    pump();
    return id;
  };
  const cafTrap = () => (target, thisArg, args) => {
    const id = Number(args[0]);
    if (id > OFFSET && queue.delete(id)) return undefined;
    return Reflect_.apply(target, thisArg, args);
  };
  wrap(g, 'requestAnimationFrame', rafTrap);
  wrap(g, 'cancelAnimationFrame', cafTrap);
  if (typeof g.webkitRequestAnimationFrame === 'function') wrap(g, 'webkitRequestAnimationFrame', rafTrap);
  if (typeof g.webkitCancelAnimationFrame === 'function') wrap(g, 'webkitCancelAnimationFrame', cafTrap);
}

module.exports = { applyMediaShim };
