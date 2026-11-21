'use strict';
// docs/ARCHITECTURE.md's "Rules for all code", where a test can hold them:
// - The main process thread stays light: every web request passes through it
//   (ad blocking), so a blocking call (fs.*Sync, execFileSync, dialogs) needs
//   a written reason, a `sync-ok: <reason>` comment on its line or the line
//   above it.
// - Pure logic does not require('electron') at the top of the module, so
//   plain Node can test it; only the modules that build windows do.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = path.join(__dirname, '..', 'src', 'main');
const ELECTRON_AT_TOP = new Set(['main.js', 'tab.js', 'window.js']);

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

test('every blocking call in the main process says why it may block', () => {
  const unexplained = [];
  for (const file of sources(MAIN)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // String literals out first, so 'file://' + fs.fooSync() is still code.
      const code = line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''").replace(/\/\/.*$/, '');
      if (!/\b\w+Sync\s*\(/.test(code)) return;
      if (/^\s*(async\s+)?\w+Sync\s*\([^)]*\)\s*\{/.test(code)) return; // a method named *Sync
      if (/sync-ok:\s*\S/.test(line) || /sync-ok:\s*\S/.test(lines[i - 1] || '')) return;
      unexplained.push(`${path.relative(MAIN, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(unexplained, [], 'add a `// sync-ok: <reason>` comment, or make it async');
});

test('only the window-building modules load electron at the top', () => {
  const offenders = [];
  for (const file of sources(MAIN)) {
    const rel = path.relative(MAIN, file);
    if (ELECTRON_AT_TOP.has(rel)) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/^(const|let|var)\b.*require\(\s*['"]electron['"]\s*\)/.test(line)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], 'pass Electron objects in instead (see docs/ARCHITECTURE.md)');
});
