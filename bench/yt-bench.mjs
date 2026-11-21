#!/usr/bin/env node
// Plays the same YouTube video in Supernova or Chrome and measures it with
// measure.py: energy (RAPL), CPU, GPU engines, memory. Launches through
// Hyprland on workspace 9, drives the page over the DevTools protocol.
//
//   node bench/yt-bench.mjs --browser supernova|chrome [--seconds 30] [--warmup 8]
//        [--video aqz-KE-bpKQ] [--quality hd1080] [--battery] [--fullscreen] [--hidden]
//        [--max-height 720] [--translucent] [--extra='--switch=value ...'] [--label name] [--keep]
//
// --keep leaves the browser playing after the measurement (for probing it).
// --features A,B enables more Chromium features in Supernova (SUPERNOVA_EXTRA_FEATURES).
// --square gives YouTube's player square corners before measuring.
// --settings='{"key":value}' writes those Supernova settings before start.
// --battery runs Supernova as if unplugged (SUPERNOVA_FORCE_BATTERY=1).
// --hidden switches to an empty workspace while measuring (is a page that is
// not on screen still decoding and drawing?).
// --max-height sets Supernova's video cap (both power sources) before start.
// Supernova's window gets Nova's opaque rule (opacity 1 1) unless --translucent:
// Chrome already has one, and blending a translucent window costs Hyprland work
// on every video frame.

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
// --key value, --key=value (needed when the value starts with --), or --flag.
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (!a.startsWith('--')) return acc;
  const eq = a.indexOf('=');
  if (eq > 0) acc.push([a.slice(2, eq), a.slice(eq + 1)]);
  else acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const browser = args.browser || 'supernova';
const seconds = Number(args.seconds || 30);
const warmup = Number(args.warmup || 8);
const video = args.video || 'aqz-KE-bpKQ';
const url = `https://www.youtube.com/watch?v=${video}`;
const port = browser === 'chrome' ? 9334 : 9333;
const label = args.label || `${browser}${args.battery ? '-battery' : ''}${args.fullscreen ? '-fs' : ''}${args.hidden ? '-hidden' : ''}${args.quality ? '-' + args.quality : ''}${args['max-height'] ? '-cap' + args['max-height'] : ''}${args.translucent ? '-translucent' : ''}${args.features ? '-' + args.features : ''}${args.square ? '-square' : ''}${args.settings ? '-' + Object.entries(JSON.parse(args.settings)).map(([k, v]) => k.split('.').pop() + '=' + v).join(',') : ''}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hypr = (lua) => execFileSync('hyprctl', ['dispatch', lua], { encoding: 'utf8' });

function launch() {
  const profile = `/tmp/sn-bench-${browser}`;
  // A fresh profile every run, except Supernova's compiled filter lists: the
  // first-run download and compile would land in the measurement.
  const keep = path.join(`/tmp/sn-bench-cache-${browser}`);
  if (browser === 'supernova' && fs.existsSync(path.join(profile, 'adblock'))) {
    fs.rmSync(keep, { recursive: true, force: true });
    fs.cpSync(path.join(profile, 'adblock'), keep, { recursive: true });
  }
  fs.rmSync(profile, { recursive: true, force: true });
  if (browser === 'supernova') {
    fs.mkdirSync(profile, { recursive: true });
    if (fs.existsSync(keep)) fs.cpSync(keep, path.join(profile, 'adblock'), { recursive: true });
    const settings = args.settings ? JSON.parse(args.settings) : {};
    if (args['max-height']) {
      const h = Number(args['max-height']);
      Object.assign(settings, { 'video.maxHeightOnAC': h, 'video.maxHeightOnBattery': h });
    }
    if (Object.keys(settings).length) fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings));
    if (!args.translucent) {
      execFileSync('hyprctl', ['eval', 'hl.window_rule({ match = { class = "supernova" }, tag = "-default-opacity", opacity = "1 1" })']);
    }
  }
  const script = `/tmp/sn-bench-launch-${browser}.sh`;
  const cmd = browser === 'chrome'
    ? `exec /opt/google/chrome/chrome --user-data-dir=${profile} --no-first-run --no-default-browser-check --password-store=basic ` +
      `$(grep -v '^#' "$HOME/.config/chrome-flags.conf" | tr '\\n' ' ') --remote-debugging-port=${port} ${args.extra || ''} '${url}'`
    : `export SUPERNOVA_PROFILE=${profile}${args.battery ? ' SUPERNOVA_FORCE_BATTERY=1' : ' SUPERNOVA_FORCE_BATTERY=0'}${args.features ? ` SUPERNOVA_EXTRA_FEATURES=${args.features}` : ''}; unset ELECTRON_RUN_AS_NODE; ` +
      `exec ${root}/.electron/electron ${root} --remote-debugging-port=${port} ${args.extra || ''} '${url}'`;
  fs.writeFileSync(script, `#!/bin/bash\n${cmd} > /tmp/sn-bench-${browser}.log 2>&1\n`, { mode: 0o755 });
  hypr('hl.dsp.focus({ workspace = "9" })');
  hypr(`hl.dsp.exec_cmd("${script}")`);
}

