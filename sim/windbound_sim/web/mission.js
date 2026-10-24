/*
 * Mission control: run the simulator, watch the boat in 3D (full screen if
 * you like), see what the firmware believes and which link it obeys, change
 * the wind and the autopilot's rate, inject faults, and follow this run's
 * checks.
 *
 * Keys (when no field has focus): Space pause or resume, . step one control
 * tick, F full screen, 1 2 3 orbit, chase and top cameras.
 */
import { command, on, paintRange, section, store, theme, toast } from "/app.js";
import { Compass, RudderBar, SailDial } from "/instruments.js";
import { KNOTS, SOURCE_NAMES, age, bearing, clock, signed, timeOfDay } from "/format.js";

const $ = (id) => document.getElementById(id);
let view = null;            // the 3D view, loaded on first visit
let viewLoading = null;
let sceneRun = null;
let dial, bar, compass;
let lastRoute = "";
let lastDraw = 0;
const DRAW_INTERVAL_MS = 100;   // panels redraw at 10 Hz; the 3D view takes every snapshot
const ICONS = {
  pause: '<path d="M5 3.5h2v9H5zM9 3.5h2v9H9z" class="icon-fill"/>',
  play: '<path d="M5 3.5 12.5 8 5 12.5z" class="icon-fill"/>',
  again: '<path d="M3.5 3v4h4M3.9 6.8A5 5 0 1 1 3.2 9.5" class="icon-stroke"/>',
  enter: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" class="icon-stroke"/>',
  leave: '<path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" class="icon-stroke"/>',
};

/* Set text only when it changes, so a 10 Hz redraw doesn't touch the page needlessly. */
function text(id, value) {
  const node = $(id);
  if (node.textContent !== value) node.textContent = value;
  return node;
}

export function initMission() {
  dial = new SailDial($("sail-dial"));
  bar = new RudderBar($("rudder-bar"));
  compass = new Compass($("compass"));
  loadScenarios();
  bindControls();
  bindFullscreen();
  on("sim", showSim);
  on("hello", (hello) => { if (view && hello.run === store.sim?.run) view.setTrack(hello.track); });
  on("proof", showFirmware);
  on("theme", (name) => view?.setTheme(name));
  on("section", (name) => {
    if (name === "mission") ensureView().then(() => view?.start());
    else { view?.stop(); leaveFullscreen(); }
  });
}

/* three.js loads only when Mission control is first opened. */
function ensureView() {
  if (!viewLoading) {
    viewLoading = import("/scene3d.js").then(({ BoatView }) => {
      view = new BoatView({ stage: $("stage"), canvas: $("scene3d"), labels: $("labels3d"), legend: $("vec-legend"),
                            onFrame: (azimuth) => compass.orient(azimuth) });
      view.setTheme(theme());
      if (new URLSearchParams(location.search).has("debug")) window.windbound = { view };   // for the console
      if (store.sim) return syncScene(store.sim);
    }).catch((error) => {
      const note = $("stage-note");
      note.textContent = `The 3D view couldn't load (${error.message}). It loads three.js from the internet the first time you open it.`;
      note.hidden = false;
    });
  }
  return viewLoading;
}

async function syncScene(sim) {
  if (!view || sceneRun === sim.run) return;
  sceneRun = sim.run;
  lastRoute = "";
  const info = await (await fetch("/api/scene")).json();
  await view.setScene(info);
  if (store.hello?.run === sim.run) view.setTrack(store.hello.track);
  text("view3d-meta", view.modelWarning || "");
  // A paused or finished run sends no more snapshots, so place the boat from the last one now.
  if (store.sim?.run === sim.run) showSim(store.sim);
}

async function loadScenarios() {
  const scenarios = await (await fetch("/api/scenarios")).json();
  $("scenario").replaceChildren(...scenarios.map((s) => {
    const option = new Option(s.title, s.name);
    option.title = s.description;
    return option;
  }));
  if (store.sim) $("scenario").value = store.sim.scenario;
}

async function send(body) {
  try { await command("sim", body); } catch (error) { toast(`The simulator refused that: ${error.message}`); }
}

function togglePause() {
  const sim = store.sim;
  if (sim) send({ action: sim.finished ? "restart" : sim.running ? "pause" : "resume" });
}

