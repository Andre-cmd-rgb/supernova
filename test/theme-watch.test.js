'use strict';
// Nova changes theme by pointing ~/.local/state/nova/current/theme at another
// rendered folder; the adaptive theme may also rewrite colors.toml in place.
// Supernova must follow both while it runs. Uses a throwaway XDG_STATE_HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function nova(root) {
  const state = path.join(root, 'state');
  const rendered = (name, bg, fg) => {
    const d = path.join(state, 'nova', 'rendered', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'colors.toml'), `# ${name}\nbackground = "${bg}"\nforeground = "${fg}"\naccent = "#c4a7e7"\n`);
    return d;
  };
  const current = path.join(state, 'nova', 'current');
  fs.mkdirSync(current, { recursive: true });
  return { state, current, rendered };
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
};

test('follows a theme switch (symlink swapped) and an in-place rewrite', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-theme-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const n = nova(root);
  const dawn = n.rendered('rose-pine-dawn', '#faf4ed', '#575279');
  const night = n.rendered('tokyo-night', '#1a1b26', '#c0caf5');
  fs.symlinkSync(dawn, path.join(n.current, 'theme'));

  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = n.state;
  t.after(() => { if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved; });
  delete require.cache[require.resolve('../src/main/theme')];
  const { ThemeWatcher } = require('../src/main/theme');

  const w = new ThemeWatcher({ prefersDark: () => false });
  t.after(() => w.close());
  assert.equal(w.current.background, '#faf4ed');
  assert.equal(w.current.mode, 'light');
  const seen = [];
  w.on('change', (th) => seen.push(th));

  // nova theme set: a new link is renamed over the old one.
  const tmpLink = path.join(n.current, '.theme.new');
  fs.symlinkSync(night, tmpLink);
  fs.renameSync(tmpLink, path.join(n.current, 'theme'));
  assert.ok(await until(() => seen.length >= 1), 'saw the switch');
  assert.equal(w.current.background, '#1a1b26');
  assert.equal(w.current.mode, 'dark');

  // The new folder is watched too: an in-place rewrite of its colors.toml.
  fs.writeFileSync(path.join(night, 'colors.toml'), 'background = "#16161e"\nforeground = "#c0caf5"\naccent = "#7aa2f7"\n');
  assert.ok(await until(() => seen.length >= 2), 'saw the rewrite in the new folder');
  assert.equal(w.current.accent, '#7aa2f7');
});
