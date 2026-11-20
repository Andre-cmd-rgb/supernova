'use strict';
/* global supernova */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = (name, ...args) => supernova.invoke(name, ...args);

let settings = {};

function applyTheme(t) {
  if (!t) return;
  const r = document.documentElement.style;
  const map = { '--bg': 'background', '--bg2': 'dark_background', '--bg3': 'lighter_background', '--sel': 'selection', '--fg': 'foreground', '--fg2': 'light_foreground', '--fg3': 'dark_foreground', '--accent': 'accent', '--red': 'red' };
  for (const [v, k] of Object.entries(map)) if (t[k]) r.setProperty(v, t[k]);
}

async function loadSettings() {
  settings = await api('getSettings');
  for (const el of document.querySelectorAll('[data-setting]')) {
    const key = el.dataset.setting;
    let value = settings[key];
    if (el.dataset.sub) value = (value || {})[el.dataset.sub];
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = String(value ?? '');
  }
  renderAllowlist();
}

document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-setting]');
  if (!el) return;
  const key = el.dataset.setting;
  let value = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.number !== undefined || el.type === 'number') value = Number(value) || 0;
  if (el.dataset.sub) value = { ...(settings[key] || {}), [el.dataset.sub]: Math.max(0, Number(el.value) || 0) };
  await api('setSetting', key, value);
  settings[key] = value;
});

function renderAllowlist() {
  const list = settings['adblock.allowlist'] || [];
  $('#allowlist').innerHTML = list.length
    ? `<p class="muted">Ad blocking is off on: ${list.map((h) => `<b>${esc(h)}</b> <a href="#" data-unallow="${esc(h)}">turn back on</a>`).join(', ')}</p>`
    : '';
}
document.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-unallow]');
  if (!a) return;
  e.preventDefault();
  const list = (settings['adblock.allowlist'] || []).filter((h) => h !== a.dataset.unallow);
  await api('setSetting', 'adblock.allowlist', list);
  settings['adblock.allowlist'] = list;
  renderAllowlist();
});

// ----- default browser -----
async function refreshDefault() {
  const yes = await api('isDefaultBrowser');
  $('#default-state').textContent = yes ? 'Supernova is your default browser.' : 'Another browser opens links from other apps.';
  for (const b of document.querySelectorAll('[data-default]')) { b.disabled = yes; b.textContent = yes ? 'Default' : 'Make default'; }
}
for (const b of document.querySelectorAll('[data-default]')) {
  b.addEventListener('click', async () => { await api('setDefaultBrowser'); refreshDefault(); });
}

// ----- import -----
function whatToImport() {
  const what = {};
  for (const c of document.querySelectorAll('#what input')) what[c.name] = c.checked;
  return what;
}

function showResult(text, error = false) {
  const el = $('#import-result');
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle('error', error);
}

function describeReport(r) {
  const lines = [];
  if (r.passwords) lines.push(`Passwords: ${r.passwords.added} added, ${r.passwords.updated} updated${r.passwords.skipped ? `, ${r.passwords.skipped} already here` : ''}${r.passwords.failed ? `, ${r.passwords.failed} could not be read` : ''}`);
  if (typeof r.cookies === 'number' || (r.cookies && typeof r.cookies === 'object')) lines.push(`Logins: ${typeof r.cookies === 'number' ? r.cookies : r.cookies.imported ?? r.cookies.added ?? 0}`);
  if (r.bookmarks !== undefined) lines.push(`Bookmarks: ${typeof r.bookmarks === 'number' ? r.bookmarks : r.bookmarks.added ?? JSON.stringify(r.bookmarks)}`);
  if (r.history !== undefined) lines.push(`History: ${typeof r.history === 'number' ? r.history : r.history.added ?? JSON.stringify(r.history)}`);
  if (r.errors && r.errors.length) lines.push(`Problems: ${r.errors.join('; ')}`);
  return lines.join('\n');
}

async function loadProfiles() {
  let profiles = [];
  try { profiles = await api('detectProfiles'); } catch (err) { $('#profiles').innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }
  if (!profiles.length) { $('#profiles').innerHTML = '<p class="muted">No Chrome, Chromium, Brave, Vivaldi or Edge profile found on this computer.</p>'; return; }
  $('#profiles').innerHTML = profiles.map((p, i) => `<div class="row profile"><div><b>${esc(p.browser[0].toUpperCase() + p.browser.slice(1))}: ${esc(p.name)}</b>
    <small>${p.passwords != null ? `${p.passwords} passwords` : ''}${p.bookmarks != null ? ` · ${p.bookmarks} bookmarks` : ''}</small></div>
    <button class="button ${i === 0 ? 'primary' : ''}" data-profile="${esc(p.dir)}">Import</button></div>`).join('');
  for (const b of document.querySelectorAll('[data-profile]')) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Importing…';
      showResult('Importing… your keyring may ask to unlock Chrome\'s key.');
      try {
        const report = await api('importProfile', b.dataset.profile, whatToImport());
        showResult(describeReport(report));
        b.textContent = 'Imported';
        loadPasswords();
      } catch (err) {
        showResult(`Import failed: ${err.message.replace(/^Error invoking remote method 'sn:internal': (Error: )?/, '')}`, true);
        b.disabled = false;
        b.textContent = 'Import';
      }
    });
  }
}