function setCamera(mode) {
  for (const b of document.querySelectorAll("[data-camera]")) b.setAttribute("aria-pressed", String(b.dataset.camera === mode));
  ensureView().then(() => view?.setMode(mode));
}

function bindControls() {
  $("scenario").addEventListener("change", (e) => send({ action: "load", scenario: e.target.value }));
  $("sim-restart").addEventListener("click", () => send({ action: "restart" }));
  $("sim-step").addEventListener("click", () => send({ action: "step" }));
  $("sim-pause").addEventListener("click", togglePause);
  for (const button of document.querySelectorAll("[data-speed]")) {
    button.addEventListener("click", () => {
      const value = button.dataset.speed;
      send({ action: "speed", speed: value === "max" ? "max" : Number(value) });
    });
  }
  for (const button of document.querySelectorAll("[data-ap]")) {
    button.addEventListener("click", () => send({ action: "autopilot", period_ms: Number(button.dataset.ap) }));
  }
  for (const button of document.querySelectorAll("[data-camera]")) {
    button.addEventListener("click", () => setCamera(button.dataset.camera));
  }
  for (const button of document.querySelectorAll("[data-vectors]")) {
    button.addEventListener("click", () => {
      button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
      const groups = new Set([...document.querySelectorAll('[data-vectors][aria-pressed="true"]')]
        .map((b) => b.dataset.vectors));
      ensureView().then(() => view?.setVectors(groups));
    });
  }
  for (const toggle of document.querySelectorAll("[data-fault]")) {
    toggle.addEventListener("click", () => {
      const on = toggle.getAttribute("aria-checked") !== "true";
      toggle.setAttribute("aria-checked", String(on));
      send({ action: "fault", name: toggle.dataset.fault, on });
    });
  }
  const wind = { wdir: ["from_deg", (v) => `${String(v).padStart(3, "0")}°`],
                 wspd: ["speed_ms", (v) => `${Number(v).toFixed(1)} m/s`],
                 wgust: ["gust_ms", (v) => `±${Number(v).toFixed(1)} m/s`] };
  for (const [id, [key, format]] of Object.entries(wind)) {
    const input = $(id);
    input.addEventListener("input", () => { $(`${id}-out`).textContent = format(input.value); });
    input.addEventListener("change", () => send({ action: "wind", [key]: Number(input.value) }));
  }
  document.addEventListener("keydown", (event) => {
    if (section !== "mission" || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target.closest?.("input, select, textarea, [contenteditable]")) return;
    const actions = {
      " ": togglePause, ".": () => send({ action: "step" }), f: toggleFullscreen,
      1: () => setCamera("orbit"), 2: () => setCamera("chase"), 3: () => setCamera("top"),
    };
    const action = actions[event.key.toLowerCase()];
    if (!action || (event.key === " " && event.target.closest?.("button"))) return;
    event.preventDefault();
    action();
  });
}

/* ----- full screen ------------------------------------------------------------ */

/* The run panel (3D view, transport and timeline) fills the screen. Browsers
   without element full screen get the same layout over the window. */
function bindFullscreen() {
  $("fullscreen").addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", showFullscreen);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("run").classList.contains("expanded")) leaveFullscreen();
  });
}
function isFullscreen() { return document.fullscreenElement === $("run") || $("run").classList.contains("expanded"); }
async function toggleFullscreen() {
  const run = $("run");
  if (isFullscreen()) { leaveFullscreen(); return; }
  try {
    if (!run.requestFullscreen) throw new Error("no element full screen");
    await run.requestFullscreen({ navigationUI: "hide" });
  } catch (error) {
    run.classList.add("expanded");
  }
  showFullscreen();
}
function leaveFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $("run").classList.remove("expanded");
  showFullscreen();
}
function showFullscreen() {
  const full = isFullscreen();
  const button = $("fullscreen");
  button.setAttribute("aria-pressed", String(full));
  button.setAttribute("aria-label", full ? "Leave full screen" : "Full screen");
  button.title = full ? "Leave full screen (F or Esc)" : "Full screen (F)";
  $("fullscreen-icon").innerHTML = full ? ICONS.leave : ICONS.enter;
  document.body.classList.toggle("run-expanded", $("run").classList.contains("expanded"));
}

