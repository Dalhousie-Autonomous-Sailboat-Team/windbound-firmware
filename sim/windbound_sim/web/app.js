/*
 * Windbound: one page for the ground station and the simulator.
 *
 * This module holds what every section shares: the theme, the sections
 * (one visible at a time, chosen by the address's #hash, shown as tabs),
 * the live stream from the service, commands back to it, where the ground
 * station listens, the command menu, and Stop.
 */
import { hydrate, ic, play } from "/icons.js";
import { addCommands, closeCmdk, cmdkOpen, openCmdk, toast } from "/shell.js";
import { initHelm } from "/helm.js";
import { initTelemetry } from "/telemetry.js";
import { initMission } from "/mission.js";
import { initChecks } from "/checks.js";

const $ = (id) => document.getElementById(id);
hydrate();     // <i data-ic> become the icon set's SVGs before anything looks them up
export { toast };

/* ----- inside the ground station ------------------------------------------ */
/* With ?embed the page shows only the simulator's screens, inside the
   ground station's web UI, which draws the bar and the tabs around them.
   They talk by message, only with the local page named in ?parent: it sends
   the theme and the screen to show; this page sends the screen it moved to,
   its failing-check count, and ⌘K. */
export const embedded = document.documentElement.hasAttribute("data-embed");
const parentOrigin = (() => {
  const named = new URLSearchParams(location.search).get("parent") || "";
  return embedded && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(named) ? named : null;
})();
const tellParent = (type, data = {}) => { if (parentOrigin) window.parent.postMessage({ type, ...data }, parentOrigin); };

/* ----- the live store --------------------------------------------------- */
export const store = { hello: null, sim: null, ground: null, groundAt: 0, proof: null };
const listeners = { sim: [], ground: [], proof: [], hello: [], theme: [], section: [] };
export const on = (event, fn) => listeners[event].push(fn);
const emit = (event, value) => listeners[event].forEach((fn) => fn(value));

