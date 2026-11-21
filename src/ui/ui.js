'use strict';
/* global sn, icon */
// The browser UI. Two views load this page: "chrome" (sidebar or top bar,
// and the command bar) and "float" (prompts, find bar, download toasts).

const params = new URLSearchParams(location.search);
const VIEW = params.get('view') || 'chrome';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
document.body.classList.add(`view-${VIEW}`);
if (params.get('private') === '1') document.body.classList.add('private');

let state = null;

// ---------------------------------------------------------------- theme ----

let themeKey = '';
function applyTheme(t) {
  const key = JSON.stringify(t);
  if (key === themeKey) return;
  themeKey = key;
  const r = document.documentElement.style;
  r.setProperty('--bg', t.background);
  r.setProperty('--bg2', t.dark_background);
  r.setProperty('--bg3', t.lighter_background);
  r.setProperty('--sel', t.selection);
  r.setProperty('--fg', t.foreground);
  r.setProperty('--fg2', t.light_foreground);
  r.setProperty('--fg3', t.dark_foreground);
  r.setProperty('--muted', t.muted);
  r.setProperty('--accent', t.accent);
  r.setProperty('--red', t.red);
  document.body.classList.toggle('theme-dark', t.mode === 'dark');
}

// ---------------------------------------------------------- favicons ----

function favHtml(t, extra = '') {
  const letter = esc(((t.title || t.url || '?').replace(/^https?:\/\/(www\.)?/, '')[0]) || '?');
  const img = t.favicon ? `<img src="${esc(t.favicon)}" alt="" draggable="false" data-letter="${letter}">` : `<span class="letter">${letter}</span>`;
  return `<span class="fav ${extra}">${img}</span>`;
}

// A favicon that fails to load becomes the site's first letter.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.dataset.letter) return;
  const span = document.createElement('span');
  span.className = 'letter';
  span.textContent = img.dataset.letter;
  img.replaceWith(span);
}, true);

// ---------------------------------------------------------- chrome view ----

if (VIEW === 'chrome') {
  $('back').innerHTML = icon('back');
  $('forward').innerHTML = icon('forward');
  $('reload').innerHTML = icon('reload');
  $('settings').innerHTML = icon('gear');
  $('downloads').innerHTML = icon('download');
  document.querySelector('[data-icon="plus"]').innerHTML = icon('plus');
  document.querySelector('[data-icon="search"]').innerHTML = icon('search');
  $('star').innerHTML = icon('star');

  $('back').onclick = () => sn.cmd('back');
  $('forward').onclick = () => sn.cmd('forward');
  $('reload').onclick = () => sn.cmd(state && state.loading ? 'stop' : 'reload');
  $('settings').onclick = () => sn.cmd('settings');
  $('downloads').onclick = () => sn.cmd('downloadsFolder');
  $('newtab').onclick = () => sn.cmd('newTab');
  $('address').onclick = (e) => { if (!e.target.closest('#star')) sn.cmd('palette', true); };
  $('star').onclick = (e) => { e.stopPropagation(); sn.cmd('bookmark'); };
  $('shield').onclick = () => state && sn.cmd('adblockSite', !state.adblock.enabled);
  $('scrim').onclick = () => sn.cmd('palette', false);
}

const tabEls = new Map();

function renderTabs(s) {
  const list = $('tabs');
  const pinned = $('pinned');
  const seen = new Set();
  let prevPinned = null;
  let prevNormal = null;
  for (const t of s.tabs) {
    seen.add(t.id);
    let el = tabEls.get(t.id);
    const kind = t.pinned ? 'pin' : 'tab';
    if (!el || el.dataset.kind !== kind) {
      if (el) el.remove();
      el = document.createElement('div');
      el.dataset.kind = kind;
      el.dataset.id = t.id;
      el.className = kind === 'pin' ? 'pin-tab' : 'tab';
      el.draggable = true;
      wireTab(el, t.id);
      tabEls.set(t.id, el);
    }
    const sig = JSON.stringify([t.title, t.url, t.favicon, t.loading, t.audible, t.muted, t.crashed, t.sleeping, t.active]);
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.classList.toggle('active', t.active);
      el.classList.toggle('sleeping', t.sleeping && !t.active);
      el.title = `${t.title || t.url}${t.sleeping ? ' (sleeping)' : ''}`;
      const fav = favHtml(t, `${t.loading ? 'loading' : ''} ${t.crashed ? 'crashed' : ''}`);
      if (kind === 'pin') {
        el.innerHTML = fav;
      } else {
        const audio = t.audible || t.muted ? `<span class="audio" data-act="mute" title="${t.muted ? 'Unmute' : 'Mute'} (Ctrl+M)">${icon(t.muted ? 'muted' : 'speaker')}</span>` : '';
        el.innerHTML = `${fav}<span class="title">${esc(t.title || t.url || 'New tab')}</span>${audio}<span class="x" data-act="close" title="Close (Ctrl+W)">${icon('close')}</span>`;
      }
    }
    // Keep DOM order equal to the model's order.
    const parent = kind === 'pin' ? pinned : list;
    const prev = kind === 'pin' ? prevPinned : prevNormal;
    const want = prev ? prev.nextSibling : parent.firstChild;
    if (el.parentNode !== parent || want !== el) parent.insertBefore(el, want);
    if (kind === 'pin') prevPinned = el; else prevNormal = el;
  }
  for (const [id, el] of tabEls) if (!seen.has(id)) { el.remove(); tabEls.delete(id); }
  const active = tabEls.get(s.activeId);
  if (active && active.dataset.kind === 'tab') active.scrollIntoView({ block: 'nearest' });
}

