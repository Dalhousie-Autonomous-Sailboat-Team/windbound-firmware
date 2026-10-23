/*
 * The Helm: where the boat is going, and who is steering it.
 *
 * Everything here comes through the ground station: the controller's lines
 * and the 1 Hz telemetry. In simulator mode the page also knows what the
 * firmware decided (the simulator reports it), so "Boat uses" and the link
 * ages are exact; with a real controller those wait for telemetry v2.
 */
import { command, on, paintRange, section, store, theme, toast } from "/app.js";
import { LakeMap } from "/map.js";
import { SOURCE_NAMES, age, bearing, latlon, metres, pointOfSail, signed, windSide, wrap180 } from "/format.js";

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const SEND_INTERVAL_MS = 120;
const GAMEPAD_DEADZONE = 0.12;

let map = null;
let route = [];                 // the route as edited here: [{lat, lon}]
let sentRoute = "";             // the route the autopilot has, as JSON
let helmSource = "joystick";    // or "laptop"
let command_ = { sail: 0, rudder: 0 };
let sendTimer = null;
let lastSent = null;
let gamepadLoop = null;
let draft = 2.0;
let lastDraw = 0;
const DRAW_INTERVAL_MS = 200;   // the map and panels redraw at 5 Hz

export function initHelm() {
  map = new LakeMap($("map"), $("map-canvas"), {
    onAdd: (lat, lon) => { route.push({ lat, lon }); showRoute(); },
    onMove: (i, lat, lon) => { route[i] = { lat, lon }; showRoute(); },
  });
  loadMap();
  drawFigureFrame();
  bindControls();
  on("ground", showGround);
  on("sim", showSim);
  on("theme", (name) => map.setTheme(name));
  on("section", (name) => {
    if (name !== "helm") { stopGamepad(); return; }
    map.resize();
    startGamepad();
    if (store.sim) showSim(store.sim);
    if (store.ground) showGround(store.ground);
  });
  setInterval(() => { if (section === "helm") showAges(); }, 250);
}

async function loadMap() {
  const { lake } = await (await fetch("/api/map")).json();
  $("map-empty").hidden = Boolean(lake);
  if (!lake) return;
  $("map-h").textContent = lake.name;
  map.setTheme(theme());
  map.setLake(lake, draft);
}

/* ----- controls --------------------------------------------------------- */

function bindControls() {
  for (const button of document.querySelectorAll("[data-map-base]")) {
    button.addEventListener("click", () => {
      for (const b of document.querySelectorAll("[data-map-base]")) b.setAttribute("aria-pressed", String(b === button));
      map.setBase(button.dataset.mapBase);
    });
  }
  $("map-zoom-in").addEventListener("click", () => map.zoomBy(1.5));
  $("map-zoom-out").addEventListener("click", () => map.zoomBy(1 / 1.5));
  $("map-centre").addEventListener("click", () => map.centreOnBoat());
  $("route-restore").addEventListener("click", () => { route = JSON.parse(sentRoute || "[]").map(([lat, lon]) => ({ lat, lon })); showRoute(); });
  $("route-send").addEventListener("click", sendRoute);

  for (const button of document.querySelectorAll("[data-helm-source]")) {
    button.addEventListener("click", () => setHelmSource(button.dataset.helmSource));
  }
  for (const [id, key] of [["sail", "sail"], ["rudder", "rudder"]]) {
    $(id).addEventListener("input", () => {
      if (helmSource !== "laptop") setHelmSource("laptop");
      command_[key] = Number($(id).value);
      showCommand();
      queueSend();
    });
  }
  document.addEventListener("keydown", (event) => {
    if (section !== "helm" || event.target.closest?.("input[type=text], select, textarea")) return;
    const step = event.shiftKey ? 5 : 1;
    const keys = { w: ["sail", step], s: ["sail", -step], d: ["rudder", step], a: ["rudder", -step] };
    const key = event.key.toLowerCase();
    if (key === "x") { release(); event.preventDefault(); return; }
    if (!keys[key]) return;
    event.preventDefault();
    const [axis, delta] = keys[key];
    if (helmSource !== "laptop") setHelmSource("laptop");
    const limit = axis === "sail" ? 90 : 45;
    command_[axis] = Math.max(-limit, Math.min(limit, command_[axis] + delta));
    $(axis).value = command_[axis];
    paintRange($(axis));
    showCommand();
    queueSend();
  });
}

