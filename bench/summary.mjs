#!/usr/bin/env node
// Medians per label from bench/results/youtube.local.jsonl.
//   node bench/summary.mjs [--since 2026-11-21T00:00] [--markdown]
// Runs that did not play are left out (and counted).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const since = argv.includes('--since') ? argv[argv.indexOf('--since') + 1] : '';
const md = argv.includes('--markdown');
const rows = fs.readFileSync(path.join(here, 'results', 'youtube.local.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((r) => !since || r.at >= since);

const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return NaN; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const groups = new Map();
for (const r of rows) {
  if (!groups.has(r.label)) groups.set(r.label, { ok: [], bad: 0 });
  const p = r.playback;
  if (p && p.playing && p.framesDuring > 0) groups.get(r.label).ok.push(r); else groups.get(r.label).bad += 1;
}
const cols = [
  ['runs', (rs) => rs.length],
  ['GPU W', (rs) => median(rs.map((r) => r.watts.uncore)).toFixed(2)],
  ['CPU cores', (rs) => median(rs.map((r) => r.cpu_cores_busy)).toFixed(3)],
  ['render %', (rs) => median(rs.map((r) => r.gpu_busy_pct.render)).toFixed(1)],
  ['video %', (rs) => median(rs.map((r) => r.gpu_busy_pct.video)).toFixed(1)],
  ['Hyprland %', (rs) => median(rs.map((r) => r.compositor_gpu_busy_pct.render)).toFixed(1)],
  ['RC6 %', (rs) => median(rs.map((r) => r.gpu_rc6_pct)).toFixed(0)],
  ['MHz', (rs) => median(rs.map((r) => r.gpu_freq_mhz_avg)).toFixed(0)],
  ['PSS MiB', (rs) => median(rs.map((r) => r.pss_mib_end)).toFixed(0)],
  ['stream', (rs) => [...new Set(rs.map((r) => `${r.playback.fmt} ${r.playback.res}@${Math.round(r.playback.framesDuring / r.seconds)}`))].join(', ')],
  ['dropped', (rs) => rs.map((r) => r.playback.droppedDuring).join('/')],
];
const lines = [];
const head = ['label', ...cols.map((c) => c[0]), 'failed'];
if (md) { lines.push(`| ${head.join(' | ')} |`); lines.push(`|${head.map(() => '---').join('|')}|`); }
else lines.push(head.join('\t'));
for (const [label, g] of [...groups].sort()) {
  if (!g.ok.length) { lines.push(md ? `| ${label} | 0 |${cols.slice(1).map(() => ' ').join('|')}| ${g.bad} |` : `${label}\t0 runs played (${g.bad} failed)`); continue; }
  const cells = [label, ...cols.map((c) => c[1](g.ok)), g.bad];
  lines.push(md ? `| ${cells.join(' | ')} |` : cells.join('\t'));
}
console.log(lines.join('\n'));
