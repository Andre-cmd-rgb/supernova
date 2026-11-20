'use strict';
// Autofill: main side with fakes (plain Node), page side in a headless
// Electron (skipped when .electron/electron is missing or cannot start).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { registerAutofillIpc } = require('../src/main/autofill-ipc');

// ---------- main side ----------

function fakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers, listeners,
    handle(ch, fn) { handlers.set(ch, fn); },
    removeHandler(ch) { handlers.delete(ch); },
    on(ch, fn) { listeners.set(ch, fn); },
    removeListener(ch, fn) { if (listeners.get(ch) === fn) listeners.delete(ch); },
  };
}

function fakeSettings(init = {}) {
  const m = new Map(Object.entries({ 'passwords.offerToSave': true, 'passwords.never': [], ...init }));
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
}

function fakeVault(entries = []) {
  const list = entries.map((e, i) => ({ id: String(i + 1), ...e }));
  return {
    list,
    available: () => ({ ok: true }),
    find(origin) {
      const twin = origin.startsWith('https://') ? 'http://' + origin.slice(8) : null;
      return list.filter((e) => e.origin === origin).concat(list.filter((e) => e.origin === twin)).map((e) => ({ ...e }));
    },
    save({ origin, username, password }) {
      const e = list.find((x) => x.origin === origin && x.username === username);
      if (e) { e.password = password; return { id: e.id, status: 'updated' }; }
      list.push({ id: String(list.length + 1), origin, username, password });
      return { id: String(list.length), status: 'added' };
    },
  };
}

function fakeEvent(origin, { persistent = true, id = 7 } = {}) {
  return {
    sender: { id, session: { isPersistent: () => persistent }, once() {} },
    senderFrame: origin === null ? null : { origin },
  };
}

function setup({ entries = [], settings = {}, choice = 'save' } = {}) {
  const ipcMain = fakeIpcMain();
  const vault = fakeVault(entries);
  const prompts = [];
  const st = fakeSettings(settings);
  const reg = registerAutofillIpc({
    ipcMain, vault, settings: st,
    promptSave: async ({ webContents, origin, username, isUpdate }) => {
      prompts.push({ wc: webContents.id, origin, username, isUpdate });
      return choice;
    },
  });
  const query = (ev, payload = {}) => ipcMain.handlers.get('sn:pw:query')(ev, payload);
  const submit = async (ev, payload) => { ipcMain.listeners.get('sn:pw:submitted')(ev, payload); await new Promise(setImmediate); };
  const username = (ev, payload) => ipcMain.listeners.get('sn:pw:username')(ev, payload);
  return { ipcMain, vault, prompts, settings: st, reg, query, submit, username };
}

const GH = { origin: 'https://github.com', username: 'octo', password: 'gh-pass' };

test('query answers for the sender frame origin, never the payload', () => {
  const s = setup({ entries: [GH, { origin: 'https://bank.example', username: 'me', password: 'bank-pass' }] });
  const r = s.query(fakeEvent('https://github.com'), { origin: 'https://bank.example' });
  assert.deepEqual(r.map((e) => [e.origin, e.username]), [['https://github.com', 'octo']]);
  assert.deepEqual(s.query(fakeEvent(null), { origin: 'https://github.com' }), [], 'navigated frame');
  assert.deepEqual(s.query(fakeEvent('null')), [], 'opaque origin');
  assert.deepEqual(s.query(fakeEvent('file://')), []);
});

test('query includes the http version of an https origin', () => {
  const s = setup({ entries: [{ origin: 'http://old.example', username: 'u', password: 'p' }] });
  assert.equal(s.query(fakeEvent('https://old.example')).length, 1);
  assert.equal(s.query(fakeEvent('http://old.example')).length, 1);
});

test('submitted: new login prompts and saves under the frame origin', async () => {
  const s = setup({ entries: [GH] });
  await s.submit(fakeEvent('https://new.example'), { origin: 'https://github.com', username: 'me', password: 'new-pass' });
  assert.deepEqual(s.prompts, [{ wc: 7, origin: 'https://new.example', username: 'me', isUpdate: false }]);
  const saved = s.vault.list.find((e) => e.origin === 'https://new.example');
  assert.ok(saved && saved.username === 'me' && saved.password === 'new-pass');
  assert.ok(s.vault.find('https://github.com')[0].password === 'gh-pass', 'payload origin ignored');
});