let dragId = null;
function wireTab(el, id) {
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('[data-act]')) sn.cmd('activate', id);
  });
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    e.stopPropagation();
    if (act.dataset.act === 'close') sn.cmd('close', id);
    if (act.dataset.act === 'mute') sn.cmd('mute', id);
  });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); sn.cmd('close', id); } });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); sn.cmd('tabMenu', id); });
  el.addEventListener('dragstart', (e) => { dragId = id; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); clearDrop(); });
  el.addEventListener('dragover', (e) => {
    if (dragId === null || dragId === id) return;
    e.preventDefault();
    clearDrop();
    const r = el.getBoundingClientRect();
    const horizontal = document.body.classList.contains('pos-top') || el.dataset.kind === 'pin';
    const after = horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    el.classList.add(after ? 'drop-after' : 'drop-before');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragId === null || !state) return;
    const after = el.classList.contains('drop-after');
    clearDrop();
    const ids = state.tabs.map((t) => t.id).filter((x) => x !== dragId);
    let index = ids.indexOf(id) + (after ? 1 : 0);
    sn.cmd('move', dragId, index);
  });
}
function clearDrop() {
  for (const el of document.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
}

function renderChrome(s) {
  const body = document.body.classList;
  body.toggle('pos-top', s.tabsPosition === 'top');
  body.toggle('pos-left', s.tabsPosition !== 'top');
  body.toggle('no-chrome', s.fullscreen || (s.tabsPosition !== 'top' && !s.sidebarVisible));
  $('back').disabled = !s.canGoBack;
  $('forward').disabled = !s.canGoForward;
  $('reload').innerHTML = icon(s.loading ? 'stop' : 'reload');
  $('reload').title = s.loading ? 'Stop (Esc)' : 'Reload (Ctrl+R)';
  const httpish = /^https?:/.test(s.url);
  $('lock').innerHTML = icon(!s.url ? 'search' : s.secure ? 'lock' : httpish ? 'warn' : 'globe');
  $('lock').classList.toggle('insecure', httpish && !s.secure);
  $('lock').title = s.secure ? 'Secure connection' : httpish ? 'Not secure: this page is not encrypted' : '';
  $('host').textContent = s.host || (s.url ? s.url : 'Search or enter address');
  $('star').hidden = !httpish;
  $('star').classList.toggle('on', s.bookmarked);
  $('star').title = s.bookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark (Ctrl+D)';
  const shield = $('shield');
  shield.hidden = !httpish;
  shield.classList.toggle('off', !s.adblock.enabled);
  shield.innerHTML = icon(s.adblock.enabled ? 'shield' : 'shieldOff') + (s.adblock.enabled && s.adblock.blocked ? `<span>${s.adblock.blocked}</span>` : '');
  shield.title = s.adblock.enabled ? `Blocked ${s.adblock.blocked} ads and trackers here. Click to allow them on this site.` : 'Ad blocking is off for this site. Click to turn it on.';
  $('hover').textContent = s.hoverUrl || '';
  $('battery').innerHTML = s.onBattery ? `${icon('leaf')}<span>Battery saver</span>` : '';
  const active = (s.downloads || []).filter((d) => d.state === 'progressing').length;
  $('downloads').innerHTML = icon('download') + (active ? `<span class="dl-badge">${active}</span>` : '');
  renderTabs(s);
}

// ------------------------------------------------------------- palette ----

const pal = { open: false, newTab: false, items: [], sel: 0, query: '', seq: 0 };

function openPalette({ newTab, text }) {
  pal.open = true;
  pal.newTab = !!newTab;
  $('palette').hidden = false;
  const input = $('pinput');
  input.value = text || '';
  $('phint').textContent = newTab ? 'new tab' : (text ? 'Alt+Enter: new tab' : '');
  input.focus();
  input.select();
  query(input.value === (state && state.url) ? '' : input.value);
}

function closePaletteUi() {
  pal.open = false;
  $('palette').hidden = true;
  $('plist').innerHTML = '';
}

async function query(q) {
  const seq = ++pal.seq;
  pal.query = q;
  const local = await sn.invoke('suggest', q);
  if (seq !== pal.seq) return;
  pal.items = local || [];
  pal.sel = 0;
  renderList();
  if (q.trim() && !/^[a-z]+:\/\//i.test(q)) {
    const remote = await sn.invoke('suggestRemote', q);
    if (seq !== pal.seq || !remote || !remote.length) return;
    const have = new Set(pal.items.map((i) => i.title.toLowerCase()));
    pal.items = pal.items.concat(remote.filter((r) => !have.has(r.title.toLowerCase())));
    renderList();
  }
}

const KIND = { tab: ['tab', 'Switch to tab'], history: ['clock', ''], bookmark: ['bookmark', ''], search: ['search', ''], url: ['globe', ''] };

function renderList() {
  const ul = $('plist');
  ul.innerHTML = pal.items.map((it, i) => {
    const [ic, label] = KIND[it.type] || ['globe', ''];
    const lead = it.type === 'tab' || it.type === 'history' || it.type === 'bookmark'
      ? (it.favicon ? favHtml(it) : `<span class="ic">${icon(ic)}</span>`)
      : `<span class="ic">${icon(ic)}</span>`;
    const title = it.type === 'search' ? esc(it.title) : esc(it.title || it.url);
    const sub = it.type === 'search' ? (i === 0 ? 'Google' : '') : esc((it.url || '').replace(/^https?:\/\/(www\.)?/, ''));
    return `<li data-i="${i}" class="${i === pal.sel ? 'sel' : ''}">${lead}<span class="t">${title}</span><span class="u">${sub}</span><span class="k">${label}</span></li>`;
  }).join('');
}

function pick(i, { newTab = false } = {}) {
  const it = pal.items[i];
  const input = $('pinput').value.trim();
  if (!it) { if (input) sn.cmd('go', input, { newTab: pal.newTab || newTab }); return; }
  if (it.type === 'tab' && !newTab) { sn.cmd('activate', it.tabId); sn.cmd('palette', false); return; }
  sn.cmd('go', it.type === 'url' && it.typed ? it.typed : it.url, { newTab: pal.newTab || newTab });
}

if (VIEW === 'chrome') {
  const input = $('pinput');
  input.addEventListener('input', () => query(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      pal.sel = Math.min(pal.items.length - 1, pal.sel + 1); renderList();
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      pal.sel = Math.max(0, pal.sel - 1); renderList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(pal.sel, { newTab: e.altKey || e.shiftKey });
    }
  });
  $('plist').addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    pick(Number(li.dataset.i), { newTab: e.button === 1 });
  });
  sn.on('sn:palette', openPalette);
}

