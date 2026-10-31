/*
 * The frame's floating parts, as in the Windbound ground station's web UI:
 * toasts and the ⌘K command menu. Sections add their commands with
 * addCommands(); app.js wires the menu's button and key.
 */
import { $, $$, ic, play } from "/icons.js";

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ----- toasts --------------------------------------------------------------- */
/* A message's first sentence is its title and the rest its detail, so the
   simulator's one-line explanations read like the ground station's toasts.
   tone: pos (done), info, warn (can't do that yet) or neg (it failed). */
export function toast(text, ms = 4500, tone = "pos") {
  const box = $("#toasts");
  const [head, ...rest] = String(text).split(/(?<=[.:])\s+(?=[A-Z])/);
  const title = rest.length ? head.replace(/[.:]$/, "") : head;
  const el = document.createElement("div");
  el.className = `toast ${tone}`;
  el.setAttribute("role", tone === "neg" || tone === "warn" ? "alert" : "status");
  const icon = tone === "neg" || tone === "warn" ? "alert" : "check";
  el.innerHTML = `${ic(icon)}<div><div class="tt">${esc(title)}</div>${rest.length ? `<div class="td">${esc(rest.join(" "))}</div>` : ""}</div><button class="x ica" type="button" aria-label="Dismiss">${ic("x")}</button>`;
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  let timer;
  const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 260); };
  const arm = () => { timer = setTimeout(close, Math.max(ms, tone === "neg" ? 7000 : 0)); };
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", arm);
  $(".x", el).addEventListener("click", close);
  arm();
  $(".ic-alert", el)?.classList.add("shake");
  return el;
}

/* ----- command menu --------------------------------------------------------- */
/* Each command: { g: group, l: label (or a function giving it), ic: icon,
   k: keys to show, hint: () => text, when: () => offered now, run }. */
const commands = [];
export function addCommands(list) { commands.push(...list); }
let cmdk = null, cmdIdx = 0, cmdList = [], opener = null;
const label = (c) => (typeof c.l === "function" ? c.l() : c.l);
function fuzzy(text, q) {
  if (!q) return true;
  text = text.toLowerCase();
  let i = 0;
  for (const ch of q.toLowerCase()) { i = text.indexOf(ch, i); if (i < 0) return false; i++; }
  return true;
}
export const cmdkOpen = () => Boolean(cmdk);
export function openCmdk() {
  if (cmdk) return;
  opener = document.activeElement;
  cmdk = document.createElement("div");
  cmdk.className = "cmdk";
  cmdk.innerHTML = `<div class="cmdk-box" role="dialog" aria-modal="true" aria-label="Command menu"><div class="cmdk-in">${ic("search")}<input id="cmdk-q" placeholder="Search screens and actions" autocomplete="off" spellcheck="false" aria-label="Search screens and actions" aria-controls="cmdk-l"><kbd>Esc</kbd></div><div class="cmdk-list scroll-thin" id="cmdk-l" role="listbox"></div><div class="cmdk-ft"><span><kbd>↑</kbd><kbd>↓</kbd>to move</span><span><kbd>↵</kbd>to run</span><span class="end">Windbound simulator</span></div></div>`;
  document.body.append(cmdk);
  cmdk.addEventListener("pointerdown", (e) => { if (e.target === cmdk) closeCmdk(); });
  const q = $("#cmdk-q");
  q.addEventListener("input", () => { cmdIdx = 0; renderCmdk(); });
  q.addEventListener("keydown", cmdKeys);
  q.focus();
  renderCmdk();
}
export function closeCmdk() {
  if (!cmdk) return;
  cmdk.remove();
  cmdk = null;
  opener?.focus?.({ preventScroll: true });
}
function renderCmdk() {
  const q = $("#cmdk-q").value.trim();
  cmdList = commands.filter((c) => (!c.when || c.when()) && fuzzy(`${label(c)} ${c.g}`, q));
  let html = "", group = null;
  cmdList.forEach((c, i) => {
    if (c.g !== group) { group = c.g; html += `<div class="cmdk-g">${esc(group)}</div>`; }
    const hint = c.hint ? c.hint() : "";
    html += `<button class="cmdk-it ica${i === cmdIdx ? " is-active" : ""}" type="button" role="option" aria-selected="${i === cmdIdx}" data-i="${i}">${ic(c.ic)}<span class="grow">${esc(label(c))}</span>${hint ? `<span class="hint">${esc(hint)}</span>` : ""}${c.k ? `<span class="keys">${c.k.map((k) => `<kbd>${esc(k)}</kbd>`).join("")}</span>` : ""}</button>`;
  });
  const list = $("#cmdk-l");
  list.innerHTML = html || `<div class="cmdk-empty">Nothing matches “${esc(q)}”.</div>`;
  $$(".cmdk-it", list).forEach((b) => {
    b.addEventListener("mousemove", () => { if (cmdIdx !== +b.dataset.i) { cmdIdx = +b.dataset.i; markCmd(); } });
    b.addEventListener("click", () => runCmd(+b.dataset.i));
  });
  markCmd(true);
}
function markCmd(silent) {
  $$(".cmdk-it").forEach((b) => {
    const isOn = +b.dataset.i === cmdIdx;
    b.classList.toggle("is-active", isOn);
    b.setAttribute("aria-selected", String(isOn));
    if (isOn) { if (!silent) play(b); b.scrollIntoView({ block: "nearest" }); }
  });
}
function cmdKeys(e) {
  const n = Math.max(cmdList.length, 1);
  if (e.key === "ArrowDown") { e.preventDefault(); cmdIdx = (cmdIdx + 1) % n; markCmd(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); cmdIdx = (cmdIdx - 1 + n) % n; markCmd(); }
  else if (e.key === "Enter") { e.preventDefault(); runCmd(cmdIdx); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCmdk(); }
}
function runCmd(i) {
  const c = cmdList[i];
  if (!c) return;
  opener = null;
  closeCmdk();
  setTimeout(c.run, 30);
}