test('submitted: changed password is an update; same password is skipped', async () => {
  const s = setup({ entries: [GH] });
  await s.submit(fakeEvent('https://github.com'), { username: 'octo', password: 'gh-pass' });
  await s.submit(fakeEvent('https://github.com'), { username: '', password: 'gh-pass' });
  assert.equal(s.prompts.length, 0);
  await s.submit(fakeEvent('https://github.com'), { username: 'octo', password: 'gh-pass-2' });
  assert.deepEqual(s.prompts.map((p) => p.isUpdate), [true]);
  assert.ok(s.vault.find('https://github.com')[0].password === 'gh-pass-2');
});

test('submitted: private sessions, never-list, offerToSave=false, navigated frames are skipped', async () => {
  const s = setup({ settings: { 'passwords.never': ['https://never.example'] } });
  await s.submit(fakeEvent('https://a.example', { persistent: false }), { username: 'u', password: 'p' });
  await s.submit(fakeEvent('https://never.example'), { username: 'u', password: 'p' });
  await s.submit(fakeEvent(null), { username: 'u', password: 'p' });
  await s.submit(fakeEvent('https://a.example'), { username: 'u', password: '' });
  await s.submit(fakeEvent('https://a.example'), null);
  assert.equal(s.prompts.length, 0);
  const off = setup({ settings: { 'passwords.offerToSave': false } });
  await off.submit(fakeEvent('https://a.example'), { username: 'u', password: 'p' });
  assert.equal(off.prompts.length, 0);
});

test("submitted: 'never' adds the origin to passwords.never, 'dismiss' does nothing", async () => {
  const s = setup({ choice: 'never' });
  await s.submit(fakeEvent('https://a.example'), { username: 'u', password: 'p' });
  assert.deepEqual(s.settings.get('passwords.never'), ['https://a.example']);
  assert.equal(s.vault.list.length, 0);
  const d = setup({ choice: 'dismiss' });
  await d.submit(fakeEvent('https://a.example'), { username: 'u', password: 'p' });
  assert.equal(d.vault.list.length, 0);
  assert.deepEqual(d.settings.get('passwords.never'), []);
});

test('a username from an earlier step is used for saving and for picking', async () => {
  const s = setup({ entries: [
    { origin: 'https://accounts.example', username: 'first@example.com', password: 'p1' },
    { origin: 'https://accounts.example', username: 'second@example.com', password: 'p2' },
  ] });
  s.username(fakeEvent('https://accounts.example'), { username: 'second@example.com' });
  s.username(fakeEvent('https://accounts.example', { persistent: false, id: 8 }), { username: 'private@example.com' });
  const r = s.query(fakeEvent('https://accounts.example'));
  assert.deepEqual(r.map((e) => [e.username, e.preferred]), [['second@example.com', true], ['first@example.com', false]]);
  assert.equal(s.query(fakeEvent('https://accounts.example', { id: 9 }))[0].preferred, false, 'per webContents');
  await s.submit(fakeEvent('https://accounts.example'), { username: '', password: 'p2-new' });
  assert.deepEqual(s.prompts.map((p) => [p.username, p.isUpdate]), [['second@example.com', true]]);
});

test('dispose removes the handlers', () => {
  const s = setup();
  s.reg.dispose();
  assert.equal(s.ipcMain.handlers.size, 0);
  assert.equal(s.ipcMain.listeners.size, 0);
});

// ---------- page side, in a headless Electron ----------

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, '.electron', 'electron');

