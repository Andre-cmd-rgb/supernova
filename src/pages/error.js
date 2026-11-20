'use strict';
const q = new URLSearchParams(location.search);
const url = q.get('url') || '';
const code = Number(q.get('code') || 0);
const desc = q.get('desc') || '';

const WHY = {
  '-105': ['This site can\'t be found', 'Check the address for a typo. The server\'s name did not resolve.'],
  '-106': ['You\'re offline', 'Check your Wi-Fi or cable, then try again.'],
  '-109': ['This site can\'t be reached', 'The address is unreachable.'],
  '-118': ['This site took too long to respond', 'The server may be busy or down.'],
  '-102': ['This site refused to connect', 'Nothing is listening at that address, or a firewall said no.'],
  '-101': ['The connection was reset', 'Try again in a moment.'],
  '-137': ['This site can\'t be found', 'The name could not be resolved.'],
  '-21': ['The network changed', 'Try again.'],
  '-7': ['This site took too long to respond', 'The connection timed out.'],
};

let title = 'This page can\'t be opened';
let why = 'Something went wrong while loading it.';
if (WHY[String(code)]) [title, why] = WHY[String(code)];
else if (code <= -200 && code > -300) {
  title = 'Your connection to this site is not private';
  why = 'Its certificate is not valid, so someone could be reading or changing what you send. Supernova does not let you continue.';
}

document.title = title;
document.getElementById('title').textContent = title;
document.getElementById('url').textContent = url;
document.getElementById('why').textContent = why;
document.getElementById('code').textContent = `${desc || 'ERR'} (${code})`;
document.getElementById('retry').addEventListener('click', () => { if (url) location.href = url; });
if (code <= -200 && code > -300) document.getElementById('retry').hidden = true;

(async () => {
  try {
    const t = await window.supernova.invoke('theme');
    const r = document.documentElement.style;
    const map = { '--bg': 'background', '--bg2': 'dark_background', '--bg3': 'lighter_background', '--sel': 'selection', '--fg': 'foreground', '--fg2': 'light_foreground', '--fg3': 'dark_foreground', '--accent': 'accent', '--red': 'red' };
    for (const [v, k] of Object.entries(map)) if (t && t[k]) r.setProperty(v, t[k]);
  } catch {}
})();
