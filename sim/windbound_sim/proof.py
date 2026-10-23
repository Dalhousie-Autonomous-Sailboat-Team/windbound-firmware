"""Proving the firmware without the boat.

Proof tracks which firmware build the simulator is running, rebuilds and
reloads it when asked (or whenever a firmware source file changes, when
watching), and runs every check against it: the firmware's own unit tests
(CTest) and the simulator's scenario and property tests (pytest).
"""

import subprocess
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from .firmware import REPO_ROOT, build_library, find_library, reload_library

SIM_DIR = REPO_ROOT / "sim"
SOURCE_DIRS = (REPO_ROOT / "User", SIM_DIR / "sil")
WATCH_INTERVAL_S = 1.0
OUTPUT_TAIL = 4000          # characters of compiler output kept for the page

SUITES = {     # test module -> (title, what it proves), in the order the page lists them
    "ctest": ("Firmware unit tests", "The firmware's own C tests in tests/, built for this computer"),
    "test_invariants": ("Firmware properties",
                        "Rules the control logic and protocol keep for every input, tried on thousands of random ones"),
    "test_scenarios": ("Scenarios", "Whole runs with the firmware in the loop: link loss, encoder failure, "
                                    "the operator taking over, the Lake Micmac course"),
    "test_firmware_binding": ("Firmware binding", "The simulator's copies of the firmware's structs and buffers "
                                                  "match the C build"),
    "test_physics": ("Boat model", "The physics behaves like the boat: no sailing into the wind, the rudder "
                                   "turns the right way"),
    "test_link": ("Ground station link", "The ground station reads the simulated controller over socket://"),
    "test_service": ("Web service", "This page's server: its routes, who may command it, and that commands arrive"),
}
WORDS = {"xbee": "XBee", "rpi": "RPi", "gps": "GPS", "sil": "SIL", "url": "URL", "glb": "GLB"}


def git(*args):
    try:
        done = subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return done.stdout.rstrip("\n") if done.returncode == 0 else ""


def firmware_identity():
    """The commit the firmware sources are on, the files edited since, and
    when the simulator's library was built."""
    edited = [line[3:] for line in git("status", "--porcelain", "--", "User", "sim/sil").splitlines()]
    try:
        built_at = find_library().stat().st_mtime
    except FileNotFoundError:
        built_at = None
    return {"commit": git("rev-parse", "--short", "HEAD") or None, "branch": git("branch", "--show-current"),
            "edited": edited, "built_at": built_at}


def readable(test_name):
    words = test_name.removeprefix("test_").split("[")[0].split("_")
    text = " ".join(WORDS.get(w, w) for w in words)
    param = test_name.split("[", 1)[1].rstrip("]") if "[" in test_name else ""
    return (text[:1].upper() + text[1:]) + (f" (seed {param})" if param.isdigit() else f" ({param})" if param else "")


def parse_junit(path, kind):
    """(suite, name, outcome, message, seconds) for each test in a JUnit file."""
    results = []
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, FileNotFoundError):
        return results
    for case in root.iter("testcase"):
        if kind == "ctest":
            suite, name = SUITES["ctest"][0], case.get("name", "")
        else:
            module = case.get("classname", "").split(".")[-1]
            suite, name = SUITES.get(module, (module,))[0], readable(case.get("name", ""))
        failure = case.find("failure") if case.find("failure") is not None else case.find("error")
        skipped = case.find("skipped")
        if failure is not None:
            outcome = "failed"
            message = failure.get("message") or ""
            if kind == "ctest":
                out = case.findtext("system-out") or ""
                message = "\n".join(l.strip() for l in out.splitlines() if "expected" in l or l.startswith("FAIL"))
            elif "XPASS(strict)" in message:
                message = "Now passes: the known issue looks fixed. Remove its xfail marker. " + message
        elif skipped is not None:
            reason = skipped.get("message") or ""
            outcome = "known" if skipped.get("type") == "pytest.xfail" else "skipped"
            message = reason.removeprefix("reason: ")
        else:
            outcome, message = "passed", ""
        results.append({"suite": suite, "name": name, "outcome": outcome, "message": message.strip(),
                        "seconds": float(case.get("time") or 0)})
    return results


