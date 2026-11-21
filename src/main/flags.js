'use strict';
// Chromium switches, set before the app is ready. Every one is here for a
// measured reason (bench/README.md) or a correctness one; nothing speculative.

const fs = require('fs');

// The Intel iGPU's render node, so the browser never wakes a discrete NVIDIA
// card (which costs ~6 W on the P1 Gen 4i just by being awake).
function integratedRenderNode() {
  try {
    for (const name of fs.readdirSync('/sys/class/drm')) { // sync-ok: before the app is ready
      if (!/^renderD\d+$/.test(name)) continue;
      const vendor = fs.readFileSync(`/sys/class/drm/${name}/device/vendor`, 'utf8').trim(); // sync-ok: as above
      // Intel (0x8086) first: on a hybrid laptop that is the integrated GPU.
      if (vendor === '0x8086') return `/dev/dri/${name}`;
    }
    // Otherwise any GPU that is not NVIDIA's (an AMD APU, say).
    for (const name of fs.readdirSync('/sys/class/drm')) { // sync-ok: before the app is ready
      if (!/^renderD\d+$/.test(name)) continue;
      const vendor = fs.readFileSync(`/sys/class/drm/${name}/device/vendor`, 'utf8').trim(); // sync-ok: as above
      if (vendor !== '0x10de') return `/dev/dri/${name}`;
    }
  } catch {}
  return null;
}

function applySwitches(app, { privateOnly = false } = {}) {
  const cl = app.commandLine;
  const add = (name, value) => (value === undefined ? cl.appendSwitch(name) : cl.appendSwitch(name, value));

  // Wayland itself, not Xwayland (falls back to X11 when there is no Wayland).
  if (process.env.WAYLAND_DISPLAY && !cl.hasSwitch('ozone-platform')) add('ozone-platform', 'wayland');
  else if (!cl.hasSwitch('ozone-platform')) add('ozone-platform-hint', 'auto');

  // Video decoded in silicon (VA-API) and kept on the GPU (zero copy), as in
  // Chrome with Nova's flags: measured 0.28 W GPU power for 1080p30 AV1.
  // Screen sharing on Wayland goes through PipeWire and the desktop portal.
  const features = [
    'AcceleratedVideoDecodeLinuxGL',
    'AcceleratedVideoDecodeLinuxZeroCopyGL',
    'AcceleratedVideoEncoder',
    'WebRTCPipeWireCapturer',
    // Hidden or backgrounded media stops decoding its video track; audio plays on.
    'BackgroundVideoTrackOptimization',
  ];
  // Experiments (bench/yt-bench.mjs --features): more features without
  // replacing this list, which a second --enable-features would do.
  for (const f of (process.env.SUPERNOVA_EXTRA_FEATURES || '').split(',')) if (/^\w+$/.test(f)) features.push(f);
  add('enable-features', features.join(','));

  const node = process.env.SUPERNOVA_RENDER_NODE || integratedRenderNode();
  if (node) add('render-node-override', node);

  // The login keyring holds the key for saved passwords; under Hyprland
  // Chromium cannot tell it is there and would fall back to a fixed key.
  if (!cl.hasSwitch('password-store')) add('password-store', 'gnome-libsecret');

  // No crash reports, no metrics, no Chrome "field trials" phoning home.
  add('disable-breakpad');
  add('metrics-recording-only');
  add('no-pings');
  add('disable-domain-reliability');
  add('disable-component-extensions-with-background-pages');

  if (privateOnly) add('incognito');
}

module.exports = { applySwitches, integratedRenderNode };
