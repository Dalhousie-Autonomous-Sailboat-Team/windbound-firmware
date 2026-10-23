/*
 * Telemetry: the latest packet, field by field with what to know about each,
 * and the raw serial log from the controller.
 */
import { on, section, store } from "/app.js";
import { timeOfDay } from "/format.js";

const $ = (id) => document.getElementById(id);
const LOG_LIMIT = 500;          // lines kept for the download
const SHOWN_LIMIT = 300;        // lines on the page
const FLUSH_MS = 250;           // the page takes new lines four times a second

/* The fields TelemetryTask sends, in order (parsing.py's TELEMETRY_FIELDS), and
   what the firmware does to each before it goes on the radio. */
const FIELDS = [
  ["tb", "Target bearing", "°", "Commented as East = 0 in app_state.h; check before drawing it north-up"],
  ["tlat", "Target latitude", "", "Sent as whole degrees"],
  ["tlon", "Target longitude", "", "Sent as whole degrees"],
  ["tsa", "Target sail angle", "°", "The autopilot's target, not necessarily what the firmware used"],
  ["tfa", "Target flap angle", "°", "No flap motor is driven yet"],
  ["tra", "Target rudder angle", "°", "The autopilot's target. There is no rudder feedback"],
  ["clat", "Current latitude", "", "Sent as whole degrees, so about 111 km out until it is fixed-point"],
  ["clon", "Current longitude", "", "Sent as whole degrees"],
  ["cb", "Current bearing", "°", "From the autopilot's compass"],
  ["wa", "Wind angle", "°", "Apparent wind from the windvane, as the autopilot last reported it"],
  ["sa", "Sail angle", "°", "The raw AS5600 reading; 180 is the centre"],
];

let filter = "all";
let paused = false;
const lines = [];
let pending = [];               // lines waiting for the next flush
let flushTimer = null;

const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };

export function initTelemetry() {
  $("packet-rows").replaceChildren(...FIELDS.map(([key, label, unit, note]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td></td><td class="key"><code></code></td><td class="n num" id="tv-${key}">—</td><td><span class="note"></span></td>`;
    tr.cells[0].textContent = label;
    tr.querySelector("code").textContent = key;
    tr.querySelector(".note").textContent = note;
    tr.dataset.unit = unit;
    return tr;
  }));
  for (const button of document.querySelectorAll("[data-log-filter]")) {
    button.addEventListener("click", () => {
      filter = button.dataset.logFilter;
      for (const b of document.querySelectorAll("[data-log-filter]")) b.setAttribute("aria-pressed", String(b === button));
      redrawLog();
    });
  }
  $("log-pause").addEventListener("click", () => {
    paused = !paused;
    $("log-pause").textContent = paused ? "Resume" : "Pause";
    $("log-pause").setAttribute("aria-pressed", String(paused));
    if (!paused) redrawLog();
  });
  $("log-download").addEventListener("click", download);
  on("ground", (ground) => {
    if (ground.lines.length && ground.lines[0][0] <= (lines[lines.length - 1]?.[0] ?? 0)) { lines.length = 0; pending = []; }
    lines.push(...ground.lines);
    if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT);
    if (section !== "telemetry") return;
    pending.push(...ground.lines);
    // Lines arrive up to 30 times a second; drawing them in batches keeps the
    // page from laying out the log on every one.
    flushTimer ??= setTimeout(flush, FLUSH_MS);
  });
  on("section", (name) => {
    if (name === "telemetry" && store.ground) { pending = []; showPacket(store.ground); redrawLog(); }
  });
}

function flush() {
  flushTimer = null;
  if (section !== "telemetry" || !store.ground) return;
  showPacket(store.ground);
  if (!paused) appendLog(pending);
  pending = [];
}

function showPacket(ground) {
  const t = ground.telemetry;
  for (const [key, , unit] of FIELDS) setText($(`tv-${key}`), key in t ? `${t[key]}${unit}` : "—");
  const source = ground.source.kind === "sim" ? "from the simulator" : `on ${ground.source.name}`;
  setText($("tel-sub"), ground.packets
    ? `Packet ${ground.packets.toLocaleString()}, ${source}. The boat sends one a second.`
    : `No packet yet ${source}. The boat sends one a second.`);
  const age = ground.telemetry_age_s === null ? null : ground.telemetry_age_s + (performance.now() - store.groundAt) / 1000;
  setText($("packet-meta"), age === null ? "" : `${age.toFixed(1)} s ago`);
  const last = lines.findLast(([, , text]) => text.includes("XBee RX"));
  setText($("packet-raw"), last ? last[2] : "");
}

const kindOf = (text) => (text.includes("XBee RX") ? "telemetry" : "controller");
const keep = (text) => filter === "all" || kindOf(text) === filter;

function lineNode([, at, text]) {
  const span = document.createElement("span");
  const time = document.createElement("span");
  time.className = "t";
  time.textContent = `${timeOfDay(at)}  `;
  span.append(time);
  const body = document.createElement("span");
  if (kindOf(text) === "telemetry") body.className = "rx";
  body.textContent = text;
  span.append(body, "\n");
  return span;
}

function appendLog(newLines) {
  const shown = newLines.filter(([, , text]) => keep(text)).slice(-SHOWN_LIMIT);
  if (!shown.length) return;
  const log = $("log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(...shown.map(lineNode));
  for (let extra = log.childNodes.length - SHOWN_LIMIT; extra > 0; extra--) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
  setText($("log-count"), `${log.childNodes.length} lines shown`);
}

function redrawLog() {
  $("log").replaceChildren();
  appendLog(lines);
}

function download() {
  const text = lines.map(([, at, line]) => `${new Date(at * 1000).toISOString()}\t${line}`).join("\n");
  const link = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([text], { type: "text/plain" })),
    download: `windbound-serial-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`,
  });
  link.click();
  URL.revokeObjectURL(link.href);
}