const PAGES = {
  // GitHub-like: plain form post; plus honeypot password fields that must stay empty.
  '/github': `<form action="/session" method="post" id="f">
      <input type="text" name="login" id="login_field" autocomplete="username">
      <input type="password" name="password" id="password" autocomplete="current-password">
      <input type="submit" value="Sign in" id="go"></form>
    <input type="password" id="offscreen" style="position:absolute;left:-9999px">
    <div style="display:none"><input type="password" id="nodisplay"></div>
    <input type="password" id="invisible" style="visibility:hidden">
    <script>window.events = []; for (const el of document.querySelectorAll('input')) el.addEventListener('input', (e) => events.push(e.target.id));</script>`,
  // Google-like: email step, then a password step built in place (SPA).
  '/spa': `<div id="app"><form id="f1" onsubmit="return false">
      <input type="email" name="identifier" id="email" autocomplete="username webauthn">
      <input type="password" name="hiddenPassword" id="hp" aria-hidden="true" tabindex="-1" style="position:absolute;opacity:0;width:1px;height:1px">
      <div role="button" id="next" style="display:inline-block;padding:8px">Next</div></form></div>
    <script>
      next.onclick = () => {
        const who = email.value;
        setTimeout(() => {
          app.innerHTML = '<form id="f2" onsubmit="return false"><div id="who"></div>'
            + '<input type="password" name="Passwd" id="pw" autocomplete="current-password">'
            + '<div role="button" id="signin" style="display:inline-block;padding:8px">Sign in</div></form>';
          document.getElementById('who').textContent = who;
          history.pushState({}, '', '/spa/challenge/pwd');
          document.getElementById('signin').onclick = () => setTimeout(() => {
            app.innerHTML = '<p>Welcome</p>';
            history.pushState({}, '', '/spa/myaccount');
          }, 100);
        }, 300);
      };
    </script>`,
  // A form built by script well after load, without a <form> element.
  '/late': `<div id="root"></div>
    <script>setTimeout(() => { root.innerHTML = '<div><div><input id="u" name="email" type="email"></div></div><div><input id="p" type="password"></div>'; }, 900);</script>`,
  // React-style controlled input: onChange only fires if the tracked value differs.
  '/react': `<input id="ru" name="username"><input id="rp" type="password">
    <script>
      window.changes = [];
      const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      for (const el of [ru, rp]) {
        let tracked = '';
        Object.defineProperty(el, 'value', { configurable: true, get() { return proto.get.call(this); }, set(v) { tracked = String(v); proto.set.call(this, v); } });
        el.addEventListener('input', () => { const real = proto.get.call(el); if (real !== tracked) { tracked = real; changes.push(el.id); } });
      }
    </script>`,
  '/change': `<form><input type="password" id="cur" autocomplete="current-password">
      <input type="password" id="new1" autocomplete="new-password"><input type="password" id="new2" autocomplete="new-password"></form>
    <form><input type="text" id="su" autocomplete="username"><input type="password" id="s1"><input type="password" id="s2"></form>`,
  '/frame-top': `<input id="tu" name="user"><input id="tp" type="password">
    <iframe id="fr" src="{{C}}/frame-inner" style="width:500px;height:200px;border:0"></iframe>`,
  '/frame-inner': '<input id="iu" name="user" autocomplete="username"><input id="ip" type="password" autocomplete="current-password">',
  '/session': '<p>Signed in</p>',
  // No login here: a search box, a newsletter field and some DOM churn.
  '/plain': `<input id="s" type="search" name="q"><input id="nl" type="email" name="newsletter"><div id="c"></div>
    <script>let n = 0; const t = setInterval(() => { c.textContent = n++; if (n > 20) clearInterval(t); }, 40);</script>`,
  // Formless login box and formless sign-up box on one page.
  '/mixed': `<section><div><div><input id="lu" name="username"></div><div><input id="lp" type="password"></div></div></section>
    <section style="margin-top:40px"><div><div><input id="nu" name="new-user"></div><div><input id="np1" type="password"></div><div><input id="np2" type="password"></div></div></section>`,
};