/* ----- commands --------------------------------------------------------- */
export async function command(area, body) {
  const response = await fetch(`/api/${area}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch (e) {}
    throw new Error(message);
  }
}

/* ----- sliders ---------------------------------------------------------- */
/* Range inputs draw their filled part from a custom property: from zero on
   a slider that runs either side of zero (sail, rudder), else from its
   minimum. Call after setting a slider's value from code. */
export function paintRange(input) {
  const min = Number(input.min || 0), max = Number(input.max || 100), value = Number(input.value);
  const at = (x) => `${(((x - min) / (max - min)) * 100).toFixed(2)}%`;
  const origin = min < 0 && max > 0 ? 0 : min;
  input.style.setProperty("--lo", at(Math.min(origin, value)));
  input.style.setProperty("--hi", at(Math.max(origin, value)));
}
document.addEventListener("input", (event) => { if (event.target.matches?.('input[type="range"]')) paintRange(event.target); });
for (const input of document.querySelectorAll('input[type="range"]')) paintRange(input);

/* ----- theme ------------------------------------------------------------ */
/* System, light or dark, as in the ground station. Where the browser can, a
   change spreads out from the button in a circle; otherwise colours fade. */
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
export const theme = () => document.documentElement.dataset.theme || (darkQuery.matches ? "dark" : "light");
const themeChoice = () => document.documentElement.dataset.theme || "system";

function showTheme() {
  for (const b of document.querySelectorAll("[data-theme-set]")) {
    b.setAttribute("aria-checked", String(b.dataset.themeSet === themeChoice()));
  }
  emit("theme", theme());
}

function setTheme(choice) {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  if (embedded) { showTheme(); return; }      // the ground station keeps the choice
  try {
    if (choice === "system") localStorage.removeItem("windbound-theme");
    else localStorage.setItem("windbound-theme", choice);
  } catch (e) {}
  showTheme();
}

async function chooseTheme(choice, from) {
  if (choice === themeChoice()) return;
  const before = theme();
  if (!document.startViewTransition || reduceMotion.matches || !from) { setTheme(choice); return; }
  const rect = from.getBoundingClientRect();
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  // The new page is live during the transition, so the 3D view redraws in the new light as it spreads.
  const transition = document.startViewTransition(() => setTheme(choice));
  if (theme() === before) return;           // e.g. dark to system on a dark system: nothing to spread
  await transition.ready;
  document.documentElement.animate(
    { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
    { duration: 520, easing: "cubic-bezier(.16, 1, .3, 1)", pseudoElement: "::view-transition-new(root)" });
}
for (const b of document.querySelectorAll("[data-theme-set]")) {
  b.addEventListener("click", () => chooseTheme(b.dataset.themeSet, b));
}
darkQuery.addEventListener("change", showTheme);

/* ----- segmented controls -------------------------------------------------- */
/* In a group that holds one choice, a thumb slides to the chosen option. */
function initSegments() {
  for (const seg of document.querySelectorAll(".seg:not([data-multi])")) {
    const thumb = Object.assign(document.createElement("span"), { className: "seg-thumb" });
    thumb.setAttribute("aria-hidden", "true");
    seg.prepend(thumb);
    seg.classList.add("has-thumb");
    const place = (animate) => {
      const pressed = seg.querySelector('button[aria-pressed="true"]');
      thumb.style.opacity = pressed && pressed.offsetWidth ? "1" : "0";
      if (!pressed || !pressed.offsetWidth) return;
      if (!animate) thumb.style.transition = "none";
      thumb.style.width = `${pressed.offsetWidth}px`;
      thumb.style.transform = `translateX(${pressed.offsetLeft}px)`;
      if (!animate) { void thumb.offsetWidth; thumb.style.transition = ""; }
    };
    new MutationObserver(() => place(true)).observe(seg, { subtree: true, attributeFilter: ["aria-pressed"] });
    new ResizeObserver(() => place(false)).observe(seg);
    place(false);
  }
}

/* ----- sections --------------------------------------------------------- */
const SECTIONS = embedded ? ["mission", "checks"] : ["helm", "telemetry", "mission", "checks"];
const TITLES = { helm: "Helm", telemetry: "Telemetry", mission: "Mission control", checks: "Firmware checks" };
export let section = null;

function showSection() {
  const wanted = location.hash.replace("#", "");
  const next = SECTIONS.includes(wanted) ? wanted : "mission";
  if (next === section) return;
  const first = section === null;
  section = next;
  const sheet = $("sheet");
  for (const view of document.querySelectorAll("[data-view]")) view.hidden = view.dataset.view !== section;
  sheet.prepend(sheet.querySelector(`[data-view="${section}"]`));   // the shown screen's h1 comes first
  for (const link of document.querySelectorAll("[data-section]")) {
    if (link.dataset.section === section) {
      link.setAttribute("aria-current", "page");
      if (!first) play(link);
    } else link.removeAttribute("aria-current");
  }
  document.title = `${TITLES[section]} · Windbound`;
  window.scrollTo(0, 0);
  tellParent("windbound:section", { name: section });
  emit("section", section);
}
window.addEventListener("hashchange", showSection);
const go = (name) => { location.hash = `#${name}`; };

/* ----- where the ground station listens --------------------------------- */
const popover = $("connection");
function closeConnection() {
  popover.hidden = true;
  for (const opener of document.querySelectorAll("[data-open-connection]")) opener.setAttribute("aria-expanded", "false");
}
async function openConnection(anchor) {
  const rect = anchor.getBoundingClientRect();
  popover.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 12, window.innerWidth - 372))}px`;
  popover.style.top = `${rect.bottom + 6}px`;
  popover.hidden = false;
  anchor.setAttribute("aria-expanded", "true");
  $("conn-error").textContent = "";
  const source = store.ground?.source || { kind: "sim" };
  const choices = $("conn-choices");
  choices.replaceChildren(choice("Simulator", "The simulated boat in this service", source.kind === "sim",
                                 () => connect({ action: "simulator" })));
  try {
    const ports = await (await fetch("/api/ports")).json();
    for (const port of ports) {
      choices.append(choice(port.device, port.stlink ? `${port.description} · ST-Link` : port.description,
                            source.kind === "serial" && source.name === port.device,
                            () => connect({ action: "connect", url: port.device, baud: Number($("conn-baud").value) })));
    }
    if (!ports.length) {
      const li = document.createElement("li");
      li.innerHTML = '<span class="hint">No serial ports found. Plug in the controller\'s ST-Link.</span>';
      choices.append(li);
    }
  } catch (e) { /* the list stays with the simulator only */ }
  popover.querySelector("button")?.focus();
}
function choice(name, detail, current, onPick) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pop-item ica";
  button.setAttribute("aria-current", String(current));
  button.innerHTML = `${ic(name === "Simulator" ? "cube" : "plug")}<span class="grow"><span class="nm"></span><span class="s"></span></span>${current ? ic("check") : ""}`;
  button.querySelector(".nm").textContent = name;
  button.querySelector(".s").textContent = detail;
  button.addEventListener("click", onPick);
  li.append(button);
  return li;
}
async function connect(body) {
  try {
    await command("ground", body);
    closeConnection();
  } catch (error) {
    $("conn-error").textContent = `Couldn't connect: ${error.message}`;
  }
}
$("conn-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const url = $("conn-url").value.trim();
  if (url) connect({ action: "connect", url, baud: Number($("conn-baud").value) });
});
for (const opener of document.querySelectorAll("[data-open-connection]")) {
  opener.addEventListener("click", (event) => {
    event.stopPropagation();
    if (popover.hidden) openConnection(opener); else closeConnection();
  });
}
document.addEventListener("click", (event) => {
  if (!popover.hidden && !popover.contains(event.target)) closeConnection();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (parentOrigin) tellParent("windbound:cmdk");        // the ground station's menu
    else if (cmdkOpen()) closeCmdk(); else { closeConnection(); if (shortcuts.open) shortcuts.close(); openCmdk(); }
    return;
  }
  if (event.key === "Escape") closeConnection();
  if (event.key === "?" && !cmdkOpen() && !event.target.closest?.("input, select, textarea")) { event.preventDefault(); openKeys(); }
});