/* ----- drawing a snapshot -------------------------------------------------- */

function finding(sim) {
  const s = sim.state, wp = s.waypoint;
  if (s.grounded_at !== null) {
    const where = s.depth === null ? "on the shore" : `in ${s.depth.toFixed(1)} m of water`;
    return [`Aground at ${clock(s.grounded_at)} ${where}, under the 2.0 m draft.`, true];
  }
  if (s.encoder_stuck && s.sail_motor !== 0) return ["The sail encoder has stopped updating and the firmware is still driving the sail motor.", true];
  if (s.sail_source === "none" && s.rudder_source === "none" && (s.xbee_age !== null || s.rpi_age !== null))
    return ["No fresh commands: the firmware has stopped the sail motor and centred the rudder.", true];
  if (!s.rudder_pulse_ok) return [`The rudder pulse is ${s.rudder_pulse} µs, outside the servo's 1000–2000 µs.`, true];
  const who = s.sail_source === s.rudder_source ? `${SOURCE_NAMES[s.sail_source]} steering`
    : `Sail from the ${SOURCE_NAMES[s.sail_source].toLowerCase()}, rudder from the ${SOURCE_NAMES[s.rudder_source].toLowerCase()}`;
  if (sim.finished) return [`Finished at ${clock(s.t)}. ${who}.`, false];
  if (wp && wp.reached >= wp.count) return [`${who}. Course complete: all ${wp.count} waypoints reached.`, false];
  if (wp) return [`${who}. Waypoint ${wp.index + 1} of ${wp.count}, ${Math.round(wp.distance_m)} m to go.`, false];
  return [`${who}. ${sim.description}`, false];
}

