// The icon set, shared with the Windbound ground station's web UI: 24px
// outline icons with one small animation each, played when the control
// holding them is hovered or focused, or when play() is called. Markup uses
// <i data-ic="name"></i>; hydrate() swaps those for the SVGs. The simulator's
// own icons (helm, checks, the transport, full screen, keyboard, stop) are
// at the end.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const I = {
  sail: '<path d="M3.5 18.5h17l-2.4 2.6H5.9z"/><path d="M11 3v15.5"/><path class="i-sail" d="M11 4.2c3.8 2.4 6.6 6.6 7.4 12.3H11z"/><path class="i-jib" d="M9.6 6.5 5 16.5h4.6z"/>',
  route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path class="i-path" pathLength="1" d="M8 18h5.5a3.5 3.5 0 0 0 0-7h-3a3.5 3.5 0 0 1 0-7H16"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path class="i-chev" d="m7.5 9.5 3 2.5-3 2.5"/><path class="i-cursor" d="M12.5 15h4"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 3.5V8H8"/><path class="i-hand" d="M12 7.5V12l3 2"/>',
  sliders: '<path d="M4 7h16M4 17h16"/><circle class="i-k1 fill" cx="15" cy="7" r="2.4"/><circle class="i-k2 fill" cx="9" cy="17" r="2.4"/>',
  search: '<g class="i-lensg"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></g>',
  refresh: '<g class="i-spin"><path d="M20 11.5A8 8 0 0 0 6.3 6.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 12.5a8 8 0 0 0 13.7 5.2l2.3-2.2"/><path d="M20 20v-4.5h-4.5"/></g>',
  plug: '<g class="i-plug"><path d="M9 3v4M15 3v4"/><path d="M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0z"/></g><path d="M12 16v5"/>',
  radio: '<circle class="fill" cx="12" cy="12" r="1.7"/><path class="i-w1" d="M8.6 15.4a4.8 4.8 0 0 1 0-6.8M15.4 8.6a4.8 4.8 0 0 1 0 6.8"/><path class="i-w2" d="M5.7 18.3a8.9 8.9 0 0 1 0-12.6M18.3 5.7a8.9 8.9 0 0 1 0 12.6"/>',
  record: '<circle cx="12" cy="12" r="8.5"/><circle class="i-dot fill" cx="12" cy="12" r="3.6"/>',
  download: '<path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/><g class="i-arrow"><path d="M12 4v10.5"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/></g>',
  send: '<g class="i-plane"><path d="M20.5 3.5 10.5 13.5"/><path d="M20.5 3.5 14.2 20.5l-3.7-7-7-3.7z"/></g>',
  undo: '<g class="i-undo"><path d="M4 9h11a5 5 0 0 1 0 10h-4"/><path d="m8 5-4 4 4 4"/></g>',
  trash: '<g class="i-lid"><path d="M4 6.5h16"/><path d="M9.5 6.5V4.5h5v2"/></g><path d="M6.5 6.5 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.5"/><path d="M10 10.5v6M14 10.5v6"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><g class="i-rays"><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></g>',
  moon: '<path class="i-moon" d="M19.5 14.6A7.8 7.8 0 1 1 9.4 4.5a6.2 6.2 0 0 0 10.1 10.1z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/><path class="i-scan" d="M7 8.3h6"/>',
  pin: '<g class="i-pin"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></g>',
  layers: '<path class="i-l1" d="m12 3 9 5-9 5-9-5z"/><path d="m3 12.5 9 5 9-5"/><path class="i-l3" d="m3 16.5 9 5 9-5"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path class="i-needle" d="m15.5 8.5-2 5-5 2 2-5z"/>',
  wind: '<path class="i-w1" d="M3 8h10.5a2.5 2.5 0 1 0-2.5-2.5"/><path class="i-w2" d="M3 12h15.5a2.5 2.5 0 1 1-2.5 2.5"/><path class="i-w3" d="M3 16h7"/>',
  copy: '<g class="i-copyg"><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/></g><path class="i-check" pathLength="1" d="m6.5 12.5 3.5 3.5 7.5-8"/>',
  check: '<path class="i-draw" pathLength="1" d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path class="i-x" d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  'chev-up': '<path d="m6 15 6-6 6 6"/>',
  updown: '<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>',
  'arrow-ur': '<g class="i-arr"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></g>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  crosshair: '<circle cx="12" cy="12" r="7"/><path class="i-ch" d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/><circle class="fill" cx="12" cy="12" r="1.5"/>',
  activity: '<path class="i-beat" pathLength="1" d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  alert: '<g class="i-shake"><path d="M10.3 4.3 2.6 17.6a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/></g>',
  map: '<path d="M9 4.5 3.5 6.5v13L9 17.5l6 2 5.5-2v-13L15 6.5z"/><path d="M9 4.5v13M15 6.5v13"/>',
  grip: '<circle class="fill" cx="9" cy="6" r="1.4"/><circle class="fill" cx="15" cy="6" r="1.4"/><circle class="fill" cx="9" cy="12" r="1.4"/><circle class="fill" cx="15" cy="12" r="1.4"/><circle class="fill" cx="9" cy="18" r="1.4"/><circle class="fill" cx="15" cy="18" r="1.4"/>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
  more: '<circle class="fill" cx="6" cy="12" r="1.5"/><circle class="fill" cx="12" cy="12" r="1.5"/><circle class="fill" cx="18" cy="12" r="1.5"/>',
  cube: '<g class="i-cube"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></g>',
  enter: '<path d="M19 5v7a3 3 0 0 1-3 3H6"/><path d="m9.5 11.5-3.5 3.5 3.5 3.5"/>',
  // the simulator's
  helm: '<circle cx="12" cy="12" r="1.8" class="fill"/><g class="i-wheel"><circle cx="12" cy="12" r="6.2"/><path d="M12 2.5v3.3M12 18.2v3.3M2.5 12h3.3M18.2 12h3.3M5.3 5.3l2.3 2.3M16.4 16.4l2.3 2.3M5.3 18.7l2.3-2.3M16.4 7.6l2.3-2.3"/></g>',
  checks: '<rect x="4.5" y="4.5" width="15" height="16.5" rx="2.2"/><path d="M9 4.5V3.2h6v1.3"/><path class="i-tick" pathLength="1" d="m8.5 13 2.6 2.6 4.6-5.1"/>',
  pause: '<g class="i-bars"><rect class="fill" x="6.5" y="5" width="3.8" height="14" rx="1"/><rect class="fill" x="13.7" y="5" width="3.8" height="14" rx="1"/></g>',
  play: '<path class="fill i-play" d="M8 5.3v13.4a.9.9 0 0 0 1.4.8l10.2-6.7a.9.9 0 0 0 0-1.5L9.4 4.5A.9.9 0 0 0 8 5.3z"/>',
  step: '<g class="i-step"><path class="fill" d="M5.5 6.2v11.6a.8.8 0 0 0 1.2.7l8.4-5.8a.8.8 0 0 0 0-1.4L6.7 5.5a.8.8 0 0 0-1.2.7z"/><path d="M18.5 5.5v13"/></g>',
  restart: '<g class="i-back"><path d="M4.5 4.5V9H9"/><path d="M4.9 9a7.5 7.5 0 1 1-.4 5"/></g>',
  expand: '<g class="i-out"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></g>',
  shrink: '<g class="i-in"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/></g>',
  keyboard: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.2"/><path d="M6.5 9.5h.01M10 9.5h.01M14 9.5h.01M17.5 9.5h.01M6.5 12.5h.01M17.5 12.5h.01"/><path class="i-space" d="M9 14.8h6"/>',
  stop: '<path class="i-oct" d="M8.3 2.8h7.4l5.5 5.5v7.4l-5.5 5.5H8.3l-5.5-5.5V8.3z"/><path d="M8.2 12h7.6"/>',
  gamepad: '<path d="M7.5 7h9a4.5 4.5 0 0 1 4.4 5.4l-.8 4a2.6 2.6 0 0 1-4.5 1.2L14 16h-4l-1.6 1.6a2.6 2.6 0 0 1-4.5-1.2l-.8-4A4.5 4.5 0 0 1 7.5 7z"/><path d="M8 10.5v3M6.5 12h3"/><circle class="fill i-btn" cx="16" cy="11.2" r="1.1"/>',
};
export const ic = (n, cls = '', id = '') => `<svg class="ic ic-${n} ${cls}"${id ? ` id="${id}"` : ''} viewBox="0 0 24 24" aria-hidden="true">${I[n] || ''}</svg>`;
export function hydrate(root = document) { $$('i[data-ic]', root).forEach(el => { el.outerHTML = ic(el.dataset.ic, el.className, el.id); }); }
export function play(el) { if (!el) return; el.classList.remove('play'); void el.offsetWidth; el.classList.add('play'); setTimeout(() => el.classList.remove('play'), 900); }