$('#csv').addEventListener('click', async () => {
  try {
    const r = await api('importCsv');
    if (!r) return;
    showResult(`From ${r.file.split('/').pop()}: ${r.added} added, ${r.updated} updated, ${r.skipped} skipped.\nThe file holds your passwords in plain text.`);
    const del = document.createElement('button');
    del.className = 'button';
    del.textContent = 'Delete the file';
    del.style.marginTop = '8px';
    del.onclick = async () => { await api('deleteFile', r.file); del.replaceWith('Deleted.'); };
    $('#import-result').appendChild(document.createElement('br'));
    $('#import-result').appendChild(del);
    loadPasswords();
  } catch (err) {
    showResult(`Import failed: ${err.message}`, true);
  }
});

// ----- passwords -----
let allPasswords = [];
async function loadPasswords() {
  const info = await api('info');
  const v = info.vault || {};
  $('#vault-state').textContent = v.ok
    ? `${info.passwords} saved, encrypted with a key in your login keyring.`
    : `Passwords cannot be saved: the login keyring is not available (${v.backend || 'unknown'}).`;
  allPasswords = await api('passwords');
  $('#pw-filter').hidden = allPasswords.length < 8;
  renderPasswords();
}
function renderPasswords() {
  const f = $('#pw-filter').value.trim().toLowerCase();
  const list = allPasswords.filter((p) => !f || p.origin.toLowerCase().includes(f) || (p.username || '').toLowerCase().includes(f)).slice(0, 300);
  $('#passwords').innerHTML = list.map((p) => `<li><span><b>${esc(p.origin.replace(/^https?:\/\//, ''))}</b> <small>${esc(p.username || '(no username)')}</small></span><button class="button" data-remove="${esc(p.id)}">Remove</button></li>`).join('');
}
$('#pw-filter').addEventListener('input', renderPasswords);
$('#passwords').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  await api('removePassword', b.dataset.remove);
  loadPasswords();
});

// ----- permissions -----
async function loadSites() {
  const perms = await api('sitePermissions');
  const entries = Object.entries(perms);
  $('#sites').innerHTML = entries.length
    ? entries.map(([origin, p]) => `<li><span><b>${esc(origin.replace(/^https?:\/\//, ''))}</b> <small>${esc(Object.entries(p).map(([k, v]) => `${k.replace('media-', '')}: ${v}`).join(', '))}</small></span><button class="button" data-reset="${esc(origin)}">Reset</button></li>`).join('')
    : '<li><span class="muted">No site has asked for anything yet.</span></li>';
}
$('#sites').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-reset]');
  if (!b) return;
  await api('resetSite', b.dataset.reset);
  loadSites();
});

// ----- clear data -----
$('#clear').addEventListener('click', async () => {
  if (!confirm('Clear history, cookies and site data, and cached files?')) return;
  await api('clearData', { history: true, cookies: true, cache: true });
  $('#clear').textContent = 'Cleared';
});

// ----- about -----
async function loadAbout() {
  const i = await api('info');
  applyTheme(i.theme);
  const wv = i.widevine || {};
  $('#about').innerHTML = `Supernova ${esc(i.version)} · Electron ${esc(i.electron)} · Chromium ${esc(i.chrome)}<br>
    Widevine (Netflix, Spotify): ${wv.available ? esc(`${wv.status}${wv.version ? ` ${wv.version}` : ''}`) : 'not available in this build'}<br>
    ${i.onBattery ? 'On battery' : 'Plugged in'}${i.media ? ` · video cap ${i.media.maxHeight || 'none'}${i.media.maxFps ? `, ${i.media.maxFps} fps` : ''}${i.media.rafFps ? `, animations ${i.media.rafFps} fps` : ''}` : ''}<br>
    Profile: ${esc(i.userData)}`;
}

if (location.hash === '#welcome') $('#welcome').hidden = false;
loadAbout();
loadSettings();
refreshDefault();
loadProfiles();
loadPasswords();
loadSites();
if (location.hash && location.hash !== '#welcome') document.querySelector(location.hash)?.scrollIntoView();
