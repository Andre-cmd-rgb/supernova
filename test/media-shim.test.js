'use strict';
// The media shim runs serialized in the page's main world. Here it runs the
// same way, from its source text, in a bare vm context with a fake browser:
// that also proves it uses nothing from outside the function.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { applyMediaShim } = require('../src/preload/media-shim');

const VSYNC = 1000 / 60;

function fakePage({ nativeSupports = () => true } = {}) {
  const clock = { now: 0 };
  let timers = [];
  let timerId = 0;
  let rafs = [];
  let rafId = 0;
  const reported = [];
  const stats = { nativeRafCalls: 0, decodingCalls: 0 };

  class MediaCapabilities {
    decodingInfo(c) {
      stats.decodingCalls += 1;
      return Promise.resolve({ supported: true, smooth: true, powerEfficient: true, keySystemAccess: null, configuration: c });
    }
  }
  const sandbox = {
    MediaSource: { isTypeSupported: function isTypeSupported(t) { return nativeSupports(String(t)); } },
    MediaCapabilities,
    navigator: { mediaCapabilities: new MediaCapabilities() },
    performance: { now: () => clock.now },
    setTimeout: (fn, ms) => { timerId += 1; timers.push({ id: timerId, fn, at: clock.now + Math.max(0, ms || 0) }); return timerId; },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
    requestAnimationFrame: function requestAnimationFrame(cb) {
      if (typeof cb !== 'function') throw new TypeError('not a function');
      stats.nativeRafCalls += 1; rafId += 1; rafs.push({ id: rafId, cb }); return rafId;
    },
    cancelAnimationFrame: function cancelAnimationFrame(id) { rafs = rafs.filter((r) => r.id !== id); },
    reportError: (err) => reported.push(err),
    Promise,
  };
  vm.createContext(sandbox);

  const page = {
    sandbox,
    reported,
    stats,
    apply(cfg) { vm.runInContext(`(${applyMediaShim.toString()})(${JSON.stringify(cfg)})`, sandbox); },
    run(code) { return vm.runInContext(code, sandbox); },
    // Advance time vsync by vsync: due timers fire, then the frame's callbacks.
    advance(ms) {
      const end = clock.now + ms;
      let nextVsync = Math.floor(clock.now / VSYNC + 1e-9) * VSYNC + VSYNC;
      while (nextVsync <= end + 1e-9) {
        for (;;) {
          const due = timers.filter((t) => t.at <= nextVsync).sort((a, b) => a.at - b.at)[0];
          if (!due) break;
          timers = timers.filter((t) => t !== due);
          clock.now = Math.max(clock.now, due.at);
          due.fn();
        }
        clock.now = nextVsync;
        const batch = rafs;
        rafs = [];
        for (const r of batch) r.cb(nextVsync);
        nextVsync += VSYNC;
      }
      clock.now = end;
    },
  };
  return page;
}

const VP9 = (w, h, fps) => `video/webm; codecs="vp9"; width=${w}; height=${h}; framerate=${fps}`;

test('height cap hides the bigger video formats and nothing else', () => {
  const p = fakePage();
  p.apply({ maxHeight: 1080, maxFps: 0, rafFps: 0 });
  const ok = (t) => p.run(`MediaSource.isTypeSupported(${JSON.stringify(t)})`);
  assert.equal(ok(VP9(3840, 2160, 30)), false);
  assert.equal(ok(VP9(2560, 1440, 60)), false);
  assert.equal(ok(VP9(1920, 1080, 60)), true);
  assert.equal(ok(VP9(1080, 1920, 30)), true, 'portrait 1080p is a 1080p stream');
  assert.equal(ok('video/mp4; codecs="av01.0.08M.08"; height=2160'), false, 'height alone');
  assert.equal(ok('video/mp4; codecs="av01.0.08M.08"; width=3840'), false, 'width alone');
  assert.equal(ok('video/mp4; codecs="avc1.4d401f"'), true, 'no size: the site decides');
  assert.equal(ok('audio/webm; codecs="opus"; height=4320'), true, 'audio is never touched');
});

test('the browser still has the last word', () => {
  const p = fakePage({ nativeSupports: (t) => !t.includes('hev1') });
  p.apply({ maxHeight: 1080, maxFps: 0, rafFps: 0 });
  assert.equal(p.run(`MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"; width=1280; height=720')`), false);
});

test('frame-rate cap keeps 30 fps streams and every low tier', () => {
  const p = fakePage();
  p.apply({ maxHeight: 0, maxFps: 30, rafFps: 0 });
  const ok = (t) => p.run(`MediaSource.isTypeSupported(${JSON.stringify(t)})`);
  assert.equal(ok(VP9(1280, 720, 60)), false);
  assert.equal(ok(VP9(1920, 1080, 50)), false);
  assert.equal(ok(VP9(1920, 1080, 30)), true);
  assert.equal(ok('video/webm; codecs="vp9"; width=1920; height=1080; framerate=30000/1001'), true);
  assert.equal(ok(VP9(854, 480, 60)), true, '480p60 stays: a 60 fps video has nothing at 30 fps above 480p');
});

test('a cap below 480p never hides the 480p tier', () => {
  const p = fakePage();
  p.apply({ maxHeight: 360, maxFps: 24, rafFps: 0 });
  assert.equal(p.run(`MediaSource.isTypeSupported(${JSON.stringify(VP9(854, 480, 60))})`), true);
  assert.equal(p.run(`MediaSource.isTypeSupported(${JSON.stringify(VP9(640, 360, 60))})`), true);
});