function showSim(sim) {
  const s = sim.state;
  if ($("scenario").value !== sim.scenario && $("scenario").options.length) $("scenario").value = sim.scenario;
  if (view) {
    syncScene(sim);
    if (sceneRun === sim.run) {
      view.push(s, sim.speed === "max" ? 60 : sim.speed);
      const route = JSON.stringify(sim.route);
      if (route !== lastRoute) { lastRoute = route; view.setRoute(sim.route, sim.origin); }
      if (s.waypoint) view.course.progress(s.waypoint.index, s.waypoint.reached);
    }
  }
  const now = performance.now();
  if (section !== "mission" || now - lastDraw < DRAW_INTERVAL_MS) return;
  lastDraw = now;

  const [line, alert] = finding(sim);
  text("mission-finding", line).classList.toggle("alert", alert);
  text("run-finding", line).classList.toggle("alert", alert);
  text("run-h", sim.title);
  const state = sim.finished ? "again" : sim.running ? "pause" : "play";
  if ($("sim-pause").dataset.state !== state) {
    $("sim-pause").dataset.state = state;
    $("sim-pause-icon").innerHTML = ICONS[state];
    text("sim-pause-label", { again: "Run again", pause: "Pause", play: "Resume" }[state]);
  }
  for (const b of document.querySelectorAll("[data-speed]")) {
    b.setAttribute("aria-pressed", String(b.dataset.speed === String(sim.speed)));
  }
  text("m-time", clock(s.t));
  text("m-time-of", ` / ${clock(sim.duration_s)}`);

  // The 3D panel's instruments
  text("n-speed", (s.speed_ms * KNOTS).toFixed(2));
  text("n-heading", bearing(s.heading));
  text("n-heel", Math.abs(s.heel).toFixed(0));
  text("n-depth", s.depth === null ? "—" : s.depth.toFixed(1));
  text("n-depth-unit", s.depth === null ? "" : "m");
  text("n-wind", s.tws.toFixed(1));
  compass.draw(s);
  const toast3d = $("toast3d");
  const note = s.grounded_at !== null ? `Aground at ${clock(s.grounded_at)}` : sim.finished ? `Finished at ${clock(s.t)}` : "";
  toast3d.hidden = !note;
  text("toast3d", note).classList.toggle("alert", s.grounded_at !== null);

  // Sail and rudder
  dial.draw(s);
  text("sail-true", `${signed(s.sail)}°`);
  text("sail-read", `${signed(s.sail_believed, 0)}° · encoder ${s.encoder}`);
  text("sail-target", `${signed(s.sail_target, 0)}°`);
  const motor = s.sail_motor > 0 ? "Channel 2 on" : s.sail_motor < 0 ? "Channel 1 on" : "Off";
  text("sail-motor", motor);
  $("sail-pill").hidden = !s.encoder_stuck;
  text("sail-pill", "Encoder not updating");
  bar.draw(s);
  text("rudder-true", `${signed(s.rudder)}°`);
  text("rudder-target", `${signed(s.rudder_target, 0)}°`);
  text("rudder-pulse-m", `${s.rudder_pulse} µs`);
  $("rudder-pill").hidden = s.rudder_pulse_ok;
  text("rudder-pill", "Outside servo range");

  // What the firmware listens to, in the panel and on the full-screen view
  for (const [axis, source] of [["sail", s.sail_source], ["rudder", s.rudder_source]]) {
    for (const id of [`m-${axis}-src`, `fs-${axis}-src`]) {
      const pill = text(id, SOURCE_NAMES[source]);
      pill.className = `pill ${source === "rpi" ? "accent" : source === "none" ? "neg" : ""}`;
    }
  }
  const zeroed = [["sail", s.sail_source], ["rudder", s.rudder_source]]
    .filter(([, source]) => source === "rpi" && s.xbee_valid).map(([axis]) => axis);
  $("m-arbitration").hidden = !zeroed.length;
  text("m-arbitration", zeroed.length ? `The joystick is sending 0 for the ${zeroed.join(" and ")}, which the firmware reads as no command, so the autopilot keeps it.` : "");
  text("fs-sail", source0(s.sail_source, `${signed(s.sail_target, 0)}° · motor ${motor.toLowerCase()}`));
  text("fs-rudder", source0(s.rudder_source, `${signed(s.rudder_target, 0)}° · ${s.rudder_pulse} µs`));
  linkPill($("m-xbee"), s.xbee_valid, s.xbee_age);
  linkPill($("m-rpi"), s.rpi_valid, s.rpi_age);
  text("fs-xbee", $("m-xbee").textContent);
  const pilot = sim.autopilot || {};
  text("m-rpi-sub", [pilot.name || "autopilot", pilot.mode, "times out after 10 s"].filter(Boolean).join(" · "));
  text("fs-rpi", [$("m-rpi").textContent, pilot.mode].filter(Boolean).join(" · "));

  for (const toggle of document.querySelectorAll("[data-fault]")) {
    toggle.setAttribute("aria-checked", String(Boolean(s.faults[toggle.dataset.fault])));
  }
  syncWind(sim.wind_spec);
  for (const b of document.querySelectorAll("[data-ap]")) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.ap) === sim.autopilot_period_ms));
  }
  text("m-ap-note", sim.autopilot_period_ms >= 5000 ? "At 5 s the heading swings about ±55°"
    : sim.autopilot_period_ms >= 2000 ? "Slow: the heading wanders" : "Fast enough to hold a course");
  drawLanes(sim);
  drawChecks(sim.checks);
}

const source0 = (source, detail) => (source === "none" ? "motor off · rudder centred" : detail);

function linkPill(node, valid, ageMs) {
  const [word, kind] = ageMs === null ? ["Never heard", ""] : valid ? [`${age(ageMs / 1000)} ago`, ""]
    : [`Timed out · ${age(ageMs / 1000)}`, "neg"];
  if (node.textContent !== word) node.textContent = word;
  node.className = `pill ${kind}`;
}

function syncWind(spec) {
  const fields = [["wdir", spec.from_deg, (v) => `${String(Math.round(v)).padStart(3, "0")}°`],
                  ["wspd", spec.speed_ms, (v) => `${v.toFixed(1)} m/s`],
                  ["wgust", spec.gust_ms, (v) => `±${v.toFixed(1)} m/s`]];
  for (const [id, value, format] of fields) {
    const input = $(id);
    if (document.activeElement === input) continue;
    if (Number(input.value) !== value) { input.value = value; paintRange(input); }
    text(`${id}-out`, format(value));
  }
}

/* ----- who steered, second by second ------------------------------------------ */

