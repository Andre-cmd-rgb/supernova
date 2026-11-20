'use strict';
// Line icons, 16 px, stroke = currentColor. Drawn by hand for Supernova.
window.ICONS = {
  back: '<path d="M10 3 5 8l5 5"/>',
  forward: '<path d="m6 3 5 5-5 5"/>',
  reload: '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5V5h-2.5"/>',
  stop: '<path d="m4 4 8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  close: '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>',
  lock: '<rect x="4" y="7.2" width="8" height="6" rx="1.2"/><path d="M5.8 7.2V5.6a2.2 2.2 0 0 1 4.4 0v1.6"/>',
  globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.8 1.6 2.6 3.5 2.6 5.5S9.8 11.9 8 13.5C6.2 11.9 5.4 10 5.4 8S6.2 4.1 8 2.5"/>',
  warn: '<path d="M8 2.8 14 13H2L8 2.8Z"/><path d="M8 6.5v3M8 11.2v.1"/>',
  star: '<path d="m8 2.6 1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.3l-3.4 1.8.7-3.8L2.5 6.6l3.8-.5L8 2.6Z"/>',
  shield: '<path d="M8 2.2 13 4v4c0 3-2.2 5-5 5.8C5.2 13 3 11 3 8V4l5-1.8Z"/>',
  shieldOff: '<path d="M8 2.2 13 4v4c0 3-2.2 5-5 5.8C5.2 13 3 11 3 8V4l5-1.8Z"/><path d="m3 3 10 10"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6"/>',
  download: '<path d="M8 2.5v8M4.8 7.6 8 10.8l3.2-3.2M3 13.5h10"/>',
  speaker: '<path d="M3 6.2h2.2L8.4 3.6v8.8L5.2 9.8H3z"/><path d="M10.6 6a2.8 2.8 0 0 1 0 4M12.2 4.4a5 5 0 0 1 0 7.2"/>',
  muted: '<path d="M3 6.2h2.2L8.4 3.6v8.8L5.2 9.8H3z"/><path d="m10.5 6.3 3.2 3.4M13.7 6.3l-3.2 3.4"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2.2 1.4"/>',
  bookmark: '<path d="M4.5 2.5h7v11L8 11l-3.5 2.5z"/>',
  tab: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M2.5 6.5h11"/>',
  leaf: '<path d="M3 13c0-6 3.5-9.5 10-10-.3 6.6-3.8 10-10 10Z"/><path d="M3 13 9 7"/>',
  sleep: '<path d="M10.5 3.2A5 5 0 1 0 12.8 10 4 4 0 0 1 10.5 3.2Z"/>',
  pin: '<path d="M6 2.5h4l-.6 4 2.1 2H4.5l2.1-2L6 2.5ZM8 8.5V14"/>',
  key: '<circle cx="5.5" cy="10.5" r="2.5"/><path d="m7.3 8.7 5.2-5.2M10.5 5.5l1.5 1.5M11.8 4.2l1.3 1.3"/>',
  camera: '<rect x="2" y="4.5" width="9" height="7" rx="1.5"/><path d="m11 7 3-1.8v5.6L11 9"/>',
};

window.icon = function icon(name, cls = '') {
  const body = window.ICONS[name] || '';
  return `<svg class="svg ${cls}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
};