function setHelmSource(source) {
  if (source === "laptop" && store.ground?.source.kind !== "sim") {
    toast("Sending commands from the laptop needs controller firmware support. The joystick has the helm.", 6000);
    return;
  }
  helmSource = source;
  for (const b of document.querySelectorAll("[data-helm-source]")) b.setAttribute("aria-pressed", String(b.dataset.helmSource === source));
  if (source === "joystick") release(true);
  showHint();
}

function showHint() {
  const sim = store.ground?.source.kind === "sim";
  $("helm-hint").textContent = helmSource === "laptop"
    ? "This laptop has the helm. Commands go to the simulated boat over its XBee, once a second."
    : sim ? "The scenario's joystick has the helm. Move a slider or press W, S, A or D to take it."
      : "The joystick has the helm. The sliders show its last packet.";
  for (const id of ["sail", "rudder"]) $(id).closest(".axis").classList.toggle("locked", helmSource !== "laptop");
}

function queueSend() {
  if (sendTimer) return;
  sendTimer = setTimeout(async () => {
    sendTimer = null;
    const body = { action: "operator", sail: command_.sail, rudder: command_.rudder };
    const key = JSON.stringify(body);
    if (key === lastSent) return;
    lastSent = key;
    try { await command("sim", body); } catch (error) { toast(`Couldn't send: ${error.message}`); }
  }, SEND_INTERVAL_MS);
}

async function release(quiet = false) {
  lastSent = null;
  if (store.ground?.source.kind !== "sim") return;
  try {
    await command("sim", { action: "release" });
    if (!quiet) toast("Stopped sending. The firmware drops the joystick 2 s after its last packet.");
  } catch (error) { toast(`Couldn't stop sending: ${error.message}`); }
}

/* A gamepad steers like the real joystick: left stick for the sail, right stick for the rudder. */
function startGamepad() {
  if (gamepadLoop) return;
  const poll = () => {
    const pad = [...(navigator.getGamepads?.() || [])].find(Boolean);
    $("gamepad-state").textContent = pad
      ? `Gamepad: ${pad.id.split("(")[0].trim()}. Left stick sail, right stick rudder.`
      : "No gamepad. Connect one and press a button.";
    if (pad) {
      const axis = (v) => (Math.abs(v) < GAMEPAD_DEADZONE ? 0 : v);
      const sail = Math.round(axis(pad.axes[0] || 0) * 90), rudder = Math.round(axis(pad.axes[2] || 0) * 45);
      if ((sail || rudder) && helmSource !== "laptop") setHelmSource("laptop");
      if (helmSource === "laptop" && (sail !== command_.sail || rudder !== command_.rudder)) {
        command_ = { sail, rudder };
        $("sail").value = sail; $("rudder").value = rudder;
        paintRange($("sail")); paintRange($("rudder"));
        showCommand();
        queueSend();
      }
    }
    gamepadLoop = requestAnimationFrame(poll);
  };
  gamepadLoop = requestAnimationFrame(poll);
}
function stopGamepad() { cancelAnimationFrame(gamepadLoop); gamepadLoop = null; }

/* ----- the route -------------------------------------------------------- */

async function sendRoute() {
  if (store.ground?.source.kind !== "sim") {
    toast("Sending a route to the real boat isn't wired yet: it needs a link to the Raspberry Pi.", 6000);
    return;
  }
  try {
    await command("sim", { action: "waypoints", waypoints: route.map((p) => [p.lat, p.lon]) });
    toast(route.length ? `Sent ${route.length} waypoints. The autopilot sails them in order.` : "Cleared the route.");
  } catch (error) { toast(`Couldn't send the route: ${error.message}`); }
}