class Proof:
    def __init__(self, on_reloaded):
        self._on_reloaded = on_reloaded
        self._lock = threading.Lock()
        self._busy = threading.Lock()
        self.version = 0
        self.watch = False
        self.identity = firmware_identity()
        self.build = {"state": "ready", "output": "", "at": None, "trigger": None}
        self.checks = {"state": "idle", "started": None, "finished": None, "results": []}
        self._stamps = self._source_stamps()
        threading.Thread(target=self._watch_loop, daemon=True).start()

    def snapshot(self):
        with self._lock:
            return {"identity": self.identity, "build": dict(self.build), "checks": dict(self.checks),
                    "watch": self.watch, "suites": [{"title": t, "what": w} for t, w in SUITES.values()]}

    def set_watch(self, on):
        with self._lock:
            self.watch = bool(on)
            self.version += 1

    def rebuild(self, trigger="button"):
        threading.Thread(target=self._rebuild, args=(trigger,), daemon=True).start()

    def run_checks(self):
        threading.Thread(target=self._run_checks, daemon=True).start()

    # ----- work, one job at a time ------------------------------------------ #

    def _update(self, **changes):
        with self._lock:
            for key, value in changes.items():
                current = getattr(self, key)
                if isinstance(current, dict):
                    current.update(value)
                else:
                    setattr(self, key, value)
            self.version += 1

    def _rebuild(self, trigger):
        with self._busy:
            self._update(build={"state": "building", "trigger": trigger, "output": ""})
            ok, output = build_library()
            if ok:
                reload_library()
                self._on_reloaded()
            self._update(build={"state": "ready" if ok else "failed", "output": output[-OUTPUT_TAIL:],
                                "at": time.time()},
                         identity=firmware_identity())

    def _run_checks(self):
        with self._busy:
            self._update(checks={"state": "running", "started": time.time(), "finished": None, "results": []})
            with tempfile.TemporaryDirectory() as tmp:
                ctest_xml, pytest_xml = Path(tmp) / "ctest.xml", Path(tmp) / "pytest.xml"
                build = subprocess.run(["cmake", "--build", "--preset", "Host-Tests"], cwd=REPO_ROOT,
                                       capture_output=True, text=True)
                if build.returncode != 0:
                    self._update(checks={"state": "failed", "finished": time.time(),
                                         "results": [{"suite": SUITES["ctest"][0], "name": "Build", "outcome": "failed",
                                                      "message": (build.stdout + build.stderr)[-OUTPUT_TAIL:],
                                                      "seconds": 0}]})
                    return
                subprocess.run(["ctest", "--preset", "Host-Tests", "--output-junit", str(ctest_xml)],
                               cwd=REPO_ROOT, capture_output=True, text=True)
                subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
                                f"--junitxml={pytest_xml}"], cwd=SIM_DIR, capture_output=True, text=True)
                results = parse_junit(ctest_xml, "ctest") + parse_junit(pytest_xml, "pytest")
            self._update(checks={"state": "done", "finished": time.time(), "results": results},
                         identity=firmware_identity())

    # ----- watching the sources --------------------------------------------- #

    @staticmethod
    def _source_stamps():
        stamps = {}
        for folder in SOURCE_DIRS:
            for path in folder.rglob("*"):
                if path.suffix in (".c", ".h"):
                    stamps[path] = path.stat().st_mtime_ns
        return stamps

    def _watch_loop(self):
        while True:
            time.sleep(WATCH_INTERVAL_S)
            stamps = self._source_stamps()
            if stamps != self._stamps:
                self._stamps = stamps
                self._update(identity=firmware_identity())
                if self.watch and not self._busy.locked():
                    self._rebuild("a firmware file changed")