// Runs inside Electron (serialized with toString); cfg is JSON.
function electronMain(cfg) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const http = require('node:http');
  const { registerAutofillIpc } = require(cfg.autofillIpc);
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = (name) => process.stdout.write('STEP ' + name + '\n');

  function serve(pages) {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          const html = pages[req.url.split('?')[0].replace(/^\/spa\/.*/, '/spa')] || '<p>not found</p>';
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><body style="margin:20px">' + html.replace('{{C}}', pages.C));
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
    });
  }

  app.whenReady().then(async () => {
    const pages = { ...cfg.pages };
    const [pa, pb, pc] = await Promise.all([serve(pages), serve(pages), serve(pages)]);
    const A = `http://127.0.0.1:${pa}`, B = `http://127.0.0.1:${pb}`, C = `http://127.0.0.1:${pc}`;
    pages.C = C;
    const table = {
      [A]: [{ id: 'a1', origin: A, username: 'alice', password: 'pw-alice' }],
      [B]: [{ id: 'b1', origin: B, username: 'first@example.com', password: 'pw-first' },
        { id: 'b2', origin: B, username: 'second@example.com', password: 'pw-second' }],
      [C]: [{ id: 'c1', origin: C, username: 'carol', password: 'pw-carol' }],
    };
    const prompts = [];
    const saved = [];
    const queries = [];
    registerAutofillIpc({
      ipcMain,
      vault: {
        available: () => ({ ok: true }),
        find: (o) => { queries.push(o); return (table[o] || []).map((e) => ({ ...e })); },
        save: (e) => { saved.push({ origin: e.origin, username: e.username, password: e.password }); return { id: 'x', status: 'added' }; },
      },
      settings: { get: (k) => (k === 'passwords.never' ? [] : k === 'passwords.offerToSave' ? true : undefined), set() {} },
      promptSave: async (p) => { prompts.push({ origin: p.origin, username: p.username, isUpdate: p.isUpdate }); return 'save'; },
    });

    const win = new BrowserWindow({
      show: false, width: 1000, height: 800,
      webPreferences: { preload: cfg.preload, sandbox: cfg.sandbox, contextIsolation: true, nodeIntegrationInSubFrames: true, backgroundThrottling: false },
    });
    const wc = win.webContents;
    // Trusted input through the DevTools protocol: a hidden headless window
    // has no real size, so webContents.sendInputEvent mouse events miss.
    await wc.loadURL('about:blank'); // CDP commands wait for a first document
    wc.debugger.attach('1.3');
    const cdp = (method, params) => wc.debugger.sendCommand(method, params);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    const js = (code, frame) => (frame || wc.mainFrame).executeJavaScript(code);
    const load = async (url, wait = 700) => { await wc.loadURL(url); await sleep(wait); };
    const val = (sel, frame) => js(`document.querySelector(${JSON.stringify(sel)})?.value ?? null`, frame);
    const center = async (sel, frame, offset = { x: 0, y: 0 }) => {
      const r = await js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, frame);
      return { x: Math.round(r.x + offset.x), y: Math.round(r.y + offset.y) };
    };
    const click = async ({ x, y }) => {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleep(200);
    };
    const KEYS = { Down: ['ArrowDown', 40], Enter: ['Enter', 13] };
    const key = async (name) => {
      const [k, code] = KEYS[name];
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code, text: k === 'Enter' ? '\r' : undefined });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code });
      await sleep(120);
    };
    const chooserOpen = (frame) => js('!!document.querySelector("sn-autofill")', frame);

    step('1. GitHub');
    // 1. GitHub-like form, honeypots, events, save on submit.
    await load(A + '/github');
    out.github = {
      user: await val('#login_field'), pass: await val('#password'),
      honeypots: [await val('#offscreen'), await val('#nodisplay'), await val('#invisible')],
      events: await js('events.slice()'),
      chooserFromPage: await js('document.querySelector("sn-autofill")?.shadowRoot ?? "none"'),
    };
    await js('document.querySelector("#password").value = "pw-alice-new"');
    await click(await center('#go'));
    await sleep(500);
    out.github.prompts = prompts.splice(0);
    out.github.saved = saved.splice(0);
    out.github.url = wc.getURL().replace(A, '');

    step('2. Google');
    // 2. Google-like two steps with two saved accounts.
    await load(B + '/spa');
    out.spa = { step1: await val('#email'), hidden: await val('#hp') };
    await click(await center('#email'));
    out.spa.chooser = await chooserOpen();
    await key('Down'); await key('Down'); await key('Enter');
    out.spa.picked = await val('#email');
    out.spa.chooserAfterPick = await chooserOpen();
    await click(await center('#next'));
    await sleep(900);
    out.spa.url = wc.getURL().replace(B, '');
    out.spa.step2 = await val('#pw');
    await js('document.querySelector("#pw").value = "pw-second-new"');
    await click(await center('#signin'));
    await sleep(900);
    out.spa.prompts = prompts.splice(0);
    out.spa.saved = saved.splice(0);

    step('3. Fields');
    // 3. Fields created by script after load.
    await load(A + '/late', 300);
    out.late = { before: await val('#u') };
    await sleep(1600);
    out.late.user = await val('#u');
    out.late.pass = await val('#p');

    step('4. React');
    // 4. React-style controlled inputs see the change.
    await load(A + '/react');
    out.react = { user: await val('#ru'), pass: await val('#rp'), changes: await js('changes.slice()') };

    step('5. Change');
    // 5. Change-password and sign-up forms.
    await load(A + '/change');
    out.change = { cur: await val('#cur'), new1: await val('#new1'), new2: await val('#new2'), su: await val('#su'), s1: await val('#s1'), s2: await val('#s2') };

    step('6. Cross');
    // 6. Cross-origin iframe: no auto-fill, its own origin's logins on demand.
    queries.length = 0;
    await load(A + '/frame-top', 1200);
    const frame = wc.mainFrame.frames[0];
    out.frame = {
      top: [await val('#tu'), await val('#tp')],
      inner: [await val('#iu', frame), await val('#ip', frame)],
      queried: queries.slice().sort(),
      origins: { A, C },
    };
    const ip = await js('(() => { const r = document.querySelector("#ip").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()', frame);
    const frameRect = await js('(() => { const r = document.querySelector("#fr").getBoundingClientRect(); return { x: r.left, y: r.top }; })()');
    await click({ x: Math.round(frameRect.x + ip.x), y: Math.round(frameRect.y + ip.y) });
    out.frame.chooser = await chooserOpen(frame);
    await key('Down'); await key('Enter');
    out.frame.afterPick = [await val('#iu', frame), await val('#ip', frame)];

    step('7. Plain');
    queries.length = 0;
    await load(A + '/plain', 1200);
    out.plain = { queried: queries.length, search: await val('#s'), newsletter: await val('#nl') };

    step('8. Mixed');
    await load(A + '/mixed');
    out.mixed = ['#lu', '#lp', '#nu', '#np1', '#np2'];
    for (let i = 0; i < out.mixed.length; i++) out.mixed[i] = await val(out.mixed[i]);

    out.sandbox = cfg.sandbox;
    process.stdout.write('RESULT ' + JSON.stringify(out) + '\n');
    app.exit(0);
  }).catch((err) => {
    process.stdout.write('ERROR ' + String((err && (err.stack || err.message)) || err).replace(/\n/g, ' | ') + ' | so far: ' + JSON.stringify(out) + '\n');
    app.exit(1);
  });
}

