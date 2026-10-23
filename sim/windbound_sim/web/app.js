/*
 * Windbound: one page for the ground station and the simulator.
 *
 * This module holds what every section shares: the theme, the sections
 * (one visible at a time, chosen by the address's #hash), the live stream
 * from the service, commands back to it, where the ground station listens,
 * and Stop.
 */
import { initHelm } from "/helm.js";
import { initTelemetry } from "/telemetry.js";
import { initMission } from "/mission.js";
import { initChecks } from "/checks.js";

const $ = (id) => document.getElementById(id);

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

let toastTimer = null;
export function toast(text, ms = 4500) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ----- theme ------------------------------------------------------------ */
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
export const theme = () => document.documentElement.dataset.theme || (darkQuery.matches ? "dark" : "light");

function showTheme() {
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme()));
  }
  emit("theme", theme());
}
for (const button of document.querySelectorAll("[data-theme-choice]")) {
  button.addEventListener("click", () => {
    document.documentElement.dataset.theme = button.dataset.themeChoice;
    try { localStorage.setItem("windbound-theme", button.dataset.themeChoice); } catch (e) {}
    showTheme();
  });
}
darkQuery.addEventListener("change", showTheme);

/* ----- sections --------------------------------------------------------- */
const SECTIONS = ["helm", "telemetry", "mission", "checks"];
const TITLES = { helm: "Helm", telemetry: "Telemetry", mission: "Mission control", checks: "Firmware checks" };
export let section = null;

function showSection() {
  const wanted = location.hash.replace("#", "");
  const next = SECTIONS.includes(wanted) ? wanted : "mission";
  if (next === section) return;
  section = next;
  for (const view of document.querySelectorAll("[data-view]")) view.hidden = view.dataset.view !== section;
  for (const link of document.querySelectorAll("[data-section]")) {
    if (link.dataset.section === section) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  document.title = `${TITLES[section]} · Windbound`;
  closeNav();
  emit("section", section);
}
window.addEventListener("hashchange", showSection);

/* The sidebar folds into a drawer on narrow screens. */
const sidebar = $("sidebar"), scrim = $("nav-scrim"), menu = $("menu");
function closeNav() {
  sidebar.classList.remove("open");
  scrim.hidden = true;
  menu.setAttribute("aria-expanded", "false");
}
menu.addEventListener("click", () => {
  sidebar.classList.add("open");
  scrim.hidden = false;
  menu.setAttribute("aria-expanded", "true");
});
scrim.addEventListener("click", closeNav);

/* ----- where the ground station listens --------------------------------- */
const popover = $("connection");
async function openConnection(anchor) {
  const rect = anchor.getBoundingClientRect();
  popover.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 372))}px`;
  popover.style.top = `${rect.bottom + 6}px`;
  popover.hidden = false;
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
  button.setAttribute("aria-current", String(current));
  button.innerHTML = `<span class="dot ${name === "Simulator" ? "sim" : ""}" aria-hidden="true"></span>
    <span><b></b><span class="sub"></span></span>`;
  button.querySelector("b").textContent = name;
  button.querySelector(".sub").textContent = detail;
  button.addEventListener("click", onPick);
  li.append(button);
  return li;
}
async function connect(body) {
  try {
    await command("ground", body);
    popover.hidden = true;
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
    if (popover.hidden) openConnection(opener); else popover.hidden = true;
  });
}
document.addEventListener("click", (event) => {
  if (!popover.hidden && !popover.contains(event.target)) popover.hidden = true;
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { popover.hidden = true; closeNav(); } });

function showSource(ground) {
  const source = ground.source;
  const sim = source.kind === "sim";
  $("conn-name").textContent = source.name;
  $("conn-detail").textContent = sim ? "this service" : source.detail;
  $("scope-1").textContent = sim ? "Simulated boat" : "Live boat";
  $("scope-2").textContent = sim ? (store.sim?.title || "This service") : `${source.name} · ${source.detail}`;
  const dot = ground.error ? "bad" : sim ? "sim" : ground.telemetry_age_s === null && ground.status_age_s === null ? "off" : "";
  for (const id of ["conn-dot", "scope-dot"]) $(id).className = `dot ${dot}`;
  $("sim-chip").hidden = !sim;
  if (ground.error && ground.error !== lastError) toast(ground.error, 8000);
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
    toast("Stopping the real boat needs a STOP packet the controller firmware doesn't have yet.", 7000);
    return;
  }
  try {
    await command("sim", { action: "stop_boat" });
    toast("Silenced the joystick and the autopilot. The firmware stops the sail motor and centres the rudder once both time out, within 10 s.", 8000);
  } catch (error) { toast(`Couldn't stop: ${error.message}`); }
});
function disarm() {
  clearTimeout(stopArmed);
  stopArmed = null;
  $("stop").classList.remove("armed");
  $("stop-label").textContent = "Stop boat";
}

/* ----- the stream ------------------------------------------------------- */
function connectStream() {
  const stream = new EventSource("/api/stream");
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
    emit("proof", store.proof);
  });
  stream.onerror = () => { $("conn-dot").className = "dot bad"; };
}

showTheme();
initHelm();
initTelemetry();
initMission();
initChecks();
showSection();
connectStream();