function showRoute() {
  const sim = store.sim, wp = sim?.state.waypoint;
  const dirty = JSON.stringify(route.map((p) => [p.lat, p.lon])) !== (sentRoute || "[]");
  const active = dirty ? -1 : wp ? wp.index : -1, reached = dirty ? 0 : wp ? wp.reached : 0;
  map.setRoute(route, active, reached);
  const list = $("route-list");
  const items = route.map((p, i) => {
    const li = document.createElement("li");
    if (i === active && reached < route.length) li.className = "current";
    const markClass = i < reached ? "done" : i === active ? "active" : i === active + 1 ? "next" : "";
    let detail, bad = false;
    const depth = map.depthAt(p.lat, p.lon);
    if (i < reached) detail = "Reached";
    else if (i === 0 && store.sim) detail = `${metres(map.distance({ lat: store.sim.state.lat, lon: store.sim.state.lon }, p))} from the boat`;
    else detail = i > 0 ? metres(map.distance(route[i - 1], p)) + " leg" : "First mark";
    if (i > 0) {
      const leg = map.legProfile(route[i - 1], p);
      if (leg.shallowMetres > 0) { detail += ` · ${Math.round(leg.shallowMetres)} m under the draft`; bad = true; }
    }
    if (depth === null) { detail = "On land"; bad = true; }
    else if (depth !== undefined) detail += ` · ${depth.toFixed(1)} m deep`;
    li.innerHTML = `<span class="wp-mark ${markClass}">${i + 1}</span><div class="wp-text"><div class="nm"></div><div class="dt${bad ? " bad" : ""}"></div></div>
      <button class="remove" type="button" aria-label="Remove waypoint ${i + 1}"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3 3 9" class="icon-stroke"/></svg></button>`;
    li.querySelector(".nm").textContent = `Waypoint ${i + 1}`;
    li.querySelector(".dt").textContent = detail;
    li.querySelector(".remove").addEventListener("click", () => { route.splice(i, 1); showRoute(); });
    return li;
  });
  list.replaceChildren(...items);
  const pill = $("route-pill");
  pill.hidden = !dirty;
  pill.textContent = "Not sent";
  pill.className = "pill warn";
  const shallow = route.slice(1).reduce((sum, p, i) => sum + map.legProfile(route[i], p).shallowMetres, 0);
  $("route-note").textContent = !route.length ? "Click the map to add a waypoint. Drag one to move it."
    : shallow > 0 ? `${Math.round(shallow)} m of this route is shallower than the ${draft.toFixed(1)} m draft.`
      : "Click the map to add a waypoint. Drag one to move it.";
  $("route-note").classList.toggle("bad", shallow > 0);
  $("route-send").disabled = !dirty;
  $("route-restore").disabled = !dirty;
}

/* ----- drawing ---------------------------------------------------------- */

function showSim(sim) {
  const s = sim.state;
  const sent = JSON.stringify(sim.route);
  if (sent !== sentRoute) {
    const unedited = JSON.stringify(route.map((p) => [p.lat, p.lon])) === (sentRoute || "[]");
    sentRoute = sent;
    if (unedited) route = sim.route.map(([lat, lon]) => ({ lat, lon }));
  }
  const now = performance.now();
  if (section !== "helm" || now - lastDraw < DRAW_INTERVAL_MS) return;
  lastDraw = now;
  if (store.ground?.source.kind === "sim") {
    map.boat = { lat: s.lat, lon: s.lon, heading: s.heading };
    map.track = trackFrom(sim);
  }
  showRoute();
  showCommand();
  showFigure();
}

/* The truth track in lat/lon, from the scenario origin and the history. */
let trackCache = { run: null, points: [] };
function trackFrom(sim) {
  if (trackCache.run !== sim.run) {
    const hello = store.hello?.run === sim.run ? store.hello.track : [];
    const [lat0, lon0] = sim.origin, k = 180 / (Math.PI * 6371000);
    trackCache = { run: sim.run, points: hello.map(([n, e]) => ({ lat: lat0 + n * k, lon: lon0 + e * k / Math.cos(lat0 * Math.PI / 180) })) };
  }
  const pts = trackCache.points, s = sim.state, last = pts[pts.length - 1];
  if (!last || map.distance(last, s) > 1) pts.push({ lat: s.lat, lon: s.lon });
  return pts;
}

function showGround(ground) {
  if (section !== "helm") return;
  const status = ground.status, t = ground.telemetry;
  $("gs-rate").textContent = ground.line_rate.toFixed(0);
  $("gs-rate-note").textContent = status
    ? `${status.dropped} dropped · ${status.overruns} overruns`
    : "No controller lines yet";
  const hasT = Object.keys(t).length > 0;
  $("in-heading").innerHTML = hasT ? `${bearing(t.cb)}°` : "—";
  $("in-bearing").innerHTML = hasT ? `${bearing(t.tb)}°` : "—";
  $("in-wind").innerHTML = hasT ? `${Math.abs(wrap180(t.wa)).toFixed(0)}°<small>${wrap180(t.wa) >= 0 ? "starboard" : "port"}</small>` : "—";
  if (hasT) {
    const whole = Number.isInteger(t.clat) && Number.isInteger(t.clon);
    $("in-position").textContent = `${t.clat}, ${t.clon}`;
    const truth = store.sim && ground.source.kind === "sim" ? ` Truth: ${latlon(store.sim.state.lat, store.sim.state.lon)}` : "";
    $("in-position-note").textContent = whole ? `Needs fixed-point telemetry.${truth}` : "";
    $("in-position-note").className = `k${whole ? " warn" : ""}`;
  }
  if (ground.source.kind !== "sim") {
    // A real controller: the map shows what telemetry says, which today is whole degrees.
    map.setBoat(null);
    map.setTrack([]);
  }
  showHint();
  showAges();
  showFinding();
}

