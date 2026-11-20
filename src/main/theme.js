'use strict';
// The browser's colours: Nova's current theme when there is one (it changes
// live when the theme does), else a light or dark palette of its own.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const LIGHT = {
  mode: 'light',
  background: '#ffffff', dark_background: '#f3f3f3', lighter_background: '#ebebeb', selection: '#d6d6d6',
  foreground: '#121212', light_foreground: '#4d4d4d', dark_foreground: '#a3a3a3', muted: '#8c8c8c',
  accent: '#575757', red: '#b3261e', green: '#2e7d32', yellow: '#b26a00', blue: '#1f5fbf',
};
const DARK = {
  mode: 'dark',
  background: '#161616', dark_background: '#1d1d1d', lighter_background: '#262626', selection: '#3a3a3a',
  foreground: '#e8e8e8', light_foreground: '#bdbdbd', dark_foreground: '#6b6b6b', muted: '#8c8c8c',
  accent: '#a8a8a8', red: '#f2b8b5', green: '#a5d6a7', yellow: '#ffcc80', blue: '#9ecaff',
};
const KEYS = Object.keys(LIGHT);

function novaDir() {
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'nova', 'current');
}

/** Minimal reader for Nova's colors.toml: `key = "value"` lines, comments ignored. */
function parseColorsToml(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const m = /^([a-z_]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const HEX = /^#[0-9a-f]{6}$/i;

function normalize(raw, fallbackDark) {
  const mode = raw.mode === 'dark' || raw.mode === 'light' ? raw.mode : (fallbackDark ? 'dark' : 'light');
  const base = mode === 'dark' ? DARK : LIGHT;
  const out = { mode, source: raw.source || 'built-in' };
  for (const k of KEYS) {
    if (k === 'mode') continue;
    out[k] = typeof raw[k] === 'string' && HEX.test(raw[k]) ? raw[k].toLowerCase() : base[k];
  }
  return out;
}

function readTheme({ prefersDark = false, dir = novaDir() } = {}) {
  const env = process.env.SUPERNOVA_THEME;
  const candidates = [
    env && { file: env, kind: env.endsWith('.toml') ? 'toml' : 'json' },
    { file: path.join(dir, 'theme', 'supernova.json'), kind: 'json' },
    { file: path.join(dir, 'theme', 'colors.toml'), kind: 'toml' },
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const text = fs.readFileSync(c.file, 'utf8');
      const raw = c.kind === 'json' ? JSON.parse(text) : parseColorsToml(text);
      raw.source = c.file;
      return normalize(raw, prefersDark);
    } catch {}
  }
  return normalize({}, prefersDark);
}

/**
 * Watches Nova's theme. Emits 'change' with the new palette. The watch is on
 * the directory holding the `theme` symlink, which Nova replaces on a switch.
 */
class ThemeWatcher extends EventEmitter {
  constructor({ prefersDark = () => false } = {}) {
    super();
    this.prefersDark = prefersDark;
    this.current = readTheme({ prefersDark: prefersDark() });
    this._timer = null;
    this._watchers = [];
    const dir = novaDir();
    for (const target of [dir, path.join(dir, 'theme')]) {
      try {
        const w = fs.watch(target, { persistent: false }, () => this._recheck());
        w.on('error', () => {});
        this._watchers.push(w);
      } catch {}
    }
  }

  _recheck() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refresh(), 150);
  }

  refresh() {
    const next = readTheme({ prefersDark: this.prefersDark() });
    if (JSON.stringify(next) !== JSON.stringify(this.current)) {
      this.current = next;
      // The theme directory itself may have been replaced: re-arm its watch.
      for (const w of this._watchers.splice(1)) try { w.close(); } catch {}
      try {
        const w = fs.watch(path.join(novaDir(), 'theme'), { persistent: false }, () => this._recheck());
        w.on('error', () => {});
        this._watchers.push(w);
      } catch {}
      this.emit('change', next);
    }
  }

  close() {
    for (const w of this._watchers) try { w.close(); } catch {}
  }
}

module.exports = { readTheme, parseColorsToml, ThemeWatcher, LIGHT, DARK };