/* Which link the firmware obeyed for the sail and the rudder, across the run,
   with the playhead at the simulation's time. Segments only ever grow or get
   added at the end, so a redraw touches the last one or two. */
const lanes = { run: null, span: 0, sail: { first: null, nodes: [] }, rudder: { first: null, nodes: [] } };

function drawLanes(sim) {
  const span = Math.max(sim.duration_s, 1);
  if (lanes.run !== sim.run || lanes.span !== span) {
    Object.assign(lanes, { run: sim.run, span });
    for (const axis of ["sail", "rudder"]) { $(`lane-${axis}`).replaceChildren(); lanes[axis] = { first: null, nodes: [] }; }
    const step = niceStep(span / 5);
    const ticks = [];
    for (let t = 0; t <= span + 1e-6; t += step) {
      const tick = document.createElement("span");
      tick.textContent = t === 0 ? "0" : clock(t);
      tick.style.left = `${(100 * t) / span}%`;
      tick.className = t === 0 ? "first" : t + step > span + 1e-6 && (100 * t) / span > 92 ? "last" : "";
      ticks.push(tick);
    }
    $("lane-ticks").replaceChildren(...ticks);
  }
  for (const axis of ["sail", "rudder"]) {
    const segments = sim.timeline[axis], lane = lanes[axis], track = $(`lane-${axis}`);
    if (!segments.length) continue;
    if (lane.first !== segments[0][0] || segments.length < lane.nodes.length) {
      track.replaceChildren();
      Object.assign(lane, { first: segments[0][0], nodes: [] });
    }
    for (let i = Math.max(lane.nodes.length - 2, 0); i < segments.length; i++) {
      const [start, end, source] = segments[i];
      let node = lane.nodes[i];
      if (!node) {
        node = document.createElement("i");
        node.className = `seg seg-${source}`;
        track.append(node);
        lane.nodes.push(node);
      }
      node.style.left = `${(100 * start) / span}%`;
      node.style.width = `${(100 * Math.max(end - start, 0)) / span}%`;
    }
  }
  $("playhead").style.left = `${Math.min(100, (100 * sim.state.t) / span)}%`;
}

function niceStep(raw) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600];
  return steps.find((s) => s >= raw) || 3600;
}

/* ----- this run's checks ------------------------------------------------------ */

const STATUS = { pass: ["Passed", "pos"], fail: ["Failed", "neg"], wait: ["Waiting", ""] };
let lastChecks = "";
function drawChecks(checks) {
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  text("m-checks", failed ? `${failed} failing · ${passed} of ${checks.length} passing` : `${passed} of ${checks.length} passing`)
    .classList.toggle("bad", failed > 0);
  const key = JSON.stringify(checks);
  if (key === lastChecks) return;
  lastChecks = key;
  $("run-checks").replaceChildren(...checks.map((c) => {
    const li = document.createElement("li");
    const [word, kind] = STATUS[c.status];
    li.innerHTML = `<span class="pill ${kind}">${word}</span><span class="grow"><span class="t"></span><span class="sub"></span></span>`;
    li.querySelector(".t").textContent = c.title;
    li.querySelector(".sub").textContent = c.detail;
    return li;
  }));
}

/* ----- the firmware build -------------------------------------------------- */

function showFirmware(proof) {
  const id = proof.identity, build = proof.build, checks = proof.checks;
  const results = checks.results;
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  text("m-suite", checks.state === "running" ? "The full suite is running…"
    : results.length ? `Last full run, ${timeOfDay(checks.finished)}: ${count("passed")} passed, ${count("known")} known issues, ${count("failed")} failing.`
    : "The full suite runs the firmware's unit tests, every scenario and its properties.")
    .classList.toggle("bad", count("failed") > 0 && checks.state !== "running");
  const link = $("m-fw");
  const edited = id.edited.length ? ` + ${id.edited.length} edited` : "";
  link.textContent = build.state === "building" ? "Rebuilding…"
    : build.state === "failed" ? "Rebuild failed · running the previous build"
    : `${id.commit || "Uncommitted"}${edited}${id.built_at ? ` · built ${timeOfDay(id.built_at)}` : ""}`;
  link.classList.toggle("bad", build.state === "failed");
}