/* Ages tick between updates, so they are drawn on a timer. */
function showAges() {
  const ground = store.ground;
  if (!ground) return;
  const since = (performance.now() - store.groundAt) / 1000;
  const sim = ground.source.kind === "sim" ? store.sim?.state : null;
  const meter = (id, value, limit) => {
    const bar = $(id);
    bar.style.width = value === null ? "0%" : `${Math.min(100, (100 * value) / limit)}%`;
    bar.parentElement.classList.toggle("bad", value !== null && value >= limit);
  };
  const telAge = ground.telemetry_age_s === null ? null : ground.telemetry_age_s + since;
  $("gs-tel").textContent = telAge === null ? "—" : telAge.toFixed(1);
  meter("gs-tel-meter", telAge, 2.5);
  for (const [id, key, limit] of [["gs-xbee", "xbee_age", 2], ["gs-rpi", "rpi_age", 10]]) {
    const value = sim && sim[key] !== null ? sim[key] / 1000 : null;
    $(id).textContent = value === null ? "—" : value.toFixed(1);
    meter(`${id}-meter`, value, limit);
    $(`${id}-note`).textContent = sim ? (value === null ? "Never heard" : "") : "Needs telemetry v2";
  }
  $("helm-stamp").innerHTML = telAge === null ? '<span class="dot off" aria-hidden="true"></span>No telemetry yet'
    : `<span class="dot${telAge > 2.5 ? " bad" : ""}" aria-hidden="true"></span>Telemetry ${age(telAge)} ago · packet ${ground.packets.toLocaleString()}`;
}

function showFinding() {
  const ground = store.ground, sim = ground?.source.kind === "sim" ? store.sim?.state : null;
  let text, alert = false;
  if (!ground || (ground.telemetry_age_s === null && ground.status_age_s === null)) text = "Waiting for the controller.";
  else if (sim) {
    if (sim.grounded_at !== null) { text = "The boat is aground."; alert = true; }
    else if (sim.sail_source === "none" && sim.rudder_source === "none") {
      text = "Nobody is steering: the firmware has stopped the sail motor and centred the rudder."; alert = true;
    } else {
      const rpiOverridesYou = helmSource === "laptop" && sim.xbee_valid &&
        (sim.sail_source === "rpi" || sim.rudder_source === "rpi");
      text = rpiOverridesYou
        ? `The autopilot is steering the ${sim.rudder_source === "rpi" ? "rudder" : "sail"}: your 0° counts as "no command" while it is live.`
        : `${SOURCE_NAMES[sim.sail_source]} has the sail, ${SOURCE_NAMES[sim.rudder_source].toLowerCase()} has the rudder.`;
    }
  } else {
    const stale = ground.telemetry_age_s !== null && ground.telemetry_age_s > 2.5;
    text = stale ? "Telemetry has stopped arriving." : "Telemetry is arriving once a second.";
    alert = stale;
  }
  $("helm-finding").textContent = text;
  $("helm-finding").classList.toggle("alert", alert);
}