function mainPid() {
  const out = execSync(`pgrep -af -- '--remote-debugging-port=${port}' || true`, { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l && !l.includes('--type=') && !l.includes('pgrep') && !l.includes('/bin/bash'));
  return line ? Number(line.split(' ')[0]) : null;
}

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes('youtube.com/watch'));
      if (t) return t;
    } catch {}
    await sleep(500);
  }
  throw new Error('no YouTube page');
}

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const evaluate = (expression) => new Promise((res) => {
    const my = ++id;
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== my) return;
      ws.removeEventListener('message', h);
      res(m.result && m.result.result ? m.result.result.value : undefined);
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
  });
  return { ws, evaluate };
}

const STATS = `(() => { const v = document.querySelector('video'); const p = document.getElementById('movie_player');
  if (!v || !p || !p.getVideoStats) return null; const q = v.getVideoPlaybackQuality(); const s = p.getVideoStats();
  return { t: v.currentTime, paused: v.paused, res: v.videoWidth + 'x' + v.videoHeight, fmt: s.fmt, quality: p.getPlaybackQuality(),
    dropped: q.droppedVideoFrames, frames: q.totalVideoFrames, ad: !!document.querySelector('.ad-showing'),
    player: Math.round(p.getBoundingClientRect().width * devicePixelRatio) + 'x' + Math.round(p.getBoundingClientRect().height * devicePixelRatio) }; })()`;

async function main() {
  launch();
  const t = await target();
  const pid = mainPid();
  if (!pid) throw new Error('no browser pid');
  const { ws, evaluate } = await connect(t);
  // EU consent dialog.
  for (let i = 0; i < 20; i++) {
    const r = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => /Reject all|Rifiuta tutto/i.test(b.innerText)); if (b) { b.click(); return 'clicked'; } return document.querySelector('video') ? 'video' : 'wait'; })()`);
    if (r === 'clicked') { await sleep(2500); break; }
    if (r === 'video' && i > 6) break;
    await sleep(500);
  }
  // Play; wait out ads (clicking Skip when offered). The consent dialog can
  // also come late, as an in-page lightbox that pauses the video: reject it
  // whenever it shows up.
  for (let i = 0; i < 120; i++) {
    const s = await evaluate(`(async () => {
      const reject = [...document.querySelectorAll('button')].find((b) => /^(Reject all|Rifiuta tutto)$/i.test(b.innerText.trim()) && b.offsetParent);
      if (reject) { reject.click(); await new Promise((r) => setTimeout(r, 1500)); }
      const v = document.querySelector('video'); if (!v) return null; if (v.paused) { try { await v.play(); } catch {} }
      const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern'); if (skip) skip.click();
      return ${STATS}; })()`);
    if (s && !s.ad && s.t > 2 && !s.paused && i > 3) break;
    await sleep(1000);
  }
  if (args.quality) await evaluate(`document.getElementById('movie_player').setPlaybackQualityRange('${args.quality}')`);
  // Both browsers go fullscreen the same way, as YouTube's own button does.
  if (args.fullscreen) await evaluate(`document.getElementById('movie_player').requestFullscreen().then(() => 'ok', (e) => e.message)`);
  if (args.square) await evaluate(`(() => { const s = document.createElement('style'); s.textContent = 'ytd-player#ytd-player { border-radius: 0 !important; }'; document.documentElement.appendChild(s); })()`);
  // The cursor goes to the screen's corner, so YouTube hides its controls and
  // nothing hovers over the video while measuring.
  hypr('hl.dsp.cursor.move({ x = 99999, y = 99999 })');
  await sleep(warmup * 1000);
  if (args.hidden) hypr('hl.dsp.focus({ workspace = "8" })');
  const before = await evaluate(STATS);
  const measured = JSON.parse(execFileSync('python3', [path.join(here, 'measure.py'), '--root', String(pid), '--seconds', String(seconds), '--label', label], { encoding: 'utf8' }));
  const after = await evaluate(STATS);
  if (args.hidden) hypr('hl.dsp.focus({ workspace = "9" })');
  ws.close();
  if (!args.keep) try { process.kill(pid, 'SIGTERM'); } catch {}
  const result = {
    ...measured,
    browser, video, battery: !!args.battery, fullscreen: !!args.fullscreen, hidden: !!args.hidden,
    playback: after && before ? {
      fmt: after.fmt, res: after.res, quality: after.quality, player: after.player,
      framesDuring: after.frames - before.frames, droppedDuring: after.dropped - before.dropped, adDuring: after.ad || before.ad,
      playing: !after.paused && after.t > before.t,
    } : null,
    at: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(here, 'results'), { recursive: true });
  fs.appendFileSync(path.join(here, 'results', 'youtube.local.jsonl'), JSON.stringify(result) + '\n');
  const w = result.watts;
  const p = result.playback || {};
  console.log(`${label.padEnd(26)} pkg ${w['package-0']} W  gpu ${w.uncore} W  cpu ${result.cpu_cores_busy}  ` +
    `render ${result.gpu_busy_pct.render}%  video ${result.gpu_busy_pct.video}%  hyprland ${result.compositor_gpu_busy_pct.render}%  ` +
    `rc6 ${result.gpu_rc6_pct}%  ${result.gpu_freq_mhz_avg} MHz  pss ${result.pss_mib_end} MiB  | ${p.fmt} ${p.res} ${p.quality} ` +
    `player ${p.player} frames ${p.framesDuring} dropped ${p.droppedDuring}${p.adDuring ? ' AD' : ''}${p.playing ? '' : ' NOT PLAYING'}`);
  await sleep(1500);
}

main().catch((err) => { console.error(err); process.exit(1); });
