"""The team's own navigation (DAL_MAST, the Raspberry Pi's ROS code) as the
simulator's autopilot, in place of the stand-in in autopilot.py.

It loads three ROS-free modules from a DAL_MAST checkout and wires them the
way its ROS nodes do:

    waypointControl   a waypoint counts as reached inside the gate
    navigation        nav_core.guide(): the heading to steer
    controls          control_law: rudder from the heading error, the wing's angle
    PCBComm           pcb_protocol.format_targets(): the TargetsOutput line

so the STM32 firmware in the loop receives exactly the packets the Pi would
send, built by the Pi's own code. The ROS plumbing itself (topics, timers,
the serial port) is not run.

The checkout is found at $WINDBOUND_DALMAST_DIR, or next to this repository
as DAL_MAST/. Its src/py_tut/py_tut needs nav_core.py, control_law.py and
pcb_protocol.py: the nav/corridor-v2, fix/controls and fix/pcb-link work.

Frames: the simulator's compass heading is clockwise from north; the MTi,
and so DAL_MAST, use ENU (counter-clockwise from east). The windvane angle
(clockwise from the bow) is the same on both sides.
"""

import importlib.util
import math
import os
from pathlib import Path

from .firmware import REPO_ROOT

MODULES = ("nav_core", "control_law", "pcb_protocol")
GATE_WIDTH_M = 40.0             # waypointControl's default on fix/waypoint-control
RUDDER_KP, RUDDER_KD, MAX_RUDDER_DEG = 0.8, 0.4, 30.0   # controls.py's defaults
WIND_TAU_S = 6.0                # navigation.py's windvane smoothing
RATE_TAU_S = 0.3


def find_package():
    """The py_tut package folder in a DAL_MAST checkout, or None."""
    roots = [Path(os.environ["WINDBOUND_DALMAST_DIR"])] if "WINDBOUND_DALMAST_DIR" in os.environ else []
    roots.append(REPO_ROOT.parent / "DAL_MAST")
    for root in roots:
        for package in (root / "src" / "py_tut" / "py_tut", root):
            if all((package / f"{name}.py").is_file() for name in MODULES):
                return package
    return None


def load_modules(package=None):
    package = package or find_package()
    if package is None:
        raise FileNotFoundError(
            "DAL_MAST's navigation wasn't found. Point WINDBOUND_DALMAST_DIR at a DAL_MAST checkout "
            "whose src/py_tut/py_tut has nav_core.py, control_law.py and pcb_protocol.py "
            "(the nav/corridor-v2, fix/controls and fix/pcb-link branches).")
    modules = []
    for name in MODULES:
        spec = importlib.util.spec_from_file_location(f"dalmast_{name}", package / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        modules.append(module)
    return package, modules


class DalmastAutopilot:
    """Same interface as autopilot.AutopilotStandIn: update() returns the
    TargetsOutput packet for this period; plan, waypoint_index and reached
    report progress."""

    name = "DAL_MAST navigation"

    def __init__(self, plan, origin, modules):
        self.plan, self.origin = plan, origin
        self.nav, self.law, self.pcb = modules
        self.config = self.nav.NavConfig()
        self.state = self.nav.NavState()
        self.wind = self.nav.AngleFilter(WIND_TAU_S)
        self.waypoint_index = 0
        self.reached = []
        self.start = None            # where the boat was when it began: the first leg's start
        self.side = 1
        self.rate = 0.0
        self.last = None             # (time, ENU heading)
        self.mode = "starting"

    @property
    def finished(self):
        return self.waypoint_index >= len(self.plan.waypoints)

    def update(self, now_s, fix, wind_angle):
        lat, lon, compass = fix
        heading = (90.0 - compass) % 360.0                  # compass to ENU, as the MTi reports it
        if self.start is None:
            self.start = (lat, lon)
        wind_from = self.wind.update(self.nav.wind_from_world(heading, wind_angle), now_s)
        if self.last is not None and now_s > self.last[0]:
            dt = now_s - self.last[0]
            measured = ((heading - self.last[1] + 180.0) % 360.0 - 180.0) / dt
            self.rate += (measured - self.rate) * (1.0 - math.exp(-dt / RATE_TAU_S))
        self.last = (now_s, heading)

        # waypointControl: reached inside the gate, then on to the next mark.
        waypoints = self.plan.waypoints
        if not self.finished:
            b = waypoints[self.waypoint_index]
            if math.hypot(*self.nav.to_local(lat, lon, *b)) < GATE_WIDTH_M / 2:
                self.reached.append((self.waypoint_index, now_s))
                self.waypoint_index += 1

        target_lat, target_lon = waypoints[-1]
        if self.finished:
            # The race is complete: following stops, the rudder centres, the wing feathers.
            target, rudder, sail = heading, 0.0, wind_angle % 360.0
            self.mode = "finished"
        else:
            target_lat, target_lon = waypoints[self.waypoint_index]
            a = waypoints[self.waypoint_index - 1] if self.waypoint_index else self.start
            to_xy = lambda p: self.nav.to_local(p[0], p[1], a[0], a[1])
            guidance = self.nav.guide(self.config, self.state, now_s, to_xy((lat, lon)), heading,
                                      wind_from, (0.0, 0.0), to_xy((target_lat, target_lon)),
                                      vane_cw=wind_angle)
            target = guidance.heading
            tack = "starboard" if guidance.tack > 0 else "port"
            self.mode = ("reaching" if guidance.mode == "reaching"
                         else f"tacking onto {tack}" if self.state.tacking_since is not None
                         else f"beating, {tack} tack")
            rudder = self.law.rudder_command(heading, target, self.rate, RUDDER_KP, RUDDER_KD, MAX_RUDDER_DEG)
            sail, self.side = self.law.sail_target(wind_angle, heading, target, self.side)

        packet = self.pcb.format_targets({
            "targetBearing": target, "waypointLat": target_lat, "waypointLon": target_lon,
            "targetSailAngle": sail, "targetFlapAngle": 0.0, "targetRudderAngle": rudder,
            "latitude": lat, "longitude": lon, "headingAngle": heading, "windAngle": wind_angle,
        })
        return packet.strip()


def factory(package=None):
    """make(plan, origin) for Simulation: DAL_MAST for a route; the stand-in
    for scenarios that hold a heading or replay fixed targets."""
    from .autopilot import AutopilotStandIn

    _, modules = load_modules(package)

    def make(plan, origin):
        if plan.waypoints:
            return DalmastAutopilot(plan, origin, modules)
        return AutopilotStandIn(plan, origin)

    make.name = DalmastAutopilot.name
    return make