test('decodingInfo answers "not supported" above the cap and asks the browser otherwise', async () => {
  const p = fakePage();
  p.apply({ maxHeight: 1080, maxFps: 30, rafFps: 0 });
  const big = await p.run(`navigator.mediaCapabilities.decodingInfo({ type: 'media-source', video: { contentType: 'video/webm; codecs="vp9"', width: 3840, height: 2160, framerate: 30, bitrate: 1e7 } })`);
  assert.equal(big.supported, false);
  assert.equal(big.powerEfficient, false);
  assert.equal(p.stats.decodingCalls, 0);
  const fast = await p.run(`navigator.mediaCapabilities.decodingInfo({ type: 'media-source', video: { contentType: 'video/webm; codecs="vp9"', width: 1920, height: 1080, framerate: '60', bitrate: 1e7 } })`);
  assert.equal(fast.supported, false, '60 fps above 480p is over a 30 fps cap');
  const fine = await p.run(`navigator.mediaCapabilities.decodingInfo({ type: 'media-source', video: { contentType: 'video/webm; codecs="vp9"', width: 1920, height: 1080, framerate: 30, bitrate: 1e7 } })`);
  assert.equal(fine.supported, true);
  const audio = await p.run(`navigator.mediaCapabilities.decodingInfo({ type: 'media-source', audio: { contentType: 'audio/webm; codecs="opus"' } })`);
  assert.equal(audio.supported, true);
  assert.equal(p.stats.decodingCalls, 2);
});

test('wrappers look like the originals', () => {
  const p = fakePage();
  p.apply({ maxHeight: 720, maxFps: 0, rafFps: 30 });
  assert.equal(p.run('MediaSource.isTypeSupported.name'), 'isTypeSupported');
  assert.equal(p.run('requestAnimationFrame.name'), 'requestAnimationFrame');
  assert.equal(p.run('requestAnimationFrame.length'), 1);
  assert.equal(p.run('typeof requestAnimationFrame(() => {})'), 'number');
  assert.equal(p.run('Object.keys(globalThis).some((k) => /supernova/i.test(k))'), false);
});

test('rafFps 30 runs an animation loop at 30 frames a second, on real frame times', () => {
  const p = fakePage();
  p.apply({ maxHeight: 0, maxFps: 0, rafFps: 30 });
  p.run('globalThis.times = []; (function loop(ts) { times.push(ts); requestAnimationFrame(loop); })(0)');
  p.advance(1000);
  const times = p.run('times').slice(1);
  assert.ok(times.length >= 28 && times.length <= 31, `${times.length} frames in a second`);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1], 'monotonic');
    assert.ok(Math.abs(times[i] / VSYNC - Math.round(times[i] / VSYNC)) < 1e-6, 'on a vsync');
  }
  assert.ok(p.stats.nativeRafCalls <= 32, `asked the browser for ${p.stats.nativeRafCalls} frames, not 60`);
});

test('cancelAnimationFrame cancels, errors are reported and the rest of the batch runs', () => {
  const p = fakePage();
  p.apply({ maxHeight: 0, maxFps: 0, rafFps: 30 });
  p.run(`globalThis.ran = [];
    const a = requestAnimationFrame(() => ran.push('a'));
    requestAnimationFrame(() => { throw new Error('boom'); });
    requestAnimationFrame(() => ran.push('c'));
    cancelAnimationFrame(a);`);
  p.advance(100);
  assert.equal(p.run('ran.join()'), 'c');
  assert.equal(p.reported.length, 1);
  assert.equal(p.reported[0].message, 'boom');
});

test('rafFps 0 is the browser itself; switching live keeps pending callbacks', () => {
  const p = fakePage();
  p.apply({ maxHeight: 0, maxFps: 0, rafFps: 0 });
  p.run('globalThis.n = 0; (function loop() { n++; requestAnimationFrame(loop); })()');
  p.advance(1000);
  const unthrottled = p.run('n');
  assert.ok(unthrottled >= 59 && unthrottled <= 62, `${unthrottled} frames unthrottled`);
  const nativeId = p.run('requestAnimationFrame(() => {})');
  assert.ok(nativeId < 0x40000000, 'native ids pass through');

  p.apply({ maxHeight: 0, maxFps: 0, rafFps: 30 });
  p.run('n = 0');
  p.advance(1000);
  assert.ok(p.run('n') <= 32, `${p.run('n')} frames after switching on`);

  p.apply({ maxHeight: 0, maxFps: 0, rafFps: 0 });
  p.run('n = 0');
  p.advance(1000);
  assert.ok(p.run('n') >= 58, `${p.run('n')} frames after switching off`);
});

test('calling it again updates the caps without wrapping twice', () => {
  const p = fakePage();
  p.apply({ maxHeight: 720, maxFps: 0, rafFps: 0 });
  const first = p.run('MediaSource.isTypeSupported');
  assert.equal(p.run(`MediaSource.isTypeSupported(${JSON.stringify(VP9(1920, 1080, 30))})`), false);
  p.apply({ maxHeight: 0, maxFps: 0, rafFps: 0 });
  assert.equal(p.run('MediaSource.isTypeSupported'), first);
  assert.equal(p.run(`MediaSource.isTypeSupported(${JSON.stringify(VP9(3840, 2160, 60))})`), true);
});

test('a callback can cancel a later one of the same frame', () => {
  const p = fakePage();
  p.apply({ maxHeight: 0, maxFps: 0, rafFps: 30 });
  p.run(`globalThis.ran = [];
    let b = 0;
    requestAnimationFrame(() => { ran.push('a'); cancelAnimationFrame(b); });
    b = requestAnimationFrame(() => ran.push('b'));
    requestAnimationFrame(() => ran.push('c'));`);
  p.advance(100);
  assert.equal(p.run('ran.join()'), 'a,c');
});
