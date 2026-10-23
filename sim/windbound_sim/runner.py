"""Runs one simulation in the background for the web app.

The runner owns the simulation thread. The page's commands (pause, speed,
wind, faults, the joystick, a new route) are queued and applied between
steps, so nothing changes the physics halfway through a step. Every frame it
publishes a JSON snapshot that the service streams to the browser.

It also keeps what a single snapshot can't: the track, who the firmware
obeyed over time (from ControlLogic_Evaluate's own source field), and the
live checks for this run.
"""

import json
import math
import queue
import threading
import time

from .scenarios import SCENARIOS
from .sim import CONTROL_PERIOD_MS, FAULTS, Simulation

FRAME_S = 1 / 30
MAX_SPEED_BUSY_S = 0.025       # at "max", how long each frame computes before publishing
TRACK_SPACING_M = 1.0
TIMELINE_LIMIT = 400
SPEEDS = (1, 5, 20)            # plus "max"
AUTOPILOT_PERIODS_MS = (500, 1000, 2000, 5000)


class SimRunner:
    def __init__(self, params, scenario="micmac-course", speed=5, ground=None, link=None):
        self.params = params
        self.ground = ground
        self.tcp_link = link
        self.speed = speed
        self.running = True
        self.run_id = 0
        self._commands = queue.Queue()
        self._lock = threading.Lock()
        self._published = None
        self.version = 0
        self._load(scenario)
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    # ----- the page's commands ----------------------------------------------- #

    def submit(self, action, **args):
        """Queue a command from the page. Raises ValueError for one it can't use."""
        check = {
            "load": lambda: args["scenario"] in SCENARIOS,
            "speed": lambda: args["speed"] in SPEEDS or args["speed"] == "max",
            "fault": lambda: args["name"] in FAULTS,
            "operator": lambda: all(abs(float(args[k])) <= 180 for k in ("sail", "rudder")),
            "wind": lambda: all(k in ("speed_ms", "from_deg", "gust_ms") for k in args),
            "waypoints": lambda: all(len(w) == 2 for w in args["waypoints"]),
            "autopilot": lambda: int(args["period_ms"]) in AUTOPILOT_PERIODS_MS,
        }.get(action, lambda: action in ("restart", "pause", "resume", "step", "release", "stop_boat"))
        try:
            ok = check()
        except (KeyError, TypeError, ValueError):
            ok = False
        if not ok:
            raise ValueError(f"can't {action} with {args}")
        self._commands.put((action, args))

    def restart(self):
        self._commands.put(("restart", {}))

    def _apply(self, action, args):
        sim = self.sim
        if action == "load":
            self._load(args["scenario"])
        elif action == "restart":
            self._load(self.scenario.name)
        elif action == "pause":
            self.running = False
        elif action == "resume":
            self.running = not self.finished
        elif action == "step":
            self.running = False
            self._advance_to(sim.now_ms + CONTROL_PERIOD_MS)
        elif action == "speed":
            self.speed = args["speed"]
        elif action == "fault":
            sim.set_fault(args["name"], args["on"])
        elif action == "wind":
            sim.set_wind(**args)
        elif action == "operator":
            sim.set_operator(args["sail"], args["rudder"])
        elif action == "release":
            sim.release_operator()
        elif action == "stop_boat":
            # The firmware has no stop command; silencing both links is the
            # only thing that makes it stop the sail and centre the rudder.
            sim.release_operator()
            sim.set_fault("xbee_silent", True)
            sim.set_fault("rpi_silent", True)
        elif action == "waypoints":
            sim.set_waypoints(args["waypoints"])
        elif action == "autopilot":
            # How often the Raspberry Pi sends targets. It applies from the next
            # step and stays for later runs, like the wind.
            change = {"autopilot": {"period_ms": int(args["period_ms"])}}
            self.params = self.params.with_changes(**change)
            sim.params = sim.params.with_changes(**change)

    # ----- running ----------------------------------------------------------- #

    def _load(self, name):
        self.scenario = SCENARIOS[name]
        links = [l for l in (self.ground, self.tcp_link) if l is not None]
        self.sim = Simulation(self.scenario, self.params, link=_Links(links) if links else None)
        self.run_id += 1
        self.finished = False
        self.running = True
        self.track = []
        self.timeline = {"sail": [], "rudder": []}
        self._checks = _Checks(self.sim)

    @property
    def end_ms(self):
        return round(self.scenario.duration_s * 1000)

    def _advance_to(self, target_ms):
        sim = self.sim
        while sim.now_ms < min(target_ms, self.end_ms):
            sim.step()
            if sim.now_ms % CONTROL_PERIOD_MS == 0:
                self._after_control_tick()
        if sim.now_ms >= self.end_ms:
            self.finished, self.running = True, False

    def _after_control_tick(self):
        sim, out = self.sim, self.sim.output
        t = sim.now_ms / 1000.0
        for axis, source in (("sail", out.sail_source), ("rudder", out.rudder_source)):
            lane = self.timeline[axis]
            if lane and lane[-1][2] == source:
                lane[-1][1] = t
            else:
                lane.append([t, t, source])
                del lane[:-TIMELINE_LIMIT]
        st = sim.hull.state
        point = (round(st.north_m, 2), round(st.east_m, 2))
        if not self.track or math.dist(point, self.track[-1]) >= TRACK_SPACING_M:
            self.track.append(point)
        self._checks.update()

    def _loop(self):
        last = time.monotonic()
        while True:
            now = time.monotonic()
            elapsed, last = now - last, now
            changed = self._published is None
            try:
                while True:
                    self._apply(*self._commands.get_nowait())
                    changed = True
            except queue.Empty:
                pass
            if self.running:
                changed = True
                if self.speed == "max":
                    deadline = time.monotonic() + MAX_SPEED_BUSY_S
                    while self.running and time.monotonic() < deadline:
                        self._advance_to(self.sim.now_ms + CONTROL_PERIOD_MS)
                else:
                    # Never fall more than a quarter second behind, e.g. after a pause.
                    self._advance_to(self.sim.now_ms + round(min(elapsed, 0.25) * self.speed * 1000))
            if changed:              # a paused or finished run sends nothing new
                self._publish()
            time.sleep(max(0.0, FRAME_S - (time.monotonic() - now)))

    def _publish(self):
        sim = self.sim
        self.sim.speed = None if self.speed == "max" else self.speed
        snapshot = {
            "run": self.run_id,
            "scenario": self.scenario.name,
            "title": self.scenario.title,
            "description": self.scenario.description,
            "duration_s": self.scenario.duration_s,
            "running": self.running,
            "finished": self.finished,
            "speed": self.speed,
            "autopilot_period_ms": sim.params.autopilot.period_ms,
            "wind_spec": {"speed_ms": sim.wind.spec.speed_ms, "from_deg": sim.wind.spec.from_deg,
                          "gust_ms": sim.wind.spec.gust_ms},
            "origin": [sim.origin.lat, sim.origin.lon],
            "route": [list(w) for w in sim.autopilot.plan.waypoints] if sim.autopilot else [],
            "state": sim.live_state(finished=self.finished),
            "timeline": self.timeline,
            "checks": self._checks.results(),
        }
        with self._lock:
            self._published = json.dumps(snapshot, separators=(",", ":"))
            self.version += 1

    def snapshot(self):
        """(version, JSON) of the latest published snapshot."""
        with self._lock:
            return self.version, self._published

    def history(self):
        """The track so far, for a page that connects mid-run."""
        return {"run": self.run_id, "track": list(self.track)}