// --------------------------------------------------------------- float ----

let findText = '';

function renderFloat(s) {
  const root = $('float');
  const parts = [];
  if (s.find) {
    const f = s.find;
    const count = findText ? (f.matches ? `${f.active}/${f.matches}` : 'none') : '';
    parts.push(`<div class="card findbar" id="findcard"><input id="findinput" placeholder="Find in page" spellcheck="false" value="${esc(findText)}">
      <span class="count ${findText && !f.matches ? 'none' : ''}">${count}</span>
      <button class="btn" data-find="-1" title="Previous (Shift+Enter)">${icon('back')}</button>
      <button class="btn" data-find="1" title="Next (Enter)">${icon('forward')}</button>
      <button class="btn" data-find="close" title="Close (Esc)">${icon('close')}</button></div>`);
  }
  for (const p of s.prompts || []) {
    const ic = p.kind === 'password' ? 'key' : p.kind === 'auth' ? 'lock' : 'shield';
    const fields = (p.fields || []).map((f) => `<input name="${esc(f.name)}" type="${f.type === 'password' ? 'password' : 'text'}" placeholder="${esc(f.label)}">`).join('');
    parts.push(`<div class="card" data-prompt="${esc(p.id)}">
      <div class="head">${icon(ic)}<b>${esc(p.host)}</b></div>
      <div class="text">${esc(p.text)}</div>
      ${fields ? `<div class="fields">${fields}</div>` : ''}
      <div class="actions">${p.actions.map((a) => `<button data-action="${esc(a.id)}" class="${a.primary ? 'primary' : ''}">${esc(a.label)}</button>`).join('')}</div>
    </div>`);
  }
  for (const d of s.toasts || []) {
    const pct = d.total > 0 ? Math.round((d.received / d.total) * 100) : 0;
    const status = d.state === 'progressing' ? (d.paused ? 'Paused' : d.total > 0 ? `${pct}%` : `${(d.received / 1048576).toFixed(1)} MB`)
      : d.state === 'completed' ? 'Downloaded' : d.state === 'cancelled' ? 'Cancelled' : 'Failed';
    const acts = d.state === 'progressing'
      ? `<button data-dl="cancel">Cancel</button>`
      : d.state === 'completed' ? `<button data-dl="show">Show in folder</button><button data-dl="open" class="primary">Open</button>` : `<button data-dl="dismiss">Close</button>`;
    parts.push(`<div class="card" data-download="${d.id}">
      <div class="head">${icon('download')}<b>${esc(d.filename)}</b><span class="grow"></span><span>${status}</span></div>
      ${d.state === 'progressing' ? `<div class="progress"><i style="width:${d.total > 0 ? pct : 30}%"></i></div>` : ''}
      <div class="actions">${acts}</div></div>`);
  }
  const html = parts.join('');
  if (root.dataset.html === html) return;
  // Keep the find input (and its caret) when only the count changes.
  const focused = document.activeElement && document.activeElement.id === 'findinput';
  const caret = focused ? document.activeElement.selectionStart : null;
  const fieldValues = {};
  for (const inp of root.querySelectorAll('[data-prompt] input')) fieldValues[`${inp.closest('[data-prompt]').dataset.prompt}/${inp.name}`] = inp.value;
  root.dataset.html = html;
  root.innerHTML = html;
  root.hidden = !html;
  for (const inp of root.querySelectorAll('[data-prompt] input')) {
    const v = fieldValues[`${inp.closest('[data-prompt]').dataset.prompt}/${inp.name}`];
    if (v) inp.value = v;
  }
  const fi = $('findinput');
  if (fi && focused) { fi.focus(); fi.setSelectionRange(caret, caret); }
  const firstField = root.querySelector('[data-prompt] input');
  if (firstField && !focused && !root.contains(document.activeElement)) firstField.focus();
  reportSize();
}