/* ----- keyboard shortcuts ------------------------------------------------- */
const shortcuts = $("shortcuts");
function openKeys() { if (!shortcuts.open) shortcuts.showModal(); }
$("shortcuts-open").addEventListener("click", openKeys);
$("shortcuts-close").addEventListener("click", () => shortcuts.close());
shortcuts.addEventListener("click", (event) => { if (event.target === shortcuts) shortcuts.close(); });   // the backdrop

function showSource(ground) {
  const source = ground.source;
  const sim = source.kind === "sim";
  $("conn-name").textContent = source.name;
  $("conn-detail").textContent = sim ? "this service" : source.detail;
  $("conn").title = sim ? `Simulated boat · ${store.sim?.title || "this service"}` : `Live boat · ${source.name} · ${source.detail}`;
  const dot = ground.error ? "bad" : sim ? "sim" : ground.telemetry_age_s === null && ground.status_age_s === null ? "off" : "";
  $("conn-dot").className = `dot ${dot}`;
  $("sim-chip").hidden = !sim;
  if (ground.error && ground.error !== lastError) toast(ground.error, 8000, "neg");
  lastError = ground.error;
}
let lastError = null;

/* ----- Stop ------------------------------------------------------------- */
let stopArmed = null;
$("stop").addEventListener("click", async () => {
  const stop = $("stop");
  if (!stopArmed) {
    stop.classList.add("armed");
    $("stop-label").textContent = "Click again to stop";
    stopArmed = setTimeout(disarm, 3000);
    return;
  }
  disarm();
  if (store.ground?.source.kind !== "sim") {
    toast("Stopping the real boat needs a STOP packet the controller firmware doesn't have yet.", 7000, "warn");
    return;
  }
  try {
    await command("sim", { action: "stop_boat" });
    toast("Silenced the joystick and the autopilot. The firmware stops the sail motor and centres the rudder once both time out, within 10 s.", 8000);
  } catch (error) { toast(`Couldn't stop: ${error.message}`, 7000, "neg"); }
});
function disarm() {
  clearTimeout(stopArmed);
  stopArmed = null;
  $("stop").classList.remove("armed");
  $("stop-label").textContent = "Stop boat";
}

/* ----- the stream ------------------------------------------------------- */
/* If the service stops, the page says so and keeps trying; when it is back,
   the stream starts over with a fresh hello. */
let online = true;
function setOnline(now) {
  if (now === online) return;
  online = now;
  $("offline").hidden = now;
  document.body.classList.toggle("offline", !now);
  if (now) toast("Reconnected to the Windbound service.", 3000);
}
function connectStream() {
  const stream = new EventSource("/api/stream");
  stream.onopen = () => setOnline(true);
  stream.addEventListener("hello", (event) => {
    store.hello = JSON.parse(event.data);
    $("side-note").textContent = store.hello.link_port
      ? `Desktop ground station: socket://127.0.0.1:${store.hello.link_port}` : "";
    emit("hello", store.hello);
  });
  stream.addEventListener("sim", (event) => {
    store.sim = JSON.parse(event.data);
    document.body.classList.remove("pending");
    emit("sim", store.sim);
  });
  stream.addEventListener("ground", (event) => {
    store.ground = JSON.parse(event.data);
    store.groundAt = performance.now();
    showSource(store.ground);
    emit("ground", store.ground);
  });
  stream.addEventListener("proof", (event) => {
    store.proof = JSON.parse(event.data);
    tellParent("windbound:checks", { failing: store.proof.checks.results.filter((r) => r.outcome === "failed").length });
    emit("proof", store.proof);
  });
  stream.onerror = () => {
    $("conn-dot").className = "dot bad";
    setOnline(false);
    if (stream.readyState === EventSource.CLOSED) setTimeout(connectStream, 2000);
  };
}

/* ----- the command menu --------------------------------------------------- */
/* Every command is a control already on the page, so the menu does exactly
   what the button does. */