class _Links:
    """Hands the simulation's controller lines to several listeners."""

    def __init__(self, links):
        self.links = links

    def send_status(self, sail, rudder):
        for link in self.links:
            link.send_status(sail, rudder)

    def send_telemetry(self, line):
        for link in self.links:
            link.send_telemetry(line)

    def commands(self):
        return [c for link in self.links for c in link.commands()]


class _Checks:
    """Live checks on the running simulation: how the firmware is behaving
    right now, the same properties the scenario tests assert."""

    ENCODER_GRACE_S = 2.0

    def __init__(self, sim):
        self.sim = sim
        self.failsafe_seen = self.failsafe_broken = False
        self.stuck_motor_s = 0.0
        self.stuck_stopped = False

    def update(self):
        sim, out = self.sim, self.sim.output
        silent = not out.xbee_valid and not out.rpi_valid
        heard = any(age is not None for age in sim.firmware.link_ages_ms(sim.now_ms))
        if silent and heard:
            self.failsafe_seen = True
            centre = round(sim.params.rudder_servo.centre_us)
            if out.sail_ch1 or out.sail_ch2 or out.rudder_pulse_us != centre:
                self.failsafe_broken = True
        if sim.encoder.stuck:
            motor_on = bool(out.sail_ch1 or out.sail_ch2)
            self.stuck_motor_s = self.stuck_motor_s + CONTROL_PERIOD_MS / 1000 if motor_on else 0.0
            self.stuck_stopped = self.stuck_stopped or not motor_on

    def results(self):
        sim = self.sim
        checks = []
        out_of_range = sim.rudder.out_of_range_pulses
        checks.append({
            "id": "rudder-range", "title": "Rudder pulse stays within the servo's 1000–2000 µs",
            "status": "fail" if out_of_range else "pass",
            "detail": f"{out_of_range} pulses outside, lowest {sim.rudder.min_pulse_us} µs" if out_of_range
                      else "Every pulse so far is inside"})
        checks.append({
            "id": "failsafe", "title": "No fresh link: sail motor off and rudder centred",
            "status": "fail" if self.failsafe_broken else "pass" if self.failsafe_seen else "wait",
            "detail": "Seen and held" if self.failsafe_seen and not self.failsafe_broken
                      else "The motor or rudder moved with no fresh link" if self.failsafe_broken
                      else "Waiting for both links to time out"})
        if self.stuck_motor_s > self.ENCODER_GRACE_S:
            encoder = ("fail", f"The motor has run {self.stuck_motor_s:.1f} s with no encoder updates")
        elif sim.encoder.stuck:
            encoder = ("pass", "Motor stopped") if self.stuck_stopped else ("wait", "Encoder stopped; watching the motor")
        else:
            encoder = ("wait", "Turn on the encoder fault to test")
        checks.append({"id": "encoder", "title": "Sail motor stops when its encoder stops updating",
                       "status": encoder[0], "detail": encoder[1]})
        if sim.lake:
            draft = sim.params.hull.draft_m
            checks.append({
                "id": "depth", "title": f"Stays in water deeper than the {draft:.1f} m draft",
                "status": "fail" if sim.grounded_at_s is not None else "pass",
                "detail": f"Aground at {sim.grounded_at_s:.0f} s" if sim.grounded_at_s is not None
                          else "Never shallower so far"})
        if sim.autopilot and sim.autopilot.plan.waypoints:
            reached, total = len(sim.autopilot.reached), len(sim.autopilot.plan.waypoints)
            checks.append({"id": "course", "title": "Reaches every waypoint",
                           "status": "pass" if reached >= total else "wait",
                           "detail": f"{reached} of {total} reached"})
        return checks