function reportSize() {
  const root = $('float');
  const r = root.getBoundingClientRect();
  sn.cmd('floatSize', root.hidden ? 0 : Math.ceil(r.width) + 4, root.hidden ? 0 : Math.ceil(r.height) + 2);
}

if (VIEW === 'float') {
  const root = $('float');
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const card = btn.closest('.card');
    if (btn.dataset.find) {
      if (btn.dataset.find === 'close') sn.cmd('findClose');
      else sn.cmd('find', findText, { forward: btn.dataset.find === '1', findNext: true });
    } else if (btn.dataset.action && card.dataset.prompt) {
      const data = {};
      for (const inp of card.querySelectorAll('input')) data[inp.name] = inp.value;
      sn.cmd('prompt', card.dataset.prompt, btn.dataset.action, data);
    } else if (btn.dataset.dl && card.dataset.download) {
      sn.cmd('download', Number(card.dataset.download), btn.dataset.dl);
    }
  });
  root.addEventListener('input', (e) => {
    if (e.target.id !== 'findinput') return;
    findText = e.target.value;
    sn.cmd('find', findText, { forward: true, findNext: false });
  });
  root.addEventListener('keydown', (e) => {
    if (e.target.id === 'findinput' && e.key === 'Enter') {
      e.preventDefault();
      sn.cmd('find', findText, { forward: !e.shiftKey, findNext: true });
    } else if (e.key === 'Enter' && e.target.closest('[data-prompt]')) {
      const card = e.target.closest('[data-prompt]');
      const primary = card.querySelector('button.primary');
      if (primary) primary.click();
    }
  });
  sn.on('sn:find-open', () => {
    requestAnimationFrame(() => { const fi = $('findinput'); if (fi) { fi.focus(); fi.select(); } });
  });
  sn.on('sn:find-next', (dir) => sn.cmd('find', findText, { forward: dir > 0, findNext: true }));
  new ResizeObserver(reportSize).observe(root);
}

// --------------------------------------------------------------- state ----

sn.on('sn:state', (s) => {
  state = s;
  applyTheme(s.theme);
  if (VIEW === 'chrome') {
    renderChrome(s);
    if (!s.overlay && pal.open) closePaletteUi();
    if (!s.find) findText = '';
  } else {
    if (!s.find) findText = '';
    renderFloat(s);
  }
});