const click = (id) => () => $(id).click();
const inMission = (fn) => () => { if (section !== "mission") { go("mission"); setTimeout(fn, 120); } else fn(); };
const pressed = (selector) => () => document.querySelector(selector)?.getAttribute("aria-pressed") === "true";
addCommands([
  { g: "Go to", l: "Helm", ic: "helm", run: () => go("helm") },
  { g: "Go to", l: "Telemetry", ic: "activity", run: () => go("telemetry") },
  { g: "Go to", l: "Mission control", ic: "cube", run: () => go("mission") },
  { g: "Go to", l: "Firmware checks", ic: "checks", run: () => go("checks") },
  { g: "Run", l: () => $("sim-pause-label").textContent, ic: "pause", k: ["Space"], when: () => Boolean(store.sim), run: click("sim-pause") },
  { g: "Run", l: "Step one control tick", ic: "step", k: ["."], run: click("sim-step") },
  { g: "Run", l: "Restart the scenario", ic: "restart", run: click("sim-restart") },
  ...[["1", "Real time"], ["5", "5×"], ["20", "20×"], ["max", "As fast as possible"]].map(([speed, name]) => ({
    g: "Run", l: `Speed: ${name}`, ic: "activity", when: () => !pressed(`[data-speed="${speed}"]`)(),
    run: () => document.querySelector(`[data-speed="${speed}"]`).click() })),
  { g: "Scenario", l: "Choose a scenario", ic: "route", hint: () => store.sim?.title || "",
    run: inMission(() => { $("scenario").focus(); $("scenario").showPicker?.(); }) },
  ...["orbit", "chase", "top"].map((mode, i) => ({
    g: "3D view", l: `${mode[0].toUpperCase()}${mode.slice(1)} camera`, ic: "compass", k: [String(i + 1)],
    run: inMission(() => document.querySelector(`[data-camera="${mode}"]`).click()) })),
  ...[["forces", "forces"], ["wind", "wind"], ["motion", "motion"]].map(([group, name]) => ({
    g: "3D view", l: () => `${pressed(`[data-vectors="${group}"]`)() ? "Hide" : "Show"} the ${name} arrows`, ic: "activity",
    run: inMission(() => document.querySelector(`[data-vectors="${group}"]`).click()) })),
  { g: "3D view", l: "Full screen", ic: "expand", k: ["F"], run: inMission(() => $("fullscreen").click()) },
  { g: "Firmware", l: "Run every check", ic: "checks", when: () => !$("fw-check").disabled,
    run: () => { go("checks"); setTimeout(() => $("fw-check").click(), 60); } },
  { g: "Firmware", l: "Rebuild and reload", ic: "refresh", when: () => !$("fw-rebuild").disabled,
    run: () => { go("checks"); setTimeout(() => $("fw-rebuild").click(), 60); } },
  { g: "Boat", l: "Stop the boat", ic: "stop", hint: () => "asks you to confirm", run: () => { $("stop").click(); $("stop").focus(); } },
  { g: "Boat", l: "Send the route", ic: "send", when: () => !$("route-send").disabled, run: click("route-send") },
  { g: "Connection", l: "Listen to the simulator", ic: "cube", when: () => store.ground?.source.kind !== "sim",
    run: () => command("ground", { action: "simulator" }).catch((e) => toast(`Couldn't connect: ${e.message}`, 7000, "neg")) },
  { g: "Connection", l: "Choose where the ground station listens", ic: "plug", run: () => openConnection($("conn")) },
  { g: "Theme", l: "Use the system theme", ic: "monitor", when: () => themeChoice() !== "system", run: () => chooseTheme("system") },
  { g: "Theme", l: "Use the light theme", ic: "sun", when: () => themeChoice() !== "light", run: () => chooseTheme("light") },
  { g: "Theme", l: "Use the dark theme", ic: "moon", when: () => themeChoice() !== "dark", run: () => chooseTheme("dark") },
  { g: "Help", l: "Keyboard shortcuts", ic: "keyboard", k: ["?"], run: openKeys },
]);
$("search").addEventListener("click", openCmdk);
if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
  $("cmd-key").textContent = "Ctrl K";
  for (const k of document.querySelectorAll(".cmd-mod")) k.textContent = "Ctrl";
}

if (embedded) {
  // No bar of its own, so Stop sits with the run's other controls.
  document.querySelector("#view-mission .title-actions").append($("stop"));
  window.addEventListener("message", (event) => {
    if (!parentOrigin || event.source !== window.parent || event.origin !== parentOrigin) return;
    const { type, theme: choice, name } = event.data || {};
    if (type === "windbound:theme" && ["system", "light", "dark"].includes(choice)) setTheme(choice);
    else if (type === "windbound:section" && SECTIONS.includes(name) && name !== section) location.hash = `#${name}`;
  });
}

showTheme();
initSegments();
initHelm();
initTelemetry();
initMission();
initChecks();
showSection();
connectStream();