function showCommand() {
  const ground = store.ground, simSource = ground?.source.kind === "sim";
  const s = simSource ? store.sim?.state : null;
  const status = ground?.status;
  const sent = helmSource === "laptop" ? command_
    : s?.operator ? { sail: s.operator[0], rudder: s.operator[1] }
      : status ? { sail: status.sail, rudder: status.rudder } : null;
  if (helmSource !== "laptop" && sent) {
    $("sail").value = sent.sail; $("rudder").value = sent.rudder;
    paintRange($("sail")); paintRange($("rudder"));
  }
  const shown = helmSource === "laptop" ? command_ : sent || { sail: 0, rudder: 0 };
  $("sail-out").textContent = `${signed(shown.sail, 0)}°`;
  $("rudder-out").textContent = `${signed(shown.rudder, 0)}°`;
  const silent = helmSource !== "laptop" && !s?.operator && simSource;
  $("sail-sent").textContent = sent && !silent ? `${signed(sent.sail, 0)}°` : "Nothing";
  $("rudder-sent").textContent = sent && !silent ? `${signed(sent.rudder, 0)}°` : "Nothing";
  if (s) {
    for (const [axis, source, target] of [["sail", s.sail_source, s.sail_target], ["rudder", s.rudder_source, s.rudder_target]]) {
      const uses = $(`${axis}-uses`);
      uses.textContent = source === "none" ? "Nothing · motor off" : `${signed(target, 0)}° · ${source === "xbee" ? "you" : "autopilot"}`;
      const defers = sent && source === "rpi" && s.xbee_valid && sent[axis] === 0;
      uses.className = `v num${defers ? " warn" : source === "none" ? " bad" : ""}`;
      const why = $(`${axis}-why`);
      why.hidden = !defers;
      why.textContent = `At 0° the boat follows the autopilot's ${signed(target, 0)}°: the firmware treats an XBee 0 as "no command" while the autopilot is fresh. Holding ${axis === "sail" ? "the sail" : "the rudder"} at 0° needs a firmware HOLD command.`;
    }
    $("sail-now").textContent = `${signed(s.sail_believed, 0)}° · ${s.sail_motor ? "turning" : "holding"}`;
    $("rudder-pulse").textContent = `${s.rudder_pulse} µs`;
    $("rudder-pulse").className = `v num${s.rudder_pulse_ok ? "" : " bad"}`;
  } else {
    const t = ground?.telemetry || {};
    $("sail-uses").textContent = "Needs telemetry v2";
    $("rudder-uses").textContent = "Needs telemetry v2";
    $("sail-now").textContent = "sa" in t ? `${signed(wrap180(t.sa - 180), 0)}° · encoder ${t.sa}` : "—";
    $("rudder-pulse").textContent = "—";
    for (const id of ["sail-why", "rudder-why"]) $(id).hidden = true;
  }
}

/* ----- the boat seen from above ------------------------------------------ */

const fig = {};
function drawFigureFrame() {
  const svg = $("helm-fig");
  const add = (name, attrs) => {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.appendChild(node);
    return node;
  };
  add("circle", { cx: 100, cy: 100, r: 96, class: "fig-disc" });
  add("path", { d: "M100,24 C121,52 125,108 117,166 L83,166 C75,108 79,52 100,24 Z", class: "fig-hull" });
  fig.ghost = add("line", { x1: 100, y1: 80, x2: 100, y2: 140, class: "fig-ghost" });
  fig.sail = add("line", { x1: 100, y1: 80, x2: 100, y2: 140, class: "fig-sail" });
  add("circle", { cx: 100, cy: 80, r: 6, class: "fig-pivot" });
  fig.rudder = add("line", { x1: 100, y1: 166, x2: 100, y2: 190, class: "fig-rudder" });
  fig.wind = add("line", { class: "fig-wind" });
  fig.windHead = add("polygon", { class: "fig-wind-head" });
}

function showFigure() {
  const ground = store.ground;
  const s = ground?.source.kind === "sim" ? store.sim?.state : null;
  const t = ground?.telemetry || {};
  // The sail as the encoder reports it, the target dashed. Positive swings the trailing edge to port (left).
  const actual = s ? s.sail_believed : "sa" in t ? wrap180(t.sa - 180) : 0;
  const target = s ? s.sail_target : "tsa" in t ? t.tsa : 0;
  const rudder = s ? s.rudder : "tra" in t ? t.tra : 0;
  const awa = s ? s.awa : "wa" in t ? wrap180(t.wa) : 0;
  fig.sail.setAttribute("transform", `rotate(${actual.toFixed(1)} 100 80)`);
  fig.ghost.setAttribute("transform", `rotate(${target.toFixed(1)} 100 80)`);
  fig.rudder.setAttribute("transform", `rotate(${(-rudder).toFixed(1)} 100 166)`);
  // An arrow coming in from where the apparent wind blows from.
  const a = (awa * Math.PI) / 180, ux = Math.sin(a), uy = -Math.cos(a);
  const from = [100 + ux * 92, 100 + uy * 92], tip = [100 + ux * 62, 100 + uy * 62];
  fig.wind.setAttribute("x1", from[0]); fig.wind.setAttribute("y1", from[1]);
  fig.wind.setAttribute("x2", tip[0]); fig.wind.setAttribute("y2", tip[1]);
  const head = [[tip[0] - ux * 12, tip[1] - uy * 12], [tip[0] + uy * 8, tip[1] - ux * 8], [tip[0] - uy * 8, tip[1] + ux * 8]];
  fig.windHead.setAttribute("points", head.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" "));
  $("helm-tack").textContent = s || "wa" in t ? pointOfSail(awa) : "No wind reading yet";
}
