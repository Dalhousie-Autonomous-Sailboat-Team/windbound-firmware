/*
 * Mission control: run the simulator, watch the boat in 3D, see what the
 * firmware believes and which link it obeys, change the wind, inject faults,
 * and follow this run's checks.
 */
import { command, on, section, store, theme, toast } from "/app.js";
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

export function initMission() {
  dial = new SailDial($("sail-dial"));
  bar = new RudderBar($("rudder-bar"));
  compass = new Compass($("compass"));
  loadScenarios();
  bindControls();
  on("sim", showSim);
  on("hello", (hello) => { if (view && hello.run === store.sim?.run) view.setTrack(hello.track); });
  on("proof", showFirmware);
  on("theme", (name) => view?.setTheme(name));
  on("section", (name) => {
    if (name === "mission") ensureView().then(() => view?.start());
    else view?.stop();
  });
}

/* three.js loads only when Mission control is first opened. */
function ensureView() {
  if (!viewLoading) {
    viewLoading = import("/scene3d.js").then(({ BoatView }) => {
      view = new BoatView({ stage: $("stage"), canvas: $("scene3d"), labels: $("labels3d"), legend: $("vec-legend"),
                            onFrame: (azimuth) => compass.orient(azimuth) });
      view.setTheme(theme());
      if (store.sim) return syncScene(store.sim);
    }).catch((error) => {
      $("view3d-meta").textContent = `The 3D view couldn't load: ${error.message}. It needs internet the first time.`;
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
  $("view3d-meta").textContent = view.modelNote;
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

function bindControls() {
  $("scenario").addEventListener("change", (e) => send({ action: "load", scenario: e.target.value }));
  $("sim-restart").addEventListener("click", () => send({ action: "restart" }));
  $("sim-step").addEventListener("click", () => send({ action: "step" }));
  $("sim-pause").addEventListener("click", () => {
    const sim = store.sim;
    if (!sim) return;
    send({ action: sim.finished ? "restart" : sim.running ? "pause" : "resume" });
  });
  for (const button of document.querySelectorAll("[data-speed]")) {
    button.addEventListener("click", () => {
      const value = button.dataset.speed;
      send({ action: "speed", speed: value === "max" ? "max" : Number(value) });
    });
  }
  for (const button of document.querySelectorAll("[data-camera]")) {
    button.addEventListener("click", () => {
      for (const b of document.querySelectorAll("[data-camera]")) b.setAttribute("aria-pressed", String(b === button));
      ensureView().then(() => view.setMode(button.dataset.camera));
    });
  }
  for (const button of document.querySelectorAll("[data-vectors]")) {
    button.addEventListener("click", () => {
      button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
      const groups = new Set([...document.querySelectorAll('[data-vectors][aria-pressed="true"]')]
        .map((b) => b.dataset.vectors));
      ensureView().then(() => view.setVectors(groups));
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

  const [text, alert] = finding(sim);
  $("mission-finding").textContent = text;
  $("mission-finding").classList.toggle("alert", alert);
  const label = sim.finished ? "Run again" : sim.running ? "Pause" : "Resume";
  $("sim-pause-label").textContent = label;
  $("sim-pause-icon").innerHTML = sim.running
    ? '<path d="M5 3.5h2v9H5zM9 3.5h2v9H9z" class="icon-fill"/>'
    : '<path d="M5 3.5 12.5 8 5 12.5z" class="icon-fill"/>';
  for (const b of document.querySelectorAll("[data-speed]")) {
    b.setAttribute("aria-pressed", String(b.dataset.speed === String(sim.speed)));
  }

  $("m-time").textContent = clock(s.t);
  $("m-time-of").textContent = `of ${clock(sim.duration_s)}`;
  $("m-time-meter").style.width = `${Math.min(100, (100 * s.t) / sim.duration_s)}%`;
  $("m-speed").textContent = (s.speed_ms * KNOTS).toFixed(2);
  $("m-speed-note").textContent = `${s.speed_ms.toFixed(2)} m/s · heel ${Math.abs(s.heel).toFixed(0)}°${
    Math.abs(s.heel) >= 0.5 ? (s.heel > 0 ? " to starboard" : " to port") : ""}`;
  const period = sim.autopilot_period_ms / 1000;
  $("m-ap").textContent = period.toFixed(1);
  $("m-ap-note").textContent = period >= 5
    ? "At 5 s the heading swings about ±55° (fine at 1 s)" : "Fast enough to hold a course";
  const checks = sim.checks;
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail");
  $("m-checks").textContent = `${passed}`;
  $("m-checks-small").textContent = `of ${checks.length} passing`;
  $("m-checks-note").textContent = failed.length ? `Failing: ${failed.map((c) => c.title.toLowerCase()).join("; ")}`
    : `${checks.filter((c) => c.status === "wait").length} waiting`;
  $("m-checks-note").classList.toggle("bad", failed.length > 0);

  // The 3D panel's instruments
  $("n-speed").textContent = (s.speed_ms * KNOTS).toFixed(2);
  $("n-heading").textContent = bearing(s.heading);
  $("n-heel").textContent = Math.abs(s.heel).toFixed(0);
  $("n-depth").textContent = s.depth === null ? "—" : s.depth.toFixed(1);
  $("n-depth-unit").textContent = s.depth === null ? "" : "m";
  $("n-wind").textContent = s.tws.toFixed(1);
  compass.draw(s);
  const toast3d = $("toast3d");
  const note = s.grounded_at !== null ? `Aground at ${clock(s.grounded_at)}` : sim.finished ? `Finished at ${clock(s.t)}` : "";
  toast3d.hidden = !note;
  toast3d.textContent = note;
  toast3d.classList.toggle("alert", s.grounded_at !== null);

  // Sail and rudder
  dial.draw(s);
  $("sail-true").textContent = `${signed(s.sail)}°`;
  $("sail-read").textContent = `${signed(s.sail_believed, 0)}° · encoder ${s.encoder}`;
  $("sail-target").textContent = `${signed(s.sail_target, 0)}°`;
  $("sail-motor").textContent = s.sail_motor > 0 ? "Channel 2 on" : s.sail_motor < 0 ? "Channel 1 on" : "Off";
  $("sail-pill").hidden = !s.encoder_stuck;
  $("sail-pill").textContent = "Encoder not updating";
  bar.draw(s);
  $("rudder-true").textContent = `${signed(s.rudder)}°`;
  $("rudder-target").textContent = `${signed(s.rudder_target, 0)}°`;
  $("rudder-pulse-m").textContent = `${s.rudder_pulse} µs`;
  $("rudder-pill").hidden = s.rudder_pulse_ok;
  $("rudder-pill").textContent = "Outside servo range";

  // What the firmware listens to
  for (const [axis, source, target] of [["sail", s.sail_source, s.sail_target], ["rudder", s.rudder_source, s.rudder_target]]) {
    const pill = $(`m-${axis}-src`);
    pill.textContent = SOURCE_NAMES[source];
    pill.className = `pill ${source === "rpi" ? "accent" : source === "none" ? "neg" : ""}`;
    $(`m-${axis}-src-sub`).textContent = source === "none" ? "no fresh link"
      : `target ${signed(target, 0)}°` + (source === "rpi" && s.xbee_valid ? ", the joystick sent 0" : "");
  }
  linkPill($("m-xbee"), s.xbee_valid, s.xbee_age);
  linkPill($("m-rpi"), s.rpi_valid, s.rpi_age);

  for (const toggle of document.querySelectorAll("[data-fault]")) {
    toggle.setAttribute("aria-checked", String(Boolean(s.faults[toggle.dataset.fault])));
  }
  syncWind(sim.wind_spec);
  drawLanes(sim);
  drawChecks(checks);
}

function linkPill(node, valid, ageMs) {
  if (ageMs === null) { node.textContent = "Never heard"; node.className = "pill"; }
  else if (valid) { node.textContent = `${age(ageMs / 1000)} ago`; node.className = "pill"; }
  else { node.textContent = `Timed out · ${age(ageMs / 1000)}`; node.className = "pill neg"; }
}

function syncWind(spec) {
  const fields = [["wdir", spec.from_deg, (v) => `${String(Math.round(v)).padStart(3, "0")}°`],
                  ["wspd", spec.speed_ms, (v) => `${v.toFixed(1)} m/s`],
                  ["wgust", spec.gust_ms, (v) => `±${v.toFixed(1)} m/s`]];
  for (const [id, value, format] of fields) {
    const input = $(id);
    if (document.activeElement === input) continue;
    input.value = value;
    $(`${id}-out`).textContent = format(value);
  }
}

/* Which link the firmware obeyed, for the sail and the rudder, over the run. */
function drawLanes(sim) {
  const svg = $("lanes");
  const x0 = 64, x1 = 714, span = Math.max(sim.duration_s, 1);
  const x = (t) => x0 + (Math.min(t, span) / span) * (x1 - x0);
  const parts = [];
  for (const [axis, y, label] of [["sail", 18, "Sail"], ["rudder", 52, "Rudder"]]) {
    parts.push(`<text x="0" y="${y + 15}">${label}</text>`);
    for (const [start, end, source] of sim.timeline[axis]) {
      const w = Math.max(x(end) - x(start), 1.5);
      parts.push(source === "none"
        ? `<rect class="seg-none" x="${x(start)}" y="${y + 1}" width="${w}" height="20" rx="3"/>`
        : `<rect class="seg-${source}" x="${x(start)}" y="${y}" width="${w}" height="22" rx="3"/>`);
    }
  }
  const now = x(sim.state.t);
  parts.push(`<line class="now" x1="${now}" y1="8" x2="${now}" y2="84"/>`);
  parts.push(`<line class="axis-line" x1="${x0}" y1="90" x2="${x1}" y2="90"/>`);
  const step = niceStep(span / 5);
  for (let t = 0; t <= span + 1e-6; t += step) {
    const anchor = t === 0 ? "start" : x(t) > x1 - 20 ? "end" : "middle";
    parts.push(`<text x="${x(t)}" y="110" text-anchor="${anchor}">${t === 0 ? "0" : clock(t)}</text>`);
  }
  svg.innerHTML = parts.join("");
  $("who-meta").textContent = `0 to ${clock(span)}`;
}

function niceStep(raw) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600];
  return steps.find((s) => s >= raw) || 3600;
}

const STATUS = { pass: ["Passed", "pos"], fail: ["Failed", "neg"], wait: ["Waiting", ""] };
function drawChecks(checks) {
  const list = $("run-checks");
  list.replaceChildren(...checks.map((c) => {
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
  const id = proof.identity;
  $("m-fw").textContent = id.commit || "—";
  $("m-fw-small").textContent = id.edited.length ? `+ ${id.edited.length} edited` : "";
  const build = proof.build;
  $("m-fw-note").textContent = build.state === "building" ? "Rebuilding…"
    : build.state === "failed" ? "The last rebuild failed; still running the previous build"
    : id.built_at ? `Built ${timeOfDay(id.built_at)}` : "Not built yet";
  $("m-fw-note").classList.toggle("bad", build.state === "failed");
}
