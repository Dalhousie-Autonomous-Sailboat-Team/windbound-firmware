/*
 * Firmware checks: which firmware the simulator is running, rebuilding it, and
 * every check against it (CTest unit tests, scenarios and properties).
 */
import { command, on, section, store, toast } from "/app.js";
import { clock, timeOfDay } from "/format.js";

const $ = (id) => document.getElementById(id);
const OUTCOMES = { passed: ["Passed", "pos"], failed: ["Failed", "neg"], known: ["Known issue", "warn"], skipped: ["Skipped", ""] };
let filter = "all";

export function initChecks() {
  $("fw-rebuild").addEventListener("click", () => run({ action: "rebuild" }));
  $("fw-check").addEventListener("click", () => run({ action: "check" }));
  $("fw-watch").addEventListener("click", () => {
    const on_ = $("fw-watch").getAttribute("aria-checked") !== "true";
    run({ action: "watch", on: on_ });
  });
  for (const button of document.querySelectorAll("[data-result-filter]")) {
    button.addEventListener("click", () => {
      filter = button.dataset.resultFilter;
      for (const b of document.querySelectorAll("[data-result-filter]")) b.setAttribute("aria-pressed", String(b === button));
      if (store.proof) showResults(store.proof);
    });
  }
  on("proof", show);
  on("section", (name) => { if (name === "checks" && store.proof) show(store.proof); });
}

async function run(body) {
  try { await command("firmware", body); } catch (error) { toast(`Couldn't start that: ${error.message}`); }
}

function show(proof) {
  const { identity, build, checks, watch } = proof;
  const failing = checks.results.filter((r) => r.outcome === "failed").length;
  $("nav-checks-count").textContent = failing ? `${failing} failing` : "";
  if (section !== "checks") return;

  $("c-commit").textContent = identity.commit || "—";
  $("c-branch").textContent = identity.edited.length ? `+ ${identity.edited.length} edited` : "";
  const files = identity.edited.map((path) => path.split("/").pop());
  $("c-edited").textContent = identity.edited.length
    ? `${files.slice(0, 4).join(", ")}${files.length > 4 ? ` and ${files.length - 4} more` : ""}`
    : `No edits since this commit${identity.branch ? ` on ${identity.branch}` : ""}`;
  $("c-built").textContent = build.state === "building" ? "Building" : identity.built_at ? timeOfDay(identity.built_at) : "Not built";
  $("c-build-note").textContent = build.state === "failed" ? "The last rebuild failed. The simulator kept the previous build."
    : build.state === "building" ? `Rebuilding because ${build.trigger === "button" ? "you asked" : build.trigger}`
      : build.at ? "Rebuilt and reloaded; the run restarted" : "The library the simulator loaded at start";
  $("c-build-note").classList.toggle("bad", build.state === "failed");
  $("fw-watch").setAttribute("aria-checked", String(watch));
  $("fw-watch-label").textContent = watch ? "On" : "Off";
  $("fw-rebuild").disabled = build.state === "building" || checks.state === "running";
  $("fw-check").disabled = checks.state === "running" || build.state === "building";
  $("fw-check").textContent = checks.state === "running" ? "Running…" : "Run every check";

  const panel = $("build-panel");
  panel.hidden = build.state !== "failed";
  $("build-log").textContent = build.output;
  $("build-meta").textContent = build.at ? timeOfDay(build.at) : "";

  const counts = count(checks.results);
  $("c-passed").textContent = checks.results.length ? `${counts.passed}` : "—";
  $("c-passed-small").textContent = checks.results.length ? `of ${checks.results.length} passed` : "";
  $("c-last").textContent = checks.state === "running" ? `Running since ${timeOfDay(checks.started)}`
    : checks.finished ? `${timeOfDay(checks.finished)} · took ${clock(checks.finished - checks.started)}` : "Not run yet";
  const finding = $("checks-finding");
  finding.textContent = checks.state === "running" ? "Building and running every check against the firmware you have open…"
    : !checks.results.length ? "Prove a firmware change here before it goes near the boat."
      : `${counts.passed} passed, ${counts.known} known issues, ${counts.failed} failing${counts.skipped ? `, ${counts.skipped} skipped` : ""}.`;
  finding.classList.toggle("alert", counts.failed > 0 && checks.state !== "running");
  showResults(proof);
}

function count(results) {
  const c = { passed: 0, failed: 0, known: 0, skipped: 0 };
  for (const r of results) c[r.outcome] += 1;
  return c;
}

function showResults({ checks, suites }) {
  const rows = [];
  if (!checks.results.length) {
    // Before the first run: what will run and what each part proves.
    const [word, kind] = checks.state === "running" ? ["Running", "warn"] : ["Not run", ""];
    for (const s of suites) rows.push(row(word, kind, s.title, s.what, ""));
    $("results").replaceChildren(...rows);
    $("results-empty").hidden = true;
    return;
  }
  let suite = null;
  const shown = checks.results.filter((r) => filter === "all" || r.outcome === filter);
  // Suites in the service's order; in each, failures first, then known issues, then the rest.
  const order = { failed: 0, known: 1, passed: 2, skipped: 3 };
  const place = (r) => { const i = suites.findIndex((s) => s.title === r.suite); return i < 0 ? suites.length : i; };
  shown.sort((a, b) => place(a) - place(b) || a.suite.localeCompare(b.suite) || order[a.outcome] - order[b.outcome]);
  for (const r of shown) {
    if (r.suite !== suite) {
      suite = r.suite;
      const tr = document.createElement("tr");
      tr.className = "group";
      tr.innerHTML = '<td colspan="4"></td>';
      tr.firstChild.textContent = suite;
      rows.push(tr);
    }
    const [word, kind] = OUTCOMES[r.outcome];
    rows.push(row(word, kind, r.name, r.message, r.seconds >= 0.01 ? `${r.seconds.toFixed(2)} s` : ""));
  }
  $("results").replaceChildren(...rows);
  $("results-empty").hidden = shown.length > 0;
  $("results-empty").textContent = filter === "failed" ? "Nothing is failing." : "No known issues.";
}

function row(word, kind, name, why, time) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td><span class="pill ${kind}"></span></td><td></td><td class="why-cell"></td><td class="n num"></td>`;
  tr.querySelector(".pill").textContent = word;
  tr.cells[1].textContent = name;
  tr.cells[2].textContent = why;
  tr.cells[3].textContent = time;
  return tr;
}
