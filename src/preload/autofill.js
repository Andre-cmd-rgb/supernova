'use strict';
// Password autofill, page side.
//
// Runs in the isolated world of every frame, bundled into the sandboxed page
// preload: plain JS and DOM only, ipcRenderer is passed in. Page scripts
// cannot see anything here (separate JS world); the only things they see are
// the values we put into login fields and a host element whose closed shadow
// root holds the account chooser.
//
// Cost on pages without login fields: one throttled MutationObserver
// (childList only) whose scan walks the live list of <input> elements.

const INSTALLED = Symbol.for('supernova.autofill');
const SCAN_DELAY_MS = 400;
const PENDING_TTL_MS = 60000;
const MAX_CANDIDATES = 50;
const MAX_VALUE = 4096;
const TEXTY = /^(text|email|tel)$/; // input.type is 'text' when missing/unknown
const NOT_USER = /search|captcha|otp|one.?time|totp|2fa|coupon|promo|zip|postal|phone.?code|verification/i;
const WATCHED_ATTRS = ['type', 'style', 'class', 'hidden', 'aria-hidden', 'disabled'];

function installAutofill({ ipcRenderer } = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !ipcRenderer) return;
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return;
  // On the document, not the window: the initial about:blank of a frame can
  // hand its Window over to the first real document.
  if (document[INSTALLED]) return;
  document[INSTALLED] = true;

  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const inputs = document.getElementsByTagName('input'); // live, cheap to re-read

  let candidates = null; // null: not asked yet
  let asking = false;
  let contexts = [];     // [{ pw, user, fill }] from the last scan
  let scanTimer = 0;
  let observer = null;
  let watchingAttrs = false;
  let listening = false;
  let unloadHooked = false;
  let rememberedUser = '';
  let pending = null;    // { username, password, pw, user, href, at }
  let chooser = null;    // { host, ctx, anchor, items, active }
  const filled = new WeakMap(); // element -> value we put there
  const tried = new WeakSet();  // fields we already considered for auto-fill
  const knownPw = new WeakSet(); // password fields seen (type may flip to text)

  // ---------- field classification ----------

  function tokens(el) {
    return (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  }

  function isVisible(el) {
    if (!el || !el.isConnected || el.disabled || el.hidden || el.type === 'hidden') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (r.right + (window.scrollX || 0) <= 0 || r.bottom + (window.scrollY || 0) <= 0) return false; // parked off the page
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true });
    }
    const cs = getComputedStyle(el);
    return cs.visibility === 'visible' && cs.display !== 'none' && Number(cs.opacity) > 0;
  }

  function isUserish(el) {
    if (!TEXTY.test(el.type) || el.readOnly) return false;
    const ac = tokens(el);
    if (ac.includes('one-time-code') || ac.some((t) => t.startsWith('cc-'))) return false;
    const role = el.getAttribute('role');
    if (role === 'combobox' || role === 'searchbox' || el.name === 'q') return false;
    const hint = (el.name || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('placeholder') || '');
    return !NOT_USER.test(hint);
  }

  function userScore(el) {
    const ac = tokens(el);
    let s = 1;
    if (ac.includes('username')) s += 20;
    else if (ac.includes('email')) s += 10;
    if (el.type === 'email') s += 5;
    if (/user|login|e-?mail|account|ident|nick|member/i.test((el.name || '') + ' ' + (el.id || ''))) s += 3;
    return s;
  }

  // Best visible username-like field before `pw`, in the smallest ancestor
  // that has one (bounded by the form, or 10 levels without a form).
  function findUsernameField(pw) {
    let node = pw.parentElement;
    for (let depth = 0; node; depth++, node = node.parentElement) {
      let best = null, bestScore = 0;
      for (const el of node.getElementsByTagName('input')) {
        if (el === pw) break;
        if (!isUserish(el) || !isVisible(el)) continue;
        const s = userScore(el);
        if (s >= bestScore) { best = el; bestScore = s; }
      }
      if (best) return best;
      if (node === pw.form || node === document.body || (!pw.form && depth >= 10)) break;
    }
    return null;
  }

  // A username that is on the page but not editable here (e.g. the hidden
  // field Google keeps on its password step), used to pick and to save.
  function hiddenUsername(pw) {
    const scope = (pw && pw.form) || document;
    for (const el of scope.getElementsByTagName('input')) {
      if (el === pw || el.type === 'password') continue;
      const v = (el.value || '').trim();
      if (!v || v.length > 256) continue;
      if (tokens(el).includes('username') || el.type === 'email' || /^(identifier|username|email|login)$/i.test(el.name || '')) return v;
    }
    return '';
  }

  // Fields without a <form>: group by a nearby ancestor, so a formless login
  // box and a formless sign-up box elsewhere on the page stay apart.
  function groupKey(el) {
    if (el.form) return el.form;
    let node = el;
    for (let i = 0; i < 5 && node.parentElement && node.parentElement !== document.body; i++) node = node.parentElement;
    return node;
  }

  function findContexts() {
    const groups = new Map(); // form or ancestor -> visible password fields
    let anyPw = false;
    let userOnly = null;
    for (const el of inputs) {
      if (el.type === 'password') {
        anyPw = true;
        knownPw.add(el);
        if (!isVisible(el)) continue;
        const key = groupKey(el);
        const g = groups.get(key);
        if (g) g.push(el); else groups.set(key, [el]);
      } else if (!userOnly && TEXTY.test(el.type) && tokens(el).includes('username') && !el.readOnly) {
        anyPw = true; // a declared username field: watch it like a login form
        if (isVisible(el)) userOnly = el;
      }
    }
    watchAttributes(anyPw);
    const out = [];
    for (const pws of groups.values()) {
      for (const pw of pws) {
        const ac = tokens(pw);
        // Sign-up and change-password forms: fill only a declared current-password.
        const fill = ac.includes('current-password') || (pws.length === 1 && !ac.includes('new-password'));
        out.push({ pw, user: findUsernameField(pw), fill });
      }
    }
    if (!out.length && userOnly) out.push({ pw: null, user: userOnly, fill: true });
    return out;
  }

  function ctxFor(el) {
    for (const c of contexts) if (c.pw === el || c.user === el) return c;
    return null;
  }

  // ---------- scanning ----------

  function scheduleScan(delay) {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, delay === undefined ? SCAN_DELAY_MS : delay);
  }

  function scan() {
    scanTimer = 0;
    if (chooser && !isVisible(chooser.anchor)) closeChooser();
    checkPending();
    contexts = findContexts();
    if (!contexts.length) return;
    listen();
    if (candidates) fillContexts();
    else ask();
  }

  function watchAttributes(on) {
    if (!observer || on === watchingAttrs) return;
    watchingAttrs = on;
    observer.disconnect();
    const opts = { childList: true, subtree: true };
    if (on) { opts.attributes = true; opts.attributeFilter = WATCHED_ATTRS; }
    observer.observe(document.documentElement, opts);
  }

  function ask() {
    if (asking) return;
    asking = true;
    Promise.resolve()
      .then(() => ipcRenderer.invoke('sn:pw:query', { origin: location.origin, frameUrl: location.href }))
      .then((list) => {
        candidates = [];
        if (!Array.isArray(list)) return;
        for (const c of list.slice(0, MAX_CANDIDATES)) {
          if (!c || typeof c.password !== 'string' || !c.password) continue;
          candidates.push({ username: typeof c.username === 'string' ? c.username : '', password: c.password, preferred: !!c.preferred });
        }
      }, () => { candidates = []; })
      .then(() => fillContexts());
  }

  // Never auto-fill inside a frame embedded by another origin, or on a page
  // that is not a secure context (plain http to another machine, where anyone
  // on the network can add a script that reads the field). There the chooser
  // still opens when the user focuses the field.
  function autoFillAllowed() {
    if (!window.isSecureContext) return false;
    if (window.top === window) return true;
    const anc = location.ancestorOrigins;
    if (anc && anc.length) {
      for (let i = 0; i < anc.length; i++) if (anc[i] !== location.origin) return false;
      return true;
    }
    try { return window.top.location.origin === location.origin; } catch { return false; }
  }

  function choose(ctx) {
    const list = candidates;
    if (!list || !list.length) return null;
    if (ctx.pw && ctx.pw.value && !filled.has(ctx.pw)) return null; // the user typed a password
    const lc = (s) => s.trim().toLowerCase();
    let known = ctx.user && ctx.user.value && !filled.has(ctx.user) ? lc(ctx.user.value) : '';
    if (!known && !ctx.user) known = lc(hiddenUsername(ctx.pw) || rememberedUser);
    if (known) return list.find((c) => lc(c.username) === known) || null;
    return list.find((c) => c.preferred) || list[0];
  }

  function fillContexts() {
    if (!candidates || !candidates.length) return;
    const auto = autoFillAllowed();
    for (const ctx of contexts) {
      const key = ctx.pw || ctx.user;
      if (tried.has(key)) continue;
      tried.add(key);
      if (!auto || !ctx.fill) continue;
      const pick = choose(ctx);
      if (pick) fillCredential(ctx, pick, false);
    }
  }

  function setValue(el, value) {
    if (!isVisible(el) || el.readOnly || el.disabled) return false; // never fill hidden fields
    if (el.value !== value) {
      valueSetter.call(el, value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    filled.set(el, value);
    return true;
  }

  function fillCredential(ctx, cred, chosen) {
    if (ctx.user && cred.username && (chosen || !ctx.user.value || filled.has(ctx.user))) setValue(ctx.user, cred.username);
    if (ctx.pw) setValue(ctx.pw, cred.password);
  }

  // ---------- account chooser (closed shadow root, inline styles only) ----------

  function style(el, props) {
    for (const k in props) el.style.setProperty(k, props[k], 'important');
  }

  function openChooser(ctx, anchor) {
    closeChooser();
    const list = candidates;
    if (!list || !list.length || !isVisible(anchor)) return;
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const fg = dark ? '#e8e8e8' : '#1d1d1f';
    const bg = dark ? '#2b2b2e' : '#ffffff';
    const hi = dark ? '#3d3d42' : '#e9eefb';
    const r = anchor.getBoundingClientRect();
    const host = document.createElement('sn-autofill');
    const root = host.attachShadow({ mode: 'closed' });
    style(host, { all: 'initial', position: 'fixed', 'z-index': '2147483647', display: 'block' });
    const box = document.createElement('div');
    box.setAttribute('role', 'listbox');
    style(box, {
      'min-width': Math.min(Math.max(r.width, 180), 360) + 'px', 'max-width': '360px', 'max-height': '188px',
      'overflow-y': 'auto', 'box-sizing': 'border-box', padding: '4px', margin: '0',
      background: bg, color: fg, border: '1px solid ' + (dark ? '#48484d' : '#d0d0d5'), 'border-radius': '8px',
      'box-shadow': '0 4px 16px rgba(0,0,0,.18)', font: '13px/1.3 system-ui, sans-serif', 'text-align': 'left',
    });
    const items = list.map((cred, i) => {
      const item = document.createElement('div');
      item.setAttribute('role', 'option');
      item.textContent = cred.username || '(no username)';
      style(item, {
        padding: '6px 10px', 'border-radius': '5px', cursor: 'default', 'white-space': 'nowrap',
        overflow: 'hidden', 'text-overflow': 'ellipsis', background: 'transparent', color: fg,
        'font-style': cred.username ? 'normal' : 'italic',
      });
      item.addEventListener('mouseenter', () => setActive(i));
      // mousedown + preventDefault: the field keeps focus while choosing.
      item.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); pick(i); }, true);
      box.appendChild(item);
      return item;
    });
    root.appendChild(box);
    (document.body || document.documentElement).appendChild(host);
    chooser = { host, ctx, anchor, items, active: -1, hi };
    place();
    window.addEventListener('scroll', place, { capture: true, passive: true });
    window.addEventListener('resize', closeChooser);
  }

  // Under the field (above it when there is no room); closes once the field
  // has scrolled out of view.
  function place() {
    if (!chooser) return;
    const r = chooser.anchor.getBoundingClientRect();
    const vh = window.innerHeight;
    if (r.bottom < 0 || r.top > vh) { closeChooser(); return; }
    const h = chooser.host.getBoundingClientRect().height || Math.min(chooser.items.length, 6) * 30 + 10;
    const top = vh - r.bottom >= h + 4 || r.top < h + 4 ? r.bottom + 2 : r.top - 2 - h;
    style(chooser.host, { left: Math.max(0, Math.round(r.left)) + 'px', top: Math.max(0, Math.round(top)) + 'px' });
  }

  function setActive(i) {
    if (!chooser) return;
    chooser.items.forEach((el, j) => el.style.setProperty('background', j === i ? chooser.hi : 'transparent', 'important'));
    chooser.active = i;
  }

  function pick(i) {
    if (!chooser) return;
    const { ctx } = chooser;
    const cred = candidates && candidates[i];
    closeChooser();
    if (!cred) return;
    tried.add(ctx.pw || ctx.user);
    fillCredential(ctx, cred, true);
    if (cred.username) rememberedUser = cred.username;
  }

  function closeChooser() {
    if (!chooser) return;
    chooser.host.remove();
    chooser = null;
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', closeChooser);
  }

  function maybeOpen(el) {
    const ctx = ctxFor(el);
    if (!ctx || !candidates || !candidates.length) return;
    if (chooser && chooser.anchor === el) return;
    // One saved login that is already in the field: nothing to choose.
    if (candidates.length === 1 && filled.has(el) && filled.get(el) === el.value) return;
    openChooser(ctx, el);
  }

  // ---------- submit detection ----------

  function overlaps(a, b) {
    const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
    return x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top;
  }

  function usernameFor(pw, user) {
    const v = user && user.value ? user.value.trim() : '';
    return v || hiddenUsername(pw) || rememberedUser;
  }

  function rememberUser(value) {
    const v = (value || '').trim();
    if (!v || v.length > 256) return;
    rememberedUser = v;
    ipcRenderer.send('sn:pw:username', { username: v });
  }

  function credentialsIn(form) {
    const pws = [];
    for (const el of form.getElementsByTagName('input')) {
      if ((el.type === 'password' || knownPw.has(el)) && el.value) pws.push(el);
    }
    if (!pws.length) return null;
    const fresh = pws.find((el) => tokens(el).includes('new-password'));
    let pw = pws[0];
    if (fresh) pw = fresh;
    else if (pws.length >= 2 && pws[0].value !== pws[1].value) pw = pws[1]; // current, new, confirm
    const first = pws[0];
    const user = first.type === 'password' ? findUsernameField(first) : (ctxFor(first) || {}).user || null;
    return { pw, user, username: usernameFor(first, user), password: pw.value };
  }

  function send(cred) {
    if (pending === cred || (pending && pending.pw === cred.pw)) pending = null;
    const password = cred.password;
    if (!password || password.length > MAX_VALUE) return;
    // We filled exactly this and nobody changed it: it is already saved.
    if (filled.get(cred.pw) === password && (!cred.user || filled.get(cred.user) === cred.user.value)) return;
    ipcRenderer.send('sn:pw:submitted', { origin: location.origin, username: cred.username || '', password });
  }

  function setPending(cred) {
    pending = Object.assign({}, cred, { href: location.href, at: Date.now() });
    if (!unloadHooked) {
      unloadHooked = true;
      window.addEventListener('beforeunload', onUnload, true);
      window.addEventListener('pagehide', onUnload, true);
    }
    setTimeout(checkPending, 1500);
  }

  function anyVisibleLoginPassword() {
    for (const el of inputs) {
      if (el.type === 'password' && !tokens(el).includes('new-password') && isVisible(el)) return true;
    }
    return false;
  }

  // In-page (XHR) logins: count it as done when the password field went away
  // or the URL changed, and no login password field is left on the page.
  function checkPending() {
    if (!pending) return;
    if (Date.now() - pending.at > PENDING_TTL_MS) { pending = null; return; }
    const gone = !isVisible(pending.pw);
    const moved = location.href !== pending.href;
    if ((gone || moved) && !anyVisibleLoginPassword()) send(pending);
  }

  function onUnload() {
    if (pending) send(pending);
  }

  function captureNear(target) {
    for (const ctx of contexts) {
      if (!ctx.pw) {
        if (ctx.user.value && (!target.form || target.form === ctx.user.form || target === ctx.user)) rememberUser(ctx.user.value);
        continue;
      }
      if (!ctx.pw.value) continue;
      if (target !== ctx.pw && target !== ctx.user && overlaps(target, ctx.pw)) return; // show/hide toggle
      if (target.form && ctx.pw.form && target.form !== ctx.pw.form) continue;
      setPending({ pw: ctx.pw, user: ctx.user, username: usernameFor(ctx.pw, ctx.user), password: ctx.pw.value });
      return;
    }
  }

  function onSubmit(e) {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const cred = credentialsIn(form);
    if (!cred) {
      for (const ctx of contexts) if (!ctx.pw && ctx.user.form === form) rememberUser(ctx.user.value);
      return;
    }
    // After the page's own handlers: a real navigation follows unless they
    // prevented it, so send now while this frame still owns the document.
    setTimeout(() => {
      if (!e.defaultPrevented) send(cred);
      else setPending(cred);
    }, 0);
  }

  function onClick(e) {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const t = e.target;
    if (t instanceof HTMLInputElement && ctxFor(t)) { maybeOpen(t); return; }
    const btn = t.closest('button, input[type="submit"], input[type="button"], input[type="image"], [role="button"], a');
    if (btn) captureNear(btn);
  }

  function onKeyDown(e) {
    if (chooser && e.target === chooser.anchor) {
      const n = chooser.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(((chooser.active + (e.key === 'ArrowDown' ? 1 : -1)) % n + n) % n);
        return;
      }
      if (e.key === 'Enter' && chooser.active >= 0) { e.preventDefault(); e.stopPropagation(); pick(chooser.active); return; }
      if (e.key === 'Escape') { closeChooser(); return; }
    }
    if (e.key === 'Enter' && !e.isComposing && e.isTrusted && ctxFor(e.target)) captureNear(e.target);
  }

  function onInput(e) {
    const t = e.target;
    if (!e.isTrusted || !(t instanceof HTMLInputElement)) return;
    if (filled.has(t)) filled.delete(t); // the user changed what we filled
    if (chooser && chooser.anchor === t) closeChooser();
  }

  function onFocusIn(e) {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (ctxFor(t)) { if (e.isTrusted) maybeOpen(t); return; }
    if (t.type === 'password' || (TEXTY.test(t.type) && tokens(t).includes('username'))) scheduleScan(0);
  }

  function onFocusOut(e) {
    if (chooser && e.target === chooser.anchor) setTimeout(() => { if (chooser && document.activeElement !== chooser.anchor) closeChooser(); }, 0);
  }

  function listen() {
    if (listening) return;
    listening = true;
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('focusout', onFocusOut, true);
  }

  // ---------- start ----------

  function start() {
    if (!document.documentElement) return;
    const ours = (r) => r.target === chooser.host
      || (r.type === 'childList' && r.removedNodes.length === 0 && r.addedNodes.length === 1 && r.addedNodes[0] === chooser.host);
    observer = new MutationObserver((records) => {
      if (chooser && records.every(ours)) return; // our own chooser
      scheduleScan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('load', () => scheduleScan(0), { once: true });
    scan();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

module.exports = { installAutofill };