function runElectron() {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-autofill-e2e-'));
    const entry = path.join(dir, 'entry.js');
    const preload = path.join(dir, 'preload.js');
    fs.writeFileSync(entry, `require(${JSON.stringify(path.join(ROOT, 'src/preload/autofill.js'))}).installAutofill({ ipcRenderer: require('electron').ipcRenderer });\n`);
    // Like production: bundled for the browser (no Node built-ins allowed) and
    // run in a sandboxed preload. Without esbuild, fall back to an unbundled,
    // unsandboxed preload.
    let sandbox = true;
    try {
      require('esbuild').buildSync({ entryPoints: [entry], bundle: true, outfile: preload, platform: 'browser', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    } catch (err) {
      if (err && err.code !== 'MODULE_NOT_FOUND') { resolve({ failed: 'esbuild: ' + err.message }); return; }
      fs.copyFileSync(entry, preload);
      sandbox = false;
    }
    const cfg = { pages: PAGES, preload, sandbox, autofillIpc: path.join(ROOT, 'src/main/autofill-ipc.js') };
    fs.writeFileSync(path.join(dir, 'main.js'), `(${electronMain.toString()})(${JSON.stringify(cfg)});\n`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(ELECTRON, ['--no-sandbox', '--no-zygote', '--ozone-platform=headless', '--disable-gpu',
      `--user-data-dir=${path.join(dir, 'profile')}`, path.join(dir, 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const debug = !!process.env.SN_AUTOFILL_E2E_DEBUG; // pipe Electron's output through
    child.stdout.on('data', (d) => { stdout += d; if (debug) process.stderr.write(d); });
    child.stderr.on('data', (d) => { if (debug) process.stderr.write(d); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('error', (err) => { clearTimeout(timer); resolve({ error: err.message }); });
    child.on('exit', () => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT ') || l.startsWith('ERROR '));
      if (!line) resolve({ error: 'electron did not report' });
      else if (line.startsWith('ERROR ')) resolve({ failed: line.slice(6) });
      else resolve({ result: JSON.parse(line.slice(7)) });
    });
  });
}

const canRunElectron = fs.existsSync(ELECTRON) && !process.env.SN_SKIP_ELECTRON_TESTS;

test('page side in a real (headless) Electron', { skip: canRunElectron ? false : 'no .electron/electron', timeout: 90000 }, async (t) => {
  const run = await runElectron();
  if (run.error) { t.skip(`electron could not run: ${run.error}`); return; }
  assert.equal(run.failed, undefined, run.failed);
  const r = run.result;
  if (!r.sandbox) t.diagnostic('esbuild not installed: ran the preload unbundled and unsandboxed');

  await t.test('GitHub-like form: fills visible fields, never honeypots, fires input events', () => {
    assert.equal(r.github.user, 'alice');
    assert.ok(r.github.pass === 'pw-alice');
    assert.deepEqual(r.github.honeypots, ['', '', '']);
    assert.deepEqual(r.github.events, ['login_field', 'password']);
  });
  await t.test('form post with a changed password prompts an update for the frame origin', () => {
    assert.equal(r.github.url, '/session');
    assert.deepEqual(r.github.prompts.map((p) => [p.username, p.isUpdate]), [['alice', true]]);
    assert.ok(r.github.saved.length === 1 && r.github.saved[0].password === 'pw-alice-new');
  });
  await t.test('Google-like two steps: chooser, remembered username, SPA submit', () => {
    assert.equal(r.spa.step1, 'first@example.com', 'first account pre-filled');
    assert.equal(r.spa.hidden, '', 'hidden password field untouched');
    assert.equal(r.spa.chooser, true, 'chooser opens on click with two accounts');
    assert.equal(r.spa.picked, 'second@example.com');
    assert.equal(r.spa.chooserAfterPick, false);
    assert.equal(r.spa.url, '/spa/challenge/pwd');
    assert.ok(r.spa.step2 === 'pw-second', 'password step filled for the chosen account');
    assert.deepEqual(r.spa.prompts.map((p) => [p.username, p.isUpdate]), [['second@example.com', true]]);
    assert.ok(r.spa.saved.length === 1 && r.spa.saved[0].password === 'pw-second-new');
  });
  await t.test('fields created after load are filled', () => {
    assert.equal(r.late.before, null);
    assert.equal(r.late.user, 'alice');
    assert.ok(r.late.pass === 'pw-alice');
  });
  await t.test('React-style controlled inputs notice the fill', () => {
    assert.equal(r.react.user, 'alice');
    assert.deepEqual(r.react.changes, ['ru', 'rp']);
  });
  await t.test('change-password and sign-up forms: only current-password is filled', () => {
    assert.ok(r.change.cur === 'pw-alice');
    assert.deepEqual([r.change.new1, r.change.new2, r.change.su, r.change.s1, r.change.s2], ['', '', '', '', '']);
  });
  await t.test('pages without login fields never ask for passwords', () => {
    assert.deepEqual(r.plain, { queried: 0, search: '', newsletter: '' });
  });
  await t.test('formless login next to a formless sign-up: only the login is filled', () => {
    assert.equal(r.mixed[0], 'alice');
    assert.ok(r.mixed[1] === 'pw-alice');
    assert.deepEqual(r.mixed.slice(2), ['', '', '']);
  });
  await t.test('cross-origin iframe: not auto-filled, gets its own origin on demand', () => {
    assert.equal(r.frame.top[0], 'alice');
    assert.deepEqual(r.frame.inner, ['', '']);
    assert.deepEqual(r.frame.queried, [r.frame.origins.A, r.frame.origins.C].sort());
    assert.equal(r.frame.chooser, true);
    assert.equal(r.frame.afterPick[0], 'carol');
    assert.ok(r.frame.afterPick[1] === 'pw-carol');
  });
});
